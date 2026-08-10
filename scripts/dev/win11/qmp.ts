/**
 * QMP client — QEMU's own control socket, as opposed to the guest agent.
 *
 * Used for the one thing the guest cannot do for itself: press a key before any
 * OS is running.
 */
import { connect } from "node:net"

async function withSocket<T>(sockPath: string, fn: (send: (o: object) => Promise<void>) => Promise<T>): Promise<T> {
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

  let buf = ""
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    // Responses are read only to keep the stream drained; the caller does not
    // inspect them beyond the send() error path.
    if (buf.length > 65_536) buf = buf.slice(-1024)
  })
  const send = async (o: object): Promise<void> => {
    sock.write(`${JSON.stringify(o)}\n`)
    await new Promise((r) => setTimeout(r, 30))
  }
  try {
    await send({ execute: "qmp_capabilities" })
    return await fn(send)
  } finally {
    sock.destroy()
  }
}

/**
 * Hold Enter down through the firmware phase of an install.
 *
 * WHY THIS EXISTS, AND WHY IT IS SHAPED LIKE THIS.
 *
 * Windows install media boots `cdboot.efi`, which prints "Press any key to boot
 * from CD or DVD" and returns EFI_TIMEOUT if nothing does. Unanswered, EDK2
 * then walks every remaining boot option — other USB devices, the disk, PXE
 * v4/v6, HTTP v4/v6, each with its own timeout — and lands in a UEFI shell
 * having installed nothing.
 *
 * `sendkey` is an **HMP** command, not a QMP one. Issuing it as
 * `{"execute":"sendkey"}` returns `CommandNotFound` — and if the caller ignores
 * the response, as an earlier version of this code did, the failure is
 * completely silent: hundreds of keystrokes are "sent", none arrive, and the
 * symptom looks exactly like a storage or firmware fault. That misdiagnosis
 * cost hours. It must be wrapped in `human-monitor-command`, and the result
 * must be checked.
 */
export async function pressEnterUntil(sockPath: string, deadlineMs: number, shouldStop: () => boolean): Promise<void> {
  await withSocket(sockPath, async (send) => {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline && !shouldStop()) {
      await send({ execute: "human-monitor-command", arguments: { "command-line": "sendkey ret" } })
      await new Promise((r) => setTimeout(r, 400))
    }
  })
}
