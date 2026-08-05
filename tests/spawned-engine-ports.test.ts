/**
 * No test may guess a port it then binds.
 *
 * `tests/start-unauthenticated.test.ts` failed once under the full suite and
 * passed in isolation. The cause was structural, not timing: it and
 * `tests/start-multi-account.test.ts` each picked a proxy port out of a
 * hard-coded window (`4143 + random(100)`, `4243 + random(100)`,
 * `4343 + random(100)`) and derived the control port as `port + 1`. Adjacent
 * windows touch — a proxy port of 4242 claims 4243 for control, which is the
 * bottom of the next window — so two files could land on the same socket in the
 * same run and never when run alone. A retry or a sleep would have hidden that;
 * ephemeral ports remove it, because the OS cannot hand the same port to two
 * listeners.
 *
 * These are guards on the pattern, not on the two files: the failure mode
 * arrives with the *next* test that hand-rolls a spawn, and by then the
 * collision is someone else's flake to diagnose.
 */
import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const TESTS_DIR = import.meta.dirname
const HELPER = "helpers/spawn-engine.ts"
/** This file names the very idioms it forbids, so it must exempt itself. */
const SELF = "spawned-engine-ports.test.ts"

function testFiles(dir: string): Array<string> {
  const found: Array<string> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...testFiles(full))
    } else if (entry.name.endsWith(".ts")) {
      found.push(full)
    }
  }
  return found
}

const files = testFiles(TESTS_DIR)
  .map((file) => ({
    rel: path.relative(TESTS_DIR, file).replaceAll(path.sep, "/"),
    // Collapsed so a multi-line `cmd:` array reads the same as a single-line one.
    text: fs.readFileSync(file, "utf8").replaceAll(/\s+/gu, " "),
  }))
  .filter(({ rel }) => rel !== SELF)

describe("spawned-engine tests use ephemeral ports", () => {
  it("finds test files to scan (guards the walker itself)", () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it("passes 0 to every --port / --control-port a test spawns with", () => {
    const offenders: Array<string> = []
    for (const { rel, text } of files) {
      for (const match of text.matchAll(/"--(?:control-)?port", ([^,\]]+)/gu)) {
        if (match[1].trim() !== '"0"') {
          offenders.push(`${rel}: ${match[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("routes every engine spawn through the shared helper", () => {
    const offenders = files
      .filter(({ rel }) => rel !== HELPER)
      .filter(
        ({ text }) => text.includes("src/main.ts") && text.includes('"start"'),
      )
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })
})
