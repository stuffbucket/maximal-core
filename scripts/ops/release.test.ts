import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { ARTIFACTS } from "./check-bindings"
import type { CommandRunner } from "./prepack"
import {
  bumppArgv,
  cleanTreeObjection,
  executeCommand,
  main,
  NO_PUBLISH_FLAG,
  parseStatus,
  PUBLISH_ARGV,
  REBUILD_FLAG,
  release,
  rebuildAndStage,
  stageArgv,
  stagePathspecs,
  untrackedNote,
} from "./release"

// Offline and deterministic: `git` and every child process are injected, so
// nothing here bumps a version, spawns a bundler, touches a repository or
// reaches a registry. The parity guards are the deliberate exception — they read
// the real package.json, which is the point of them.
//
// Nothing here may assert on the AMBIENT environment (no node_modules, no
// particular Bun): release-gates.yml runs `check:ops` with no `bun install`.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

const PINNED = "1.3.11"

interface Invocation {
  command: string
  args: Array<string>
}

function recorder(statuses: Array<number> = []): {
  calls: Array<Invocation>
  run: CommandRunner
} {
  const calls: Array<Invocation> = []
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args: [...args] })
    return { status: statuses[calls.length - 1] ?? 0, output: "" }
  }
  return { calls, run }
}

/** A `git` that answers `status` with `porcelain` and succeeds at everything else. */
function gitStub(porcelain: string, statuses: Record<string, number> = {}): {
  calls: Array<Array<string>>
  git: (args: ReadonlyArray<string>) => { status: number; stdout: string; stderr: string }
} {
  const calls: Array<Array<string>> = []
  return {
    calls,
    git: (args) => {
      calls.push([...args])
      const verb = args[0] ?? ""
      return { status: statuses[verb] ?? 0, stdout: verb === "status" ? porcelain : "", stderr: "" }
    },
  }
}

function silent(): { lines: Array<string>; log: (line: string) => void } {
  const lines: Array<string> = []
  return { lines, log: (line) => lines.push(line) }
}

function readScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
  return pkg.scripts
}

const CLEAN = ""

/**
 * The pin, always injected: `check:ops` runs on whatever Bun the developer or
 * the workflow has, so a test that let `prepack` measure the real one would be
 * red off-pin for reasons that have nothing to do with this file.
 */
const ON_PIN = { running: PINNED, pinned: PINNED } as const

describe("parity with the real package.json", () => {
  // The whole point of the wrapper is that the sequence lives in ONE process
  // that can order the guard, the pin, the bump and the publish. A `&&` chain
  // cannot express "guard the tree that the step after next will modify".
  test("`release:manual` is this script and nothing else", () => {
    expect(readScripts()["release:manual"]).toBe("bun scripts/ops/release.ts")
  })

  // The preflight stays a separate, runnable command: the runbook tells a
  // releaser to run it by hand before anything, and `prepack` is still the
  // backstop for a direct `bun publish` / `bun pm pack`.
  test("the standalone preflight still exists", () => {
    expect(readScripts()["release:preflight"]).toBe("bun scripts/ops/prepack.ts --check")
  })

  test("the publish argv is the one the old chain ended in", () => {
    expect(PUBLISH_ARGV).toEqual(["publish", "--access", "public"])
  })
})

describe("stagePathspecs", () => {
  // A literal list here would be free to drift from the gate. If `bindings:check`
  // grows a third committed artifact and this does not, the release commit ships
  // it stale — the exact failure the wrapper exists to close.
  test("stages exactly what bindings:check verifies", () => {
    expect(stagePathspecs()).toEqual(ARTIFACTS.map((artifact) => artifact.id))
    expect(stagePathspecs()).toEqual(["dist/lib", "dist/main.js"])
  })

  // `dist/` is gitignored and force-tracked, so a bare `git add` silently skips
  // a NEW file — a renamed tsup content-hash chunk would never be committed.
  test("`git add` is forced, or new files under dist/ are silently skipped", () => {
    expect(stageArgv(["dist/lib"])).toEqual(["add", "-f", "--", "dist/lib"])
  })
})

describe("parseStatus", () => {
  test("splits the two-character code from the path", () => {
    expect(parseStatus("?? notes.md\n M src/main.ts\nM  dist/main.js")).toEqual([
      { code: "??", path: "notes.md" },
      { code: " M", path: "src/main.ts" },
      { code: "M ", path: "dist/main.js" },
    ])
  })

  test("a clean tree is no records, not one empty one", () => {
    expect(parseStatus("")).toEqual([])
    expect(parseStatus("\n")).toEqual([])
  })

  // Paths with a space are the common case; git quotes anything stranger.
  test("a path with a space survives", () => {
    expect(parseStatus(" M docs/my notes.md")[0]?.path).toBe("docs/my notes.md")
  })
})

describe("cleanTreeObjection", () => {
  test("a clean tree may release", () => {
    expect(cleanTreeObjection(CLEAN)).toBeUndefined()
  })

  // The load-bearing rule. `git commit --all` sweeps every tracked modification
  // into the release commit, and a published tag must not be moved.
  test("an unstaged tracked modification is refused, and named", () => {
    const objection = cleanTreeObjection(" M src/lib/config.ts")
    expect(objection).toBeDefined()
    expect(objection).toContain("REFUSING")
    expect(objection).toContain("src/lib/config.ts")
    expect(objection).toContain("--all")
  })

  test("a STAGED modification is refused too — `--all` commits the index", () => {
    expect(cleanTreeObjection("M  src/lib/config.ts")).toBeDefined()
    expect(cleanTreeObjection("A  src/new.ts")).toBeDefined()
    expect(cleanTreeObjection("MM src/lib/config.ts")).toBeDefined()
  })

  test("a deletion is a tracked modification like any other", () => {
    expect(cleanTreeObjection(" D src/gone.ts")).toBeDefined()
    expect(cleanTreeObjection("R  a.ts -> b.ts")).toBeDefined()
  })

  // dist/ is NOT exempted even though the rebuild is about to write to it. The
  // guard runs first, so it is only ever asking "did dist/ match HEAD when we
  // started" — and `bindings:check` reads the index, so a working-tree-only
  // dist edit is invisible to every other gate in the repo.
  test("a dirty dist/ blocks, because nothing else in the repo looks at it", () => {
    const objection = cleanTreeObjection(" M dist/main.js")
    expect(objection).toBeDefined()
    expect(objection).toContain("dist/main.js")
  })

  // The mechanism being guarded is `git commit --all`, which stages only
  // tracked paths. An untracked file cannot reach the release commit, and
  // refusing on one would fail the release for an editor artifact.
  test("untracked files do not block", () => {
    expect(cleanTreeObjection("?? scratch.md")).toBeUndefined()
    expect(cleanTreeObjection("?? scratch.md\n?? tmp/")).toBeUndefined()
  })

  test("untracked plus tracked still blocks, and reports only the tracked one", () => {
    const objection = cleanTreeObjection("?? scratch.md\n M src/main.ts")
    expect(objection).toContain("src/main.ts")
    expect(objection).not.toContain("scratch.md")
    expect(objection).toContain("1 tracked file(s)")
  })
})

describe("untrackedNote", () => {
  test("nothing to say about a clean tree", () => {
    expect(untrackedNote(CLEAN)).toBeUndefined()
    expect(untrackedNote(" M src/main.ts")).toBeUndefined()
  })

  // Reported so a releaser who expected a new file to ship finds out BEFORE the
  // tag, rather than from a consumer afterwards.
  test("untracked files are listed, not refused", () => {
    const note = untrackedNote("?? src/new-route.ts")
    expect(note).toContain("src/new-route.ts")
    expect(note).not.toContain("REFUSING")
  })
})

describe("executeCommand", () => {
  // `bumpp` tokenizes this string with `args-tokenizer` before spawning, so an
  // unquoted home directory with a space in it splits into two argv entries and
  // the hook never runs — after the version has already been bumped.
  test("both paths are quoted", () => {
    expect(executeCommand("/a b/bun", "/c d/release.ts")).toBe(
      `"/a b/bun" "/c d/release.ts" ${REBUILD_FLAG}`,
    )
  })

  test("the hook names a binary, never a bare `bun`", () => {
    expect(executeCommand("/pin/bun", "/x/release.ts")).not.toMatch(/(^|\s)bun\s/)
  })
})

describe("bumppArgv", () => {
  // Measured on a throwaway repo: `bumpp`'s default `gitCommit` is
  // `git commit … <updatedFiles>`, git's pathspec form, which IGNORES the index.
  // Without `--all` the hook's `git add -f dist/…` is dropped from the release
  // commit and left dangling after it — today's bug, with extra steps.
  test("--all is present, or the staged rebuild never reaches the commit", () => {
    expect(bumppArgv("hook")).toContain("--all")
  })

  test("the execute hook is passed as one argument", () => {
    expect(bumppArgv("<hook>")).toEqual(["x", "bumpp", "--all", "--execute", "<hook>"])
  })

  // `bun x bumpp` rather than a bare `bumpp`: Bun's lifecycle PATH carries
  // neither `node_modules/.bin` nor Bun's own bindir, so only a resolution
  // through the interpreter we already hold works everywhere.
  test("bumpp resolves through the interpreter, not PATH", () => {
    expect(bumppArgv("hook").slice(0, 2)).toEqual(["x", "bumpp"])
  })

  test("extra argv is forwarded after the flags", () => {
    expect(bumppArgv("hook", ["--release", "patch", "-y"]).slice(-3)).toEqual([
      "--release",
      "patch",
      "-y",
    ])
  })
})

describe("rebuildAndStage", () => {
  test("builds, then stages exactly the committed artifacts", () => {
    const { calls, run } = recorder()
    const { calls: gitCalls, git } = gitStub(CLEAN)
    const { log } = silent()
    expect(rebuildAndStage({ ...ON_PIN, run, git, log })).toBe(0)
    expect(calls).toHaveLength(2) // bun build + bun x tsup, via prepack
    expect(gitCalls).toEqual([["add", "-f", "--", "dist/lib", "dist/main.js"]])
  })

  // The whole reason the rebuild goes through `prepack()`: it bundles with
  // `process.execPath`, the binary whose version was checked, never a PATH
  // lookup. `/path/to/1.3.11/bun run build` provably bundles with 1.3.14.
  test("the bundler is this process, never a PATH lookup", () => {
    const { calls, run } = recorder()
    const { git } = gitStub(CLEAN)
    const { log } = silent()
    rebuildAndStage({ ...ON_PIN, run, git, log })
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[0]?.command).not.toBe("bun")
  })

  // Staging bytes that a build did not finish producing would put a truncated
  // or stale bundle into the release commit under a green-looking run.
  test("a failed build stages nothing", () => {
    const { run } = recorder([1])
    const { calls: gitCalls, git } = gitStub(CLEAN)
    const { log } = silent()
    expect(rebuildAndStage({ ...ON_PIN, run, git, log })).toBe(2)
    expect(gitCalls).toEqual([])
  })

  test("a failed `git add` is fatal, not a silent success", () => {
    const { run } = recorder()
    const { git } = gitStub(CLEAN, { add: 1 })
    const { lines, log } = silent()
    expect(rebuildAndStage({ ...ON_PIN, run, git, log })).toBe(2)
    expect(lines.join("\n")).toContain("could not stage")
  })
})

describe("release", () => {
  const ok = (porcelain: string, argv: Array<string> = []): {
    code: number
    calls: Array<Invocation>
    lines: Array<string>
  } => {
    const { calls, run } = recorder()
    const { git } = gitStub(porcelain)
    const { lines, log } = silent()
    const code = main(argv, { ...ON_PIN, run, git, log, bun: "/pin/bun", script: "/x/release.ts" })
    return { code, calls, lines }
  }

  test("a clean tree bumps then publishes", () => {
    const { code, calls } = ok(CLEAN)
    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        command: "/pin/bun",
        args: bumppArgv(executeCommand("/pin/bun", "/x/release.ts")),
      },
      { command: "/pin/bun", args: [...PUBLISH_ARGV] },
    ])
  })

  // Nothing irreversible may happen on the refusal path: `bumpp` commits, tags
  // AND pushes, so a refusal that arrived after it would already be public.
  test("a dirty tree refuses with nothing spawned", () => {
    const { code, calls, lines } = ok(" M src/main.ts")
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
  })

  test("an untracked file is noted, and does not stop the release", () => {
    const { code, calls, lines } = ok("?? scratch.md")
    expect(code).toBe(0)
    expect(calls).toHaveLength(2)
    expect(lines.join("\n")).toContain("scratch.md")
  })

  test("the tree is read before anything else runs", () => {
    const { calls: gitCalls, git } = gitStub(" M src/main.ts")
    const { calls, run } = recorder()
    const { log } = silent()
    release({ ...ON_PIN, run, git, log })
    expect(gitCalls[0]).toEqual(["status", "--porcelain"])
    expect(calls).toEqual([])
  })

  test("a `git status` that cannot run is a cannot-run, never a pass", () => {
    const { calls, run } = recorder()
    const { git } = gitStub(CLEAN, { status: 128 })
    const { lines, log } = silent()
    expect(release({ ...ON_PIN, run, git, log })).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("could not read the working tree")
  })

  test("an off-pin Bun refuses before bumpp, with the prepack wording", () => {
    const { calls, run } = recorder()
    const { git } = gitStub(CLEAN)
    const { lines, log } = silent()
    expect(release({ run, git, log, running: "1.3.14", pinned: PINNED })).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
  })

  test("a failed bumpp does not publish", () => {
    const { calls, run } = recorder([1])
    const { git } = gitStub(CLEAN)
    const { log } = silent()
    expect(release({ ...ON_PIN, run, git, log })).toBe(2)
    expect(calls).toHaveLength(1)
  })

  test("--no-publish stops after the tag", () => {
    const { code, calls } = ok(CLEAN, [NO_PUBLISH_FLAG])
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
  })

  // `--no-publish` is ours; forwarding it would make `bumpp` set `publish: false`
  // on its own config and skip the push.
  test("this script's own flags are not forwarded to bumpp", () => {
    const { calls } = ok(CLEAN, [NO_PUBLISH_FLAG, "--release", "patch", "-y"])
    expect(calls[0]?.args).not.toContain(NO_PUBLISH_FLAG)
    expect(calls[0]?.args.slice(-3)).toEqual(["--release", "patch", "-y"])
  })

  test("--rebuild runs only the hook, and never bumps anything", () => {
    const { calls, run } = recorder()
    const { calls: gitCalls, git } = gitStub(CLEAN)
    const { log } = silent()
    expect(main([REBUILD_FLAG], { ...ON_PIN, run, git, log })).toBe(0)
    expect(calls.every((call) => !call.args.includes("bumpp"))).toBe(true)
    expect(gitCalls).toEqual([["add", "-f", "--", "dist/lib", "dist/main.js"]])
  })
})
