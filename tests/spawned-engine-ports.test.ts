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
  .map((file) => {
    const source = fs.readFileSync(file, "utf8")
    return {
      rel: path.relative(TESTS_DIR, file).replaceAll(path.sep, "/"),
      // Collapsed so a multi-line `cmd:` array reads the same as a single-line one.
      text: source.replaceAll(/\s+/gu, " "),
      /** Uncollapsed, for the guards that need to strip comments first. */
      source,
    }
  })
  .filter(({ rel }) => rel !== SELF)

const PORT_SOURCE = "helpers/free-port"
/** The two ways a test process opens a real listener. */
const BIND_SITES = [
  /\.listen\(\s*([^,)]+)/gu,
  /Bun\.serve\(\{\s*port:\s*([^,}]+)/gu,
]

/**
 * Comments out, then collapse.
 *
 * Prose about this rule quotes the very calls it forbids — this file does, and
 * so does `helpers/free-port.ts` — and once whitespace is collapsed a `*`
 * continuation lands mid-expression, so a doc comment reads as a bind site.
 * Block comments and whole-line `//` cover every such case here; a trailing
 * `//` is left alone because stripping it would truncate any line holding a
 * `http://` URL.
 */
const stripComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/^[^\S\n]*\/\/[^\n]*$/gmu, " ")
    .replaceAll(/\s+/gu, " ")

/** Every real bind in `source` whose port is neither a literal 0 nor sourced
 *  from the shared helper. */
function guessedBinds(rel: string, source: string): Array<string> {
  const code = stripComments(source)
  const fromHelper = code.includes(PORT_SOURCE)
  const offenders: Array<string> = []
  for (const pattern of BIND_SITES) {
    for (const match of code.matchAll(pattern)) {
      const arg = match[1].trim()
      if (arg === "0") continue
      if (fromHelper && !/^\d/u.test(arg)) continue
      offenders.push(`${rel}: ${match[0].trim()}`)
    }
  }
  return offenders
}

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

describe("in-process tests bind ephemeral ports too", () => {
  // The spawn guards above cover the `--port` flag. The same class arrives
  // through the other door: a test that binds a socket *in* the test process
  // and names the port itself. `tests/start-port-policy.test.ts` did exactly
  // that with 45_871 / 45_872 — it stood up a squatter and then asserted the
  // port was bindable again after closing, so any other holder on the runner
  // failed it, with nothing in the failure pointing at the port as the cause.
  //
  // Note what the offending line actually looked like:
  //
  //     const port = 45_872
  //     squatter.listen(port, "127.0.0.1", resolve)
  //
  // The literal is in the *binding*, not at the call, so matching numeric
  // arguments to `.listen(` would have missed it. Tracing the value needs data
  // flow, which a text scan does not have. So this inverts the question: a real
  // bind site must either ask for 0 outright, or live in a file that gets its
  // ports from `helpers/free-port.ts`. Both are unforgeable by a literal; a
  // file doing neither is guessing, whatever the guess is spelled like.
  //
  // A literal is only a defect when the socket is *real*. `resolvePort` tests
  // pass 4141 to a fake probe and bind nothing, which is fine and must stay
  // fine — so this matches the two calls that actually reach the network stack,
  // never a number that merely looks like a port.

  it("recognises a guessed bind (guards the matcher itself)", () => {
    // The exact shape that shipped.
    const bad =
      'const port = 45_872\nawait new Promise(r => s.listen(port, "127.0.0.1", r))'
    expect(guessedBinds("sample.ts", bad)).toHaveLength(1)
    expect(guessedBinds("sample.ts", "s.listen(0, host, r)")).toEqual([])
    expect(
      guessedBinds("sample.ts", "Bun.serve({ port: 4141, fetch })"),
    ).toHaveLength(1)
    expect(guessedBinds("sample.ts", "Bun.serve({ port: 0, fetch })")).toEqual(
      [],
    )
    // A file that sources ports from the helper may bind a variable.
    const good =
      'import { holdPort } from "./helpers/free-port"\ns.listen(p, host, r)'
    expect(guessedBinds("sample.ts", good)).toEqual([])
    // ...but a bare literal is a defect even there.
    expect(
      guessedBinds("sample.ts", `${good}\ns.listen(45871, host, r)`),
    ).toHaveLength(1)
    // Prose quoting a forbidden call is not a call.
    expect(
      guessedBinds("sample.ts", "/**\n * s.listen(45871, host)\n */"),
    ).toEqual([])
  })

  it("binds no port this process did not get from the OS", () => {
    const offenders = files.flatMap(({ rel, source }) =>
      guessedBinds(rel, source),
    )
    expect(offenders).toEqual([])
  })
})
