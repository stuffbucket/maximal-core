/**
 * The e2e harness's boot diagnostic (`scripts/dev/harness/sidecar.ts`).
 *
 * This exists because a harness that fails on CI has exactly one artifact: the
 * log. `startSidecar` used to attach its stderr drain only *after* the
 * ready-line arrived, so a sidecar that died during boot produced a bare
 * `Sidecar stdout closed before it emitted a ready-line` — with the reason,
 * which the engine logs to stderr, discarded unread. That cost a real diagnosis
 * on the Windows leg of `e2e:replace` and could only be recovered by re-running.
 *
 * Spawning a stand-in engine rather than the real one keeps this in `bun test`:
 * the subject is the harness's failure reporting, not the engine, and a boot
 * that fails on purpose is instant.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startSidecar } from "../scripts/dev/harness/sidecar"

/** A string no other part of the run could produce, so finding it in the thrown
 *  message is unambiguous. */
const SENTINEL = "seeded-stderr-sentinel: could not bind, giving up"

const previousBinary = process.env.MAXIMAL_E2E_BINARY

afterEach(() => {
  if (previousBinary === undefined) delete process.env.MAXIMAL_E2E_BINARY
  else process.env.MAXIMAL_E2E_BINARY = previousBinary
})

/**
 * Write an executable stand-in for the engine and point the harness at it.
 *
 * `MAXIMAL_E2E_BINARY` is the harness's own seam for running against a compiled
 * artifact, so this needs no test-only hook. The shebang names the running
 * interpreter outright rather than going through `env`, so the child does not
 * depend on what is on PATH.
 */
function fakeEngine(body: string): void {
  const path = join(
    mkdtempSync(join(tmpdir(), "maximal-fake-engine-")),
    "engine",
  )
  writeFileSync(path, `#!${process.execPath}\n${body}\n`)
  chmodSync(path, 0o755)
  process.env.MAXIMAL_E2E_BINARY = path
}

describe("startSidecar — a boot that fails is diagnosable from the log alone", () => {
  it("names what the child wrote to stderr when it dies before the ready-line", async () => {
    fakeEngine(`
      const { writeSync } = require("node:fs")
      writeSync(2, ${JSON.stringify(`${SENTINEL}\n`)})
      writeSync(1, "boot line on stdout\\n")
      process.exit(3)
    `)

    const failure = await startSidecar({ readyTimeoutMs: 5000 }).then(
      () => null,
      (error: unknown) => error as Error,
    )

    expect(failure?.name).toBe("SidecarExitedError")
    expect(failure?.message).toInclude(SENTINEL)
  })

  it("names what the child wrote to stderr when it never becomes ready", async () => {
    fakeEngine(`
      const { writeSync } = require("node:fs")
      writeSync(2, ${JSON.stringify(`${SENTINEL}\n`)})
      setInterval(() => {}, 1000)
    `)

    const failure = await startSidecar({ readyTimeoutMs: 750 }).then(
      () => null,
      (error: unknown) => error as Error,
    )

    expect(failure?.name).toBe("SidecarReadyTimeoutError")
    expect(failure?.message).toInclude(SENTINEL)
  })
})
