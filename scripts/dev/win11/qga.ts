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
 * Poll until Windows has FINISHED STARTING — a state of the OS, not a sign of
 * life from the channel.
 *
 * THE DISTINCTION IS THE WHOLE POINT, AND GETTING IT WRONG COSTS INSTANCES.
 * qemu-ga runs as SYSTEM and answers long before any logon, so `guest-ping`
 * succeeds throughout OOBE — and so does `guest-exec`, and so does anything else
 * that merely asks whether the agent is alive. A guest sitting on "Just a
 * moment, checking for updates" satisfies every one of those probes while being
 * nowhere near settled. Two earlier versions of this function gated on exactly
 * that and were meaningless: `start` reported the guest up, `smoke` returned
 * correct answers, and the machine was still in OOBE the entire time.
 *
 * WHAT IS ASKED INSTEAD: has the REAL account logged on?
 *
 * Windows runs the out-of-box experience under a temporary account called
 * `defaultuser0`, and it runs a full session as it — Explorer included. While
 * that session is on screen showing "Checking for updates", the guest already
 * reports `OOBEInProgress = 0` AND `SystemSetupInProgress = 0` AND a running
 * `explorer.exe`. Every one of those was tried here and every one was true too
 * early. `Win32_ComputerSystem.UserName` is not: it reads `<HOST>\defaultuser0`
 * throughout OOBE and only becomes the answer file's account once AutoLogon has
 * actually taken the machine to its desktop. That is the end of the lifecycle,
 * and it is unambiguous.
 *
 * It matters beyond tidiness: freezing a guest mid-OOBE and restoring it
 * LIVELOCKS the machine — every vCPU at 100%, no disk I/O, recoverable only by
 * killing it. Snapshots must not be taken until this returns true.
 */
export async function waitReady(sockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  if (!(await waitFor(sockPath, timeoutMs))) return false
  while (Date.now() < deadline) {
    try {
      const r = await exec(sockPath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem).UserName",
      ])
      const user = r.stdout.trim()
      // Matched by SHAPE, not by name: this file knows nothing about which
      // account a caller's answer file creates, only that OOBE's own temporary
      // one is `defaultuser<n>`.
      if (user !== "" && !/\\defaultuser\d+$/i.test(user)) return true
    } catch {
      // The agent drops in and out across OOBE's reboots; keep asking.
    }
    await new Promise((r) => setTimeout(r, 5000))
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
