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
 * Not part of `bun test`: the watchdog polls on a multi-second interval.
 */
import { spawn } from "node:child_process"

import { createReporter, startSidecar, waitForExit, waitForLine } from "./harness/sidecar"

/** The watchdog polls every 3s; allow a few cycles before calling it dead. */
const WATCHDOG_GRACE_MS = 15_000
const SIGTERM_GRACE_MS = 10_000

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
  report.check(
    "sigterm",
    exit !== null,
    exit ?
      `exited code=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`
    : `still running after ${SIGTERM_GRACE_MS}ms — a host quit would hang`,
  )
}

// ── The supervisor dies without cleaning up ────────────────────────────────
// The path that actually leaks: a host crash, a SIGKILL, a force-quit. Nothing
// gets to send SIGTERM, so the sidecar has to notice on its own.
{
  const decoy = spawn("sleep", ["120"], { stdio: "ignore" })
  const decoyPid = decoy.pid
  if (decoyPid === undefined) throw new Error("decoy parent failed to spawn")

  const sidecar = await startSidecar({ parentPid: decoyPid })

  // SIGKILL, not SIGTERM: model a host that dies with no chance to clean up.
  decoy.kill("SIGKILL")

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
    (line) => line.includes(`parent ${decoyPid}`) && line.includes("gone"),
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
