/**
 * Harness: sidecar process lifecycle, against a real spawned sidecar.
 *
 * **A harness, not a test head and not a product surface.** Run it with
 * `bun run e2e:lifecycle`.
 *
 * Why this exists: a supervised engine must not outlive its supervisor. If the
 * parent-death watchdog does not fire, every host crash leaks an engine that
 * still holds a port and still refreshes tokens — the failure a user only
 * notices as "why is my machine warm", and one no unit test can observe because
 * the whole mechanism is a real process watching another real process die.
 *
 * The watched parent is a **decoy**: the sidecar is spawned as a child of this
 * harness (so its pipes stay readable and cleanup is guaranteed) but told to
 * watch a throwaway process instead. The watchdog only ever probes with
 * `kill(pid, 0)`, so it cannot tell the difference — and this way the harness
 * can kill the watched parent without killing itself.
 *
 * ## Portability
 *
 * This harness used to be the one POSIX-only piece of the suite, because the
 * decoy was `sleep 120`. That single word is why the Windows leg of
 * `release-artifacts.yml` shipped v0.3.2 with `verify:artifact` and nothing
 * else. The decoy is now Bun itself (see `startDecoyParent`), so the whole
 * suite runs on both platforms.
 *
 * One thing still does not port, and is not pretended away below: **Windows has
 * no SIGTERM.** `child.kill("SIGTERM")` there is `TerminateProcess`, so the
 * first block proves the binary is *terminable*, not that it drained. The
 * watchdog block is unaffected — it exits through userspace `process.exit(0)`
 * — and it is the block this harness exists for.
 *
 * Not part of `bun test`: the watchdog polls on a multi-second interval.
 */
import type { ChildProcess } from "node:child_process"

import { spawn } from "node:child_process"

import { createReporter, startSidecar, waitForExit, waitForLine } from "./harness/sidecar"

/** The watchdog polls every 3s; allow a few cycles before calling it dead. */
const WATCHDOG_GRACE_MS = 15_000
const SIGTERM_GRACE_MS = 10_000
const DECOY_START_MS = 10_000
const DECOY_EXIT_MS = 5000
/** Longer than any run of this harness. The decoy is always killed explicitly;
 *  the timer only bounds a leak if this process dies mid-run. */
const DECOY_IDLE_MS = 600_000
const DECOY_READY = "decoy-parent-ready"

const onWindows = process.platform === "win32"

interface Decoy {
  pid: number
  /** Kill it and resolve once the OS reports it exited. */
  kill: () => Promise<void>
}

/**
 * A throwaway process for the sidecar's watchdog to watch and this harness to
 * kill.
 *
 * It has to satisfy three things at once: exist on every runner, stay alive and
 * idle for the length of the run, and be killable. `sleep 120` satisfies all
 * three on POSIX and none on Windows — `sleep` is not a Windows command, and
 * the near-equivalents are worse: `timeout /t` refuses to run when stdin is not
 * a console (`ERROR: Input redirection is not supported`), which is exactly how
 * a harness spawns things, and `ping -n` is a busy-wait dressed as a sleep.
 *
 * So use the runtime instead of the shell. `process.execPath` is the Bun
 * already interpreting this file, which makes it present by construction on any
 * machine that can run the harness at all — no PATH lookup, no `.exe`
 * extension, no shell, and one process rather than a wrapper around one.
 *
 * It announces itself on stdout before going idle, and we wait for that line.
 * A decoy that failed to start would otherwise hand back a pid that is already
 * dead, and the watchdog check below would go green for the wrong reason.
 */
async function startDecoyParent(): Promise<Decoy> {
  const source =
    `console.log(${JSON.stringify(DECOY_READY)});`
    + `setTimeout(() => {}, ${DECOY_IDLE_MS})`
  const child: ChildProcess = spawn(process.execPath, ["--eval", source], {
    stdio: ["ignore", "pipe", "ignore"],
  })
  const pid = child.pid
  if (pid === undefined) throw new Error("decoy parent failed to spawn")

  const announced = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), DECOY_START_MS)
    const settle = (ok: boolean): void => {
      clearTimeout(timer)
      resolve(ok)
    }
    let seen = ""
    child.stdout?.on("data", (chunk: Buffer | string) => {
      seen += String(chunk)
      if (seen.includes(DECOY_READY)) settle(true)
    })
    child.once("exit", () => settle(false))
  })
  if (!announced) {
    child.kill("SIGKILL")
    throw new Error("decoy parent never announced itself — cannot run the watchdog check")
  }

  return {
    pid,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, DECOY_EXIT_MS)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
        // SIGKILL on POSIX; TerminateProcess on Windows, where every kill() is.
        // Either way the parent gets no chance to clean up, which is the point.
        child.kill("SIGKILL")
      }),
  }
}

/** The watchdog's own probe: signal 0 delivers nothing and throws when the pid
 *  is gone. It reads as a POSIX-ism but is not one — Windows implements it as a
 *  real liveness query (`GetExitCodeProcess` != `STILL_ACTIVE`). Asserted
 *  below rather than assumed, so that a platform where it silently reported a
 *  dead process as alive fails here and not as an unexplained timeout. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const report = createReporter(
  "e2e:lifecycle — a supervised engine must not outlive its supervisor",
)

// ── An orderly SIGTERM ─────────────────────────────────────────────────────
// The common path: the host quits and stops the sidecar itself.
{
  const sidecar = await startSidecar()
  report.check(
    "started",
    sidecar.port > 0,
    `port=${sidecar.port} pid=${sidecar.pid}`,
  )

  sidecar.child.kill("SIGTERM")
  const exit = await waitForExit(sidecar.child, SIGTERM_GRACE_MS)
  // On Windows `kill("SIGTERM")` is TerminateProcess — the signal is never
  // delivered and no handler runs — so this degrades to "the process is
  // terminable". Say so in the line rather than let a green CI log imply the
  // drain path was exercised. There is no portable way to ask a child to stop
  // gracefully from Node or Bun on Windows; SIGBREAK is `ENOSYS` in libuv's
  // `uv_kill`, and a console control event needs a shared console the harness
  // deliberately does not give the child.
  const graceful = exit ? ` (${onWindows ? "TerminateProcess — terminable, not drained" : "handler ran, drained"})` : ""
  report.check(
    "sigterm",
    exit !== null,
    exit ?
      `exited code=${exit.code ?? "null"} signal=${exit.signal ?? "none"}${graceful}`
    : `still running after ${SIGTERM_GRACE_MS}ms — a host quit would hang`,
  )
}

// ── The supervisor dies without cleaning up ────────────────────────────────
// The path that actually leaks: a host crash, a SIGKILL, a force-quit. Nothing
// gets to send SIGTERM, so the sidecar has to notice on its own.
{
  const decoy = await startDecoyParent()
  const decoyAlive = isAlive(decoy.pid)
  report.check(
    "decoy",
    decoyAlive,
    decoyAlive ?
      `pid=${decoy.pid} idle, and visible to the kill(pid, 0) probe the watchdog uses`
    : `pid=${decoy.pid} is already invisible to kill(pid, 0) — the watchdog would fire before the parent ever died`,
  )

  const sidecar = await startSidecar({ parentPid: decoy.pid })

  // Kill it outright: model a host that dies with no chance to clean up.
  await decoy.kill()

  // Assert the probe can actually observe the death before waiting on the
  // watchdog. Without this, a platform whose `kill(pid, 0)` kept reporting a
  // terminated process as alive would fail below as a mute 15-second timeout
  // indistinguishable from a broken watchdog.
  const stillVisible = isAlive(decoy.pid)
  report.check(
    "decoy gone",
    !stillVisible,
    stillVisible ?
      "STILL VISIBLE to kill(pid, 0) after exit — the liveness probe cannot see death here, so the watchdog cannot either"
    : "the probe reports it dead, so the watchdog has something to notice",
  )

  const exit = await waitForExit(sidecar.child, WATCHDOG_GRACE_MS)
  report.check(
    "watchdog",
    exit !== null,
    exit ?
      `sidecar exited on its own within ${WATCHDOG_GRACE_MS}ms of the parent dying`
    : `SURVIVED its parent — this is the orphaned-engine leak`,
  )

  // Attribution, and the check that carries the weight. Exiting is not enough:
  // a sidecar that crashed for an unrelated reason would satisfy the check
  // above while the leak stayed real. This names the pid it noticed.
  //
  // Deliberately matched against a `warn`: the watchdog also logs an `info` when
  // it arms, but `consola` filters info below level 5 (`--verbose`), so keying
  // on that line would make the harness pass or fail on a logging flag.
  const because = await waitForLine(
    sidecar.logLines,
    (line) => line.includes(`parent ${decoy.pid}`) && line.includes("gone"),
    2000,
  )
  report.check(
    "attributed",
    because !== null,
    because?.trim() ?? "exited, but not because it noticed the parent",
  )

  if (exit === null) sidecar.child.kill("SIGKILL")
}

report.finish()
