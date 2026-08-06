/**
 * The e2e harness's boot diagnostic (`scripts/dev/harness/sidecar.ts`).
 *
 * This exists because a harness that fails on CI has exactly one artifact: the
 * log. `superviseSidecar` used to attach its stderr drain only *after* the
 * ready-line arrived, so a sidecar that died during boot produced a bare
 * `Sidecar stdout closed before it emitted a ready-line` — with the reason,
 * which the engine logs to stderr, discarded unread. That cost a real diagnosis
 * on the Windows leg of `e2e:replace` and could only be recovered by re-running.
 *
 * Supervising a stand-in rather than the real engine keeps this in `bun test`:
 * the subject is the harness's failure reporting, not the engine, and a boot
 * that fails on purpose is instant. The stand-in is spawned by naming the
 * running interpreter and handing it a script — the one launch shape that is
 * the same on Windows as on POSIX, since `bun test` runs on both.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SidecarChild } from "../scripts/dev/harness/sidecar"

import { superviseSidecar, waitForExit } from "../scripts/dev/harness/sidecar"

/** A string no other part of the run could produce, so finding it in the thrown
 *  message is unambiguous. */
const SENTINEL = "seeded-stderr-sentinel: could not bind, giving up"

const scratch: Array<string> = []
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Spawn a stand-in for the engine with the same stdio shape `spawnEngine` uses. */
function standIn(body: string): SidecarChild {
  const dir = mkdtempSync(join(tmpdir(), "maximal-stand-in-"))
  scratch.push(dir)
  const script = join(dir, "engine.mjs")
  writeFileSync(script, body)
  return spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
  })
}

const writesSentinel = `import { writeSync } from "node:fs"\nwriteSync(2, ${JSON.stringify(`${SENTINEL}\n`)})\n`

describe("superviseSidecar — a boot that fails is diagnosable from the log alone", () => {
  it("names what the child wrote to stderr when it dies before the ready-line", async () => {
    const child = standIn(
      `${writesSentinel}writeSync(1, "boot line on stdout\\n")\nprocess.exit(3)\n`,
    )

    const failure = await superviseSidecar(child, 5000).then(
      () => null,
      (error: unknown) => error as Error,
    )

    expect(failure?.name).toBe("SidecarExitedError")
    expect(failure?.message).toInclude(SENTINEL)
    // Tagged, so the transcript cannot read as if the engine printed its own
    // crash to stdout.
    expect(failure?.message).toInclude("stderr")
    expect(failure?.message).toInclude("boot line on stdout")
  })

  it("names what the child wrote to stderr when it never becomes ready", async () => {
    const child = standIn(`${writesSentinel}setInterval(() => {}, 1000)\n`)

    const failure = await superviseSidecar(child, 750).then(
      () => null,
      (error: unknown) => error as Error,
    )

    expect(failure?.name).toBe("SidecarReadyTimeoutError")
    expect(failure?.message).toInclude(SENTINEL)
    // And the child does not outlive the boot it failed: a leaked engine holds
    // a port, and nothing can reap a process whose `startSidecar` threw.
    expect(await waitForExit(child, 5000)).not.toBeNull()
  })
})
