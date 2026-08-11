/**
 * QMP client — QEMU's own control socket, as opposed to the guest agent.
 *
 * Used for the one thing the guest cannot do for itself: press a key before any
 * OS is running.
 */
import { connect } from "node:net"

/**
 * Run one HMP command and return what it said.
 *
 * READING THE REPLY IS THE ENTIRE POINT. HMP commands wrapped in
 * `human-monitor-command` report failure as ordinary TEXT inside a SUCCESSFUL
 * QMP response — `{"return": "Error: Device 'pflash1' is writable but does not
 * support snapshots\r\n"}`. A caller that only checks for a QMP-level error sees
 * every one of those as success, which is how a snapshot that never happened
 * gets reported as taken, and a rewind that reverted nothing looks fine.
 */
export async function hmp(sockPath: string, command: string, timeoutMs = 180_000): Promise<string> {
  return await withSocket(sockPath, async (send, request) => {
    const reply = await request({ execute: "human-monitor-command", arguments: { "command-line": command } }, timeoutMs)
    const error = reply["error"]
    if (error !== undefined) throw new Error(`qmp rejected "${command}": ${JSON.stringify(error)}`)
    const text = typeof reply["return"] === "string" ? reply["return"].trim() : ""
    // HMP prefixes its failures with "Error:"; success is usually empty output.
    if (/^Error/i.test(text)) throw new Error(`${command}: ${text.replace(/\r/g, "")}`)
    void send
    return text
  })
}

async function withSocket<T>(
  sockPath: string,
  fn: (
    send: (o: object) => Promise<void>,
    request: (o: object, timeoutMs?: number) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  // QEMU creates the socket a moment AFTER the process starts, so a connect
  // attempt racing the launch fails with ENOENT. Retry rather than give up:
  // losing this race means the boot prompt goes unanswered and the install
  // silently stalls at firmware.
  const deadline = Date.now() + 30_000
  let sock: ReturnType<typeof connect> | null = null
  for (;;) {
    try {
      const candidate = connect(sockPath)
      await new Promise<void>((res, rej) => {
        candidate.on("connect", () => res())
        candidate.on("error", rej)
      })
      sock = candidate
      break
    } catch (error) {
      if (Date.now() > deadline) throw error instanceof Error ? error : new Error(String(error))
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  // Replies are matched to requests in order. QEMU answers a QMP monitor's
  // commands sequentially, so a queue is enough; asynchronous EVENTS are
  // interleaved with them and must not be mistaken for a reply.
  const waiting: ((r: Record<string, unknown>) => void)[] = []
  let buf = ""
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    for (;;) {
      const nl = buf.indexOf("\n")
      if (nl < 0) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() === "") continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if ("event" in parsed || "QMP" in parsed) continue
      waiting.shift()?.(parsed)
    }
  })
  const request = async (o: object, timeoutMs = 20_000): Promise<Record<string, unknown>> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Record<string, unknown>>((res) => waiting.push(res))
    const expiry = new Promise<Record<string, unknown>>((res) => {
      timer = setTimeout(() => res({ error: { desc: "qmp timed out" } }), timeoutMs)
    })
    sock.write(`${JSON.stringify(o)}\n`)
    const out = await Promise.race([reply, expiry])
    clearTimeout(timer)
    return out
  }
  const send = async (o: object): Promise<void> => {
    sock.write(`${JSON.stringify(o)}\n`)
    await new Promise((r) => setTimeout(r, 30))
  }
  try {
    await request({ execute: "qmp_capabilities" })
    return await fn(send, request)
  } finally {
    sock.destroy()
  }
}

/**
 * Answer the install media's boot prompt — with a STRICTLY BOUNDED number of
 * keystrokes.
 *
 * Windows install media boots `cdboot.efi`, which prints "Press any key to boot
 * from CD or DVD" and returns EFI_TIMEOUT if nothing does. Unanswered, EDK2
 * walks every remaining boot option — other USB devices, the disk, PXE v4/v6,
 * HTTP v4/v6, each with its own timeout — and lands in a UEFI shell having
 * installed nothing.
 *
 * THE COUNT IS THE WHOLE DESIGN. This used to press Enter every 400 ms until
 * the disk grew past 300 MB — around 250 keystrokes to satisfy a prompt that
 * consumes one. Keystrokes the prompt does not take are not discarded; they
 * queue in the keyboard buffer and are handed to Windows Setup's GUI when it
 * starts pumping messages, where Enter activates the focused Cancel button and
 * opens "Are you sure you want to quit?". The install then freezes with no
 * error, at whatever percentage it happened to reach. Whether it happened at
 * all depended on how fast the disk grew, which is why it struck intermittently.
 *
 * So: the CALLER waits for the firmware to announce that the prompt is imminent
 * (see startup.nsh's `winvm-keypress-needed`), and this sends a handful of keys
 * spaced across the prompt's few-second window. Nothing here is proportional to
 * how long anything takes.
 *
 * `sendkey` is an **HMP** command, not a QMP one. Issuing it as
 * `{"execute":"sendkey"}` returns `CommandNotFound` — and a caller that ignores
 * the response sees hundreds of keystrokes "sent" and none arrive, which looks
 * exactly like a storage or firmware fault. That misdiagnosis cost hours. Every
 * key here is a checked request; there are few enough to afford it.
 */
export async function tapEnter(sockPath: string, count: number, intervalMs: number): Promise<void> {
  await withSocket(sockPath, async (send, request) => {
    void send
    for (let i = 0; i < count; i += 1) {
      const r = await request({ execute: "human-monitor-command", arguments: { "command-line": "sendkey ret" } })
      if (r["error"] !== undefined) throw new Error(`sendkey rejected: ${JSON.stringify(r["error"])}`)
      if (i < count - 1) await new Promise((res) => setTimeout(res, intervalMs))
    }
  })
}
