import { describe, expect, test } from "bun:test"
import path from "node:path"

import { buildBundle, BUILD_COMMAND, OUT_DIR } from "./build-bundle"
import {
  type BuildRunner,
  MAIN_ARTIFACT,
  MAIN_BUNDLE,
  needsNodeModules,
  needsPinnedBun,
  realMainBuild,
  type Requirement,
} from "./check-bindings"

// Offline and deterministic: both the environment assertions and the bundler
// are injected, so nothing here runs `bun build` or writes to dist/. Nothing
// may assert on the AMBIENT environment — release-gates.yml runs `check:ops`
// with no `bun install` and on whatever Bun it has — so the pin and the
// node_modules check are expressed as injected requirements, never as a fixture
// this process happens to satisfy.

const ok: ReadonlyArray<Requirement> = []
const objects: ReadonlyArray<Requirement> = [
  () => "Bun 9.9.9 is bundling but .bun-version pins 1.2.3",
]

function recordingBuild(status = 0, output = ""): { runner: BuildRunner, calls: Array<string> } {
  const calls: Array<string> = []
  return {
    calls,
    runner: (outDir) => {
      calls.push(outDir)
      return { status, output }
    },
  }
}

describe("the pin guard", () => {
  // The whole point. `bun run build` was the last unguarded path to
  // dist/main.js: `check-bindings.ts` refused to judge it off-pin and
  // `prepack.ts` refused to publish it off-pin, but the command that WRITES it
  // ran anywhere, and `git add -f dist/main.js` then committed bytes CI cannot
  // reproduce. Three people hit that in one session.
  test("an off-pin Bun refuses, and never reaches the bundler", () => {
    const { calls, runner } = recordingBuild()
    const lines: Array<string> = []
    const code = buildBundle({ requirements: objects, build: runner, log: (l) => lines.push(l) })
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
    expect(lines.join("\n")).toContain("Bun 9.9.9 is bundling")
  })

  // It must NOT deadlock the one command that always satisfies it:
  // `container:run -- bun run build` runs this very script inside an image
  // where Bun IS the pin, so on-pin has to be an ordinary build with no
  // container awareness of any kind. A guard that tried to detect "am I in the
  // container" would recurse or misfire; this one only compares versions.
  test("an on-pin Bun builds, into the directory the committed bundle lives in", () => {
    const { calls, runner } = recordingBuild()
    expect(buildBundle({ requirements: ok, build: runner })).toBe(0)
    expect(calls).toEqual([OUT_DIR])
    expect(OUT_DIR).toBe(path.posix.dirname(MAIN_BUNDLE))
  })

  test("a bundler failure is the exit code, not swallowed by the guard", () => {
    const { runner } = recordingBuild(2, "error: could not resolve")
    const lines: Array<string> = []
    expect(buildBundle({ requirements: ok, build: runner, log: (l) => lines.push(l) })).toBe(2)
    expect(lines.join("\n")).toContain("could not resolve")
  })
})

describe("parity", () => {
  // `bun run build` and `bindings:check`'s rebuild must be the same bundler
  // invocation by construction rather than by two copies of an argv. Sharing
  // `realMainBuild` is what makes that true — and it is also what spawns
  // `process.execPath` instead of a bare `bun` re-resolved from PATH, the trap
  // docs/bun-version-policy.md measured.
  test("the artifact the gate rebuilds and the build this script runs are one function", () => {
    expect(MAIN_ARTIFACT.build).toBe(realMainBuild)
  })

  // The build must refuse in EXACTLY the cases the gate refuses to judge, or
  // there is a window where `bun run build` writes bytes `bindings:check` then
  // declines to verify. Both halves matter: the pin (a bundle no CI can
  // reproduce) and node_modules (a linked worktree with none resolves upward
  // and writes different module banner comments for identical sources).
  test("the guard is the gate's own requirement list, both halves of it", () => {
    expect(MAIN_ARTIFACT.requires).toContain(needsPinnedBun)
    expect(MAIN_ARTIFACT.requires).toContain(needsNodeModules)
  })

  // Asserted from the other side in check-bindings.test.ts and prepack.test.ts;
  // this pins the literal so a rename of THIS file cannot leave those green.
  test("BUILD_COMMAND names this file", () => {
    expect(BUILD_COMMAND).toBe("bun scripts/ops/build-bundle.ts")
  })
})
