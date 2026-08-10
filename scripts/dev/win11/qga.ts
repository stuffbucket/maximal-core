/**
 * The QEMU guest agent client — the whole reason this VM is scriptable.
 *
 * qemu-ga listens on a virtio-serial port and speaks line-delimited JSON. That
 * gives "run a command in the guest, get stdout, stderr and the exit code" with
 * no SSH, no listening TCP port, and no dependency on guest networking.
 *
 * The alternative was UTM's `utmctl exec`, which does the same thing over Apple
 * Events and therefore needs a logged-in Aqua session plus an interactive TCC
 * grant — upstream's own error text says it "does not work from SSH sessions or
 * before logging in".
 */
import { connect } from "node:net"

export interface ExecResult {
  readonly exitcode: number
  readonly stdout: string
  readonly stderr: string
}

export async function call(
  sockPath: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  return await new Promise((res, rej) => {
    const sock = connect(sockPath)
    let buf = ""
    const timer = setTimeout(() => {
      sock.destroy()
      rej(new Error("guest agent timed out"))
    }, timeoutMs)
    sock.on("connect", () => sock.write(`${JSON.stringify(payload)}\n`))
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      clearTimeout(timer)
      sock.destroy()
      try {
        res(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
      } catch (error) {
        rej(error instanceof Error ? error : new Error(String(error)))
      }
    })
    sock.on("error", (error) => {
      clearTimeout(timer)
      rej(error)
    })
  })
}

/** Poll until the agent answers. A cold boot to a responsive agent is ~25s. */
export async function waitFor(sockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await call(sockPath, { execute: "guest-ping" }, 4000)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
  return false
}

/**
 * `guest-exec` starts a process and returns immediately; the output is only
 * available once `guest-exec-status` reports it exited, so this polls. Output
 * arrives base64-encoded.
 */
export async function exec(sockPath: string, path: string, args: readonly string[]): Promise<ExecResult> {
  const started = await call(sockPath, {
    execute: "guest-exec",
    arguments: { path, arg: [...args], "capture-output": true },
  })
  const pid = (started["return"] as { pid?: number } | undefined)?.pid
  if (pid === undefined) throw new Error(`guest-exec failed: ${JSON.stringify(started)}`)

  const deadline = Date.now() + 900_000
  while (Date.now() < deadline) {
    const st = (await call(sockPath, { execute: "guest-exec-status", arguments: { pid } }))["return"] as
      | { exited?: boolean; exitcode?: number; "out-data"?: string; "err-data"?: string }
      | undefined
    if (st?.exited === true) {
      const dec = (s: string | undefined): string =>
        s === undefined ? "" : Buffer.from(s, "base64").toString("utf8")
      return { exitcode: st.exitcode ?? 0, stdout: dec(st["out-data"]), stderr: dec(st["err-data"]) }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("guest command timed out")
}

/** Ask the guest to power down. The socket drops as it goes; that is success. */
export async function shutdown(sockPath: string): Promise<void> {
  try {
    await call(sockPath, { execute: "guest-shutdown", arguments: { mode: "powerdown" } }, 5000)
  } catch {
    // Expected: the agent stops answering mid-request.
  }
}
