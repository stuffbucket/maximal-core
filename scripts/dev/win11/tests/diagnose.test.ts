/**
 * Checks `winvm diagnose` against recorded traces of guests that failed.
 *
 * THE TRACES LIVE IN traces.zip ON PURPOSE. They are frozen artifacts of BROKEN
 * configurations — serial logs from firmware that hung, transcripts from
 * provisioning that never ran — and loose in the tree they are a hazard: a
 * reader (or an agent) looking for how this harness works would find a folder
 * full of things that do not. Zipped, they are retrievable when someone is
 * actually diagnosing, and invisible otherwise. `index.md` inside the archive
 * explains the contents, and `notes/diagnostic-notes.md` is the write-up.
 *
 * THE TEST LOGIC IS DELIBERATELY THIN. Every expectation lives with its trace,
 * in that trace's `expected.json`, so this file never grows a second copy of the
 * knowledge in diagnose.ts. Adding a failure mode means adding a directory to
 * the archive, not editing this file.
 *
 *   bun run test:winvm
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { diagnose } from "../diagnose"

interface Expectation {
  /** Instance to diagnose inside this trace's `state/` directory. */
  readonly instance: string
  /** Substrings that must each appear in some finding's title. */
  readonly expect: readonly string[]
  /** Substrings that must appear in NO finding — guards against false positives. */
  readonly forbid?: readonly string[]
  /**
   * This trace is a clean control: diagnose must report NOTHING at all.
   * Declared explicitly rather than inferred from an empty `expect`, because a
   * trace can legitimately be quiet about one thing and noisy about another — a
   * stopped build scratch instance has no transcript and is a leftover, both
   * correctly reported, while still proving the firmware check stays silent.
   */
  readonly expectNone?: boolean
  /** Answer file to check, relative to the trace directory. */
  readonly answerFile?: string
}

const ARCHIVE = resolve(import.meta.dir, "traces.zip")
const workdir = mkdtempSync(resolve(tmpdir(), "winvm-traces-"))

/**
 * Standard ZIP so the archive opens anywhere; extraction prefers `unzip` and
 * falls back to bsdtar, which reads zip on macOS and on Windows 10+.
 */
function extract(): void {
  if (spawnSync("unzip", ["-o", "-q", ARCHIVE, "-d", workdir]).status === 0) return
  if (spawnSync("tar", ["-xf", ARCHIVE, "-C", workdir]).status === 0) return
  throw new Error(`could not extract ${ARCHIVE} with unzip or tar`)
}

extract()
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const tracesDir = resolve(workdir, "traces")
const traces = existsSync(tracesDir) ? readdirSync(tracesDir).filter((d) => !d.startsWith(".")).sort() : []

describe("diagnose against recorded traces", () => {
  it("the archive contains traces and its index", () => {
    expect(existsSync(resolve(workdir, "index.md"))).toBe(true)
    expect(existsSync(resolve(workdir, "notes", "diagnostic-notes.md"))).toBe(true)
    expect(traces.length).toBeGreaterThan(0)
  })

  for (const trace of traces) {
    it(trace, () => {
      const dir = resolve(tracesDir, trace)
      const spec = JSON.parse(readFileSync(resolve(dir, "expected.json"), "utf8")) as Expectation

      // Each trace carries a whole state directory, so diagnose sees exactly the
      // layout it would in the field.
      process.env["WINVM_HOME"] = resolve(dir, "state")
      const answerFile =
        spec.answerFile === undefined ? resolve(import.meta.dir, "..", "assets", "autounattend.xml") : resolve(dir, spec.answerFile)
      const titles = diagnose(spec.instance, answerFile).map((f) => f.title)

      for (const wanted of spec.expect) {
        expect(titles.join("\n")).toContain(wanted)
      }
      for (const unwanted of spec.forbid ?? []) {
        expect(titles.join("\n")).not.toContain(unwanted)
      }
      // The controls: a healthy guest must produce no findings whatsoever.
      if (spec.expectNone === true) expect(titles).toEqual([])
    })
  }
})
