import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { ARTIFACTS } from "./check-bindings"
import type { CommandRunner } from "./prepack"
import { RELEASE_COMMIT_RE } from "./release-gates"
import type { GhResult, GhRunner, PullRequest } from "./release-notes"
import {
  applyChangelog,
  bumppArgv,
  CHANGELOG_ENV,
  CHANGELOG_FILE,
  changelogHasVersion,
  cleanTreeObjection,
  DEFAULT_BASE,
  executeCommand,
  insertChangelogBlock,
  main,
  manifestVersion,
  mergedManifestObjection,
  NO_PUBLISH_FLAG,
  notOnMergedHeadObjection,
  parseArgv,
  parseStatus,
  planChangelog,
  prepare,
  REBUILD_FLAG,
  rebuildAndStage,
  releaseBranch,
  releaseCommitSubject,
  releasePrBody,
  stageArgv,
  stagePathspecs,
  tagRelease,
  untrackedNote,
} from "./release"

// Offline and deterministic: `git`, `gh` and every child process are injected,
// and CHANGELOG.md is read and written through an injected pair — so nothing
// here bumps a version, spawns a bundler, touches a repository, reaches a
// registry or edits a file. The parity guards are the deliberate exception —
// they read the real package.json and the real CHANGELOG.md, which is the point
// of them.
//
// Nothing here may assert on the AMBIENT environment (no node_modules, no
// particular Bun): release-gates.yml runs `check:ops` with no `bun install`.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

const PINNED = "1.3.11"

const TAG = "v0.4.2"

interface Invocation {
  command: string
  args: Array<string>
  /** The handed-over block, captured AT THE MOMENT of the call. */
  block?: string
}

function recorder(statuses: Array<number> = []): {
  calls: Array<Invocation>
  run: CommandRunner
  handedOver: Array<string | undefined>
  handOverBlock: (block: string | undefined) => void
} {
  const calls: Array<Invocation> = []
  const handedOver: Array<string | undefined> = []
  let current: string | undefined
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args: [...args], block: current })
    return { status: statuses[calls.length - 1] ?? 0, output: "" }
  }
  return {
    calls,
    run,
    handedOver,
    handOverBlock: (block) => {
      current = block
      handedOver.push(block)
    },
  }
}

interface Refs {
  /** What `git rev-parse FETCH_HEAD` answers — the merged commit. */
  merged?: string
  /** What `git rev-parse HEAD` answers. Defaults to `merged`. */
  head?: string
  /** The `package.json` `git show <merged>:package.json` answers with. */
  manifest?: string
}

/**
 * A `git` that answers `status` with `porcelain`, the two tag reads gate 4 makes
 * with `tags`, phase B's two `rev-parse`s and one `show` with `refs`, and
 * succeeds at everything else.
 */
function gitStub(
  porcelain: string,
  statuses: Record<string, number> = {},
  tags: { local?: ReadonlyArray<string>; remote?: ReadonlyArray<string> } = {},
  refs: Refs = {},
): {
  calls: Array<Array<string>>
  git: (args: ReadonlyArray<string>) => { status: number; stdout: string; stderr: string }
} {
  const calls: Array<Array<string>> = []
  const merged = refs.merged ?? MERGED_SHA
  return {
    calls,
    git: (args) => {
      calls.push([...args])
      const verb = args[0] ?? ""
      const stdout =
        verb === "status" ? porcelain
        : verb === "tag" ? (tags.local ?? []).join("\n")
        : verb === "ls-remote" ? (tags.remote ?? []).map((t) => `deadbeef\trefs/tags/${t}`).join("\n")
        : verb === "rev-parse" ? `${args[1] === "HEAD" ? refs.head ?? merged : merged}\n`
        : verb === "show" ? refs.manifest ?? MANIFEST
        : ""
      return { status: statuses[verb] ?? 0, stdout, stderr: "" }
    },
  }
}

/** The commit the squash merge produced. Phase B tags this and nothing else. */
const MERGED_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"

/** `main`'s package.json after the release PR merged: bumped to the tag. */
const MANIFEST = `{\n  "name": "@stuffbucket/maximal-core",\n  "version": "0.4.2"\n}\n`

function silent(): { lines: Array<string>; log: (line: string) => void } {
  const lines: Array<string> = []
  return { lines, log: (line) => lines.push(line) }
}

interface Manifest {
  scripts: Record<string, string>
  publishConfig?: Record<string, string>
}

function readPackageJson(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Manifest
}

function readScripts(): Record<string, string> {
  return readPackageJson().scripts
}

const CLEAN = ""

/** A minimal CHANGELOG: preamble, anchor, one existing release. */
const CHANGELOG = [
  "# Changelog",
  "",
  "<!-- releases below — newest first; `release:notes` output is inserted here -->",
  "",
  "## [0.4.1](https://example.invalid/compare/v0.4.0...v0.4.1) (2026-08-05)",
  "",
  "",
  "### Features",
  "",
  "* **release:** something ([#33](https://example.invalid/issues/33))",
  "",
].join("\n")

const merged = (number: number, title: string): PullRequest => ({
  number,
  title,
  state: "MERGED",
  mergedAt: "2026-08-01T00:00:00Z",
  mergeCommit: { oid: "abc1234def5678901234567890abcdef12345678" },
})

const PR_URL = "https://example.invalid/stuffbucket/maximal-core/pull/91"

/**
 * A `gh` wired for one milestone. `prs` drives the notes; an empty list is the
 * fatal `empty-milestone` case, and `milestones: false` is a missing one.
 * `open` drives gate 5, and is matched ahead of the milestone search because
 * both are `gh pr list`. `pr create` is phase A's last step and answers with a
 * URL rather than JSON, exactly as the real `gh` does.
 */
function ghStub(
  prs: ReadonlyArray<PullRequest>,
  options: { milestone?: boolean; open?: ReadonlyArray<unknown>; prCreate?: number } = {},
): { calls: Array<Array<string>>; gh: GhRunner } {
  const calls: Array<Array<string>> = []
  const routes: Array<[string, unknown]> = [
    ["repo view", { nameWithOwner: "stuffbucket/maximal-core" }],
    ["milestones", options.milestone === false ? [] : [{ number: 1, title: TAG, state: "open" }]],
    ["tags", [{ name: "v0.4.1" }]],
    ["--state open", options.open ?? []],
    ["pr list", prs],
  ]
  return {
    calls,
    gh: (args) => {
      calls.push([...args])
      const joined = args.join(" ")
      // `pr create` answers with a URL rather than JSON, like the real thing.
      if (joined.includes("pr create")) {
        const status = options.prCreate ?? 0
        return { status, stdout: status === 0 ? `${PR_URL}\n` : "", stderr: status === 0 ? "" : "gh: refused" }
      }
      const hit = routes.find(([needle]) => joined.includes(needle))
      const result: GhResult =
        hit ?
          { status: 0, stdout: JSON.stringify(hit[1]), stderr: "" }
        : { status: 1, stdout: "", stderr: `unrouted: ${joined}` }
      return result
    },
  }
}

/**
 * The pin, always injected: `check:ops` runs on whatever Bun the developer or
 * the workflow has, so a test that let `prepack` measure the real one would be
 * red off-pin for reasons that have nothing to do with this file.
 */
const ON_PIN = { running: PINNED, pinned: PINNED } as const

describe("parity with the real package.json", () => {
  // The whole point of the wrapper is that the sequence lives in ONE process
  // that can order the guard, the pin, the bump and the tag. A `&&` chain
  // cannot express "guard the tree that the step after next will modify".
  test("both phases are this script, and nothing else", () => {
    expect(readScripts()["release:prepare"]).toBe("bun scripts/ops/release.ts prepare")
    expect(readScripts()["release:tag"]).toBe("bun scripts/ops/release.ts tag")
  })

  // The flow that pushed the release commit straight to `main` is gone, and so
  // is the script that did it. Leaving the name behind as an alias would leave a
  // command in everyone's shell history that fails at the push, after the bump.
  test("`release:manual` is gone rather than aliased", () => {
    expect(readScripts()["release:manual"]).toBeUndefined()
  })

  // The preflight stays a separate, runnable command: the runbook tells a
  // releaser to run it by hand before anything, and `prepack` is still the
  // backstop for a direct `bun publish` / `bun pm pack`.
  test("the standalone preflight still exists", () => {
    expect(readScripts()["release:preflight"]).toBe("bun scripts/ops/prepack.ts --check")
  })

  // `publish-package.yml` is the only thing that publishes now. This field is
  // the manifest's declaration of where; Bun actually obeys the `.npmrc` that
  // workflow writes (measured — see its header), so the two must agree or a
  // publish lands somewhere nobody declared.
  test("the manifest declares the GitHub Package Registry", () => {
    expect(readPackageJson().publishConfig).toEqual({
      registry: "https://npm.pkg.github.com",
    })
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
    expect(bumppArgv("<hook>")).toEqual([
      "x", "bumpp", "--all", "--no-tag", "--no-push", "--execute", "<hook>",
    ])
  })

  // THE PHASE-A INVARIANT. `bumpConfigDefaults` is `{commit, tag, push}` all
  // true, so an unflagged bumpp tags the BRANCH commit — and the squash merge
  // rewrites that SHA, leaving the tag naming a commit `main` never receives.
  // `--no-push` goes with it: bumpp's gitPush also runs `git push --tags`.
  test("no tag and no push, or the tag names a commit main never gets", () => {
    expect(bumppArgv("hook")).toContain("--no-tag")
    expect(bumppArgv("hook")).toContain("--no-push")
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

  // The hook is what produces everything the release commit carries beyond the
  // bump: the rebuilt bundle AND the changelog entry, both staged, in the one
  // window where the commit has not happened yet.
  test("a handed-over block is written and staged alongside dist/", () => {
    const { run } = recorder()
    const { calls: gitCalls, git } = gitStub(CLEAN)
    const { log } = silent()
    let written = ""
    const code = rebuildAndStage({
      ...ON_PIN,
      run,
      git,
      log,
      changelogBlock: "## 0.4.2 (2026-08-06)\n",
      read: () => CHANGELOG,
      write: (contents) => { written = contents },
    })
    expect(code).toBe(0)
    expect(written).toContain("## 0.4.2 (2026-08-06)")
    expect(gitCalls).toEqual([
      ["add", "-f", "--", "dist/lib", "dist/main.js"],
      ["add", "--", CHANGELOG_FILE],
    ])
  })

  // A by-hand `release.ts --rebuild` hands over nothing, and must not rewrite a
  // file it was not asked to touch.
  test("no block means the changelog is not read or written at all", () => {
    const { run } = recorder()
    const { calls: gitCalls, git } = gitStub(CLEAN)
    const { log } = silent()
    let touched = false
    expect(rebuildAndStage({
      ...ON_PIN,
      run,
      git,
      log,
      read: () => { touched = true; return CHANGELOG },
      write: () => { touched = true },
    })).toBe(0)
    expect(touched).toBe(false)
    expect(gitCalls).toEqual([["add", "-f", "--", "dist/lib", "dist/main.js"]])
  })

  // A write that silently failed would let `bumpp` commit a release with no
  // changelog entry — invisible until somebody reads the file.
  test("a changelog that cannot be written is fatal", () => {
    const { run } = recorder()
    const { git } = gitStub(CLEAN)
    const { lines, log } = silent()
    expect(rebuildAndStage({
      ...ON_PIN,
      run,
      git,
      log,
      changelogBlock: "## 0.4.2 (2026-08-06)\n",
      read: () => CHANGELOG,
      write: () => { throw new Error("read-only fs") },
    })).toBe(2)
    expect(lines.join("\n")).toContain("could not write")
  })
})

describe("changelogHasVersion", () => {
  test("finds both heading shapes release-notes.ts emits", () => {
    expect(changelogHasVersion("## [0.4.1](https://x/compare) (2026-08-05)", "0.4.1")).toBe(true)
    expect(changelogHasVersion("## 0.4.1 (2026-08-05)", "0.4.1")).toBe(true)
  })

  test("a longer version is not a match for its prefix", () => {
    expect(changelogHasVersion("## [0.4.10](https://x) (2026-08-05)", "0.4.1")).toBe(false)
    expect(changelogHasVersion(CHANGELOG, "0.4.2")).toBe(false)
    expect(changelogHasVersion(CHANGELOG, "0.4.1")).toBe(true)
  })

  // The preamble names versions in prose (`v0.1.0`, `v0.1.1` … were
  // reconstructed). Only a heading counts.
  test("prose mentioning the version is not a heading", () => {
    expect(changelogHasVersion("`v0.4.2` will be cut from the milestone 0.4.2", "0.4.2")).toBe(false)
  })
})

describe("insertChangelogBlock", () => {
  const block = "## [0.4.2](https://example.invalid/compare) (2026-08-06)\n\n\n### Features\n\n* a thing (#1)\n"

  test("inserts below the anchor, above the previous release", () => {
    const next = insertChangelogBlock(CHANGELOG, block) ?? ""
    const headings = [...next.matchAll(/^## \[(?<version>[\d.]+)\]/gmu)].map((m) => m.groups?.version)
    expect(headings).toEqual(["0.4.2", "0.4.1"])
    expect(next.indexOf("<!-- releases below")).toBeLessThan(next.indexOf("## [0.4.2]"))
  })

  // One blank line between blocks is what every existing pair in the file uses,
  // so a generated insert is indistinguishable from the pasted ones above it.
  test("the spacing matches the pairs already in the file", () => {
    const next = insertChangelogBlock(CHANGELOG, block) ?? ""
    expect(next).toContain("* a thing (#1)\n\n## [0.4.1]")
    expect(next).toContain("inserted here -->\n\n## [0.4.2]")
  })

  test("the preamble above the anchor is untouched", () => {
    const next = insertChangelogBlock(CHANGELOG, block) ?? ""
    expect(next.startsWith("# Changelog\n\n<!-- releases below")).toBe(true)
  })

  // A first release: the anchor is the last thing in the file.
  test("an anchor with nothing under it still gets a trailing newline", () => {
    const next = insertChangelogBlock("# Changelog\n\n<!-- releases below -->\n", block)
    expect(next).toBe(`# Changelog\n\n<!-- releases below -->\n\n${block.trimEnd()}\n`)
  })

  // Guessing an offset is exactly what the anchor exists to prevent.
  test("no anchor means no insertion, never a guess", () => {
    expect(insertChangelogBlock("# Changelog\n\n## [0.4.1](x) (2026-08-05)\n", block)).toBeUndefined()
  })

  test("the real CHANGELOG.md still carries the anchor", () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, CHANGELOG_FILE), "utf8")
    expect(insertChangelogBlock(real, block)).toBeDefined()
  })
})

describe("applyChangelog", () => {
  test("writes the file back with the block in it", () => {
    let written = ""
    expect(applyChangelog("## 0.4.2 (2026-08-06)\n", {
      read: () => CHANGELOG,
      write: (contents) => { written = contents },
    })).toBeUndefined()
    expect(written).toContain("## 0.4.2 (2026-08-06)")
    expect(written).toContain("## [0.4.1]")
  })

  test("a missing anchor objects rather than appending somewhere plausible", () => {
    let written = ""
    const objection = applyChangelog("## 0.4.2 (2026-08-06)\n", {
      read: () => "# Changelog\n",
      write: (contents) => { written = contents },
    })
    expect(objection).toContain("no insertion anchor")
    expect(written).toBe("")
  })
})

describe("planChangelog", () => {
  const plan = (
    prs: ReadonlyArray<PullRequest>,
    options: { source?: string; milestone?: boolean } = {},
  ) => {
    const { calls, gh } = ghStub(prs, options)
    return {
      calls,
      result: planChangelog({
        tag: TAG,
        gh,
        read: () => options.source ?? CHANGELOG,
        now: () => new Date("2026-08-06T00:00:00Z"),
      }),
    }
  }

  test("renders the milestone into a block", () => {
    const { result } = plan([merged(42, "feat(release): insert the changelog")])
    expect(result.objection).toBeUndefined()
    expect(result.block).toContain("## [0.4.2]")
    expect(result.block).toContain("### Features")
    expect(result.block).toContain("insert the changelog")
  })

  // `release:notes` refuses to emit on these rather than shipping wrong notes.
  // The release it feeds must refuse for exactly the same reasons.
  test("a milestone that release:notes would refuse refuses the release", () => {
    expect(plan([]).result.objection).toContain("REFUSING")
    expect(plan([merged(1, "not a conventional commit")]).result.objection).toContain("REFUSING")
    expect(plan([], { milestone: false }).result.objection).toContain("REFUSING")
  })

  test("a non-conforming title is named, so the fix is obvious", () => {
    const objection = plan([
      merged(1, "feat(x): fine"),
      merged(2, "just some words"),
    ]).result.objection
    expect(objection).toContain("#2")
    expect(objection).toContain("non-conforming-title")
  })

  // A re-run, or a human who pasted the block: the entry the release needs is
  // already there, and rewriting it is the only outcome worse than leaving it.
  test("an entry that is already there is left alone, without touching gh", () => {
    const { calls, result } = plan([merged(1, "feat: x")], {
      source: CHANGELOG.replace("## [0.4.1]", "## [0.4.2](https://x) (2026-08-06)\n\n## [0.4.1]"),
    })
    expect(result.block).toBeUndefined()
    expect(result.objection).toBeUndefined()
    expect(result.note).toContain("0.4.2")
    expect(calls).toEqual([])
  })

  test("a changelog with no anchor objects before any gh call", () => {
    const { calls, result } = plan([merged(1, "feat: x")], { source: "# Changelog\n" })
    expect(result.objection).toContain("no insertion anchor")
    expect(calls).toEqual([])
  })
})

describe("parseArgv", () => {
  test("claims the tag positionally", () => {
    expect(parseArgv(["prepare", TAG]).tag).toBe(TAG)
    expect(parseArgv(["prepare", TAG, "-y"])).toMatchObject({ tag: TAG, bumppArgs: ["-y"] })
    expect(parseArgv(["prepare", NO_PUBLISH_FLAG, TAG])).toMatchObject({ tag: TAG, bumppArgs: [] })
  })

  // The two phases do very different things, so neither is a default: inferring
  // one from an argv that named neither is how somebody opens a second release
  // PR when they meant to tag the first.
  test("the phase is read, and only from position 0", () => {
    expect(parseArgv(["prepare", TAG]).subcommand).toBe("prepare")
    expect(parseArgv(["tag", TAG]).subcommand).toBe("tag")
    expect(parseArgv([TAG]).subcommand).toBeUndefined()
    expect(parseArgv(["ship", TAG]).subcommand).toBeUndefined()
  })

  // `-t <template>` is bumpp's tag NAME. Reading its value as the phase — or
  // the phase word out of the middle of a forwarded flag list — would run the
  // wrong half of the release.
  test("a forwarded flag is never mistaken for the phase", () => {
    expect(parseArgv(["prepare", TAG, "-t", "tag"]).subcommand).toBe("prepare")
    expect(parseArgv(["prepare", TAG, "-t", "tag"]).bumppArgs).toEqual(["-t", "tag"])
  })

  test("no tag is not an invented one", () => {
    expect(parseArgv(["prepare"]).tag).toBeUndefined()
    expect(parseArgv(["prepare", "-y"]).tag).toBeUndefined()
  })

  // Prereleases are not modelled by any of this tooling, and `v0.3` is not a
  // milestone title gate 1 accepts either.
  test("only a full release tag is claimed", () => {
    expect(parseArgv(["prepare", "v0.4"]).tag).toBeUndefined()
    expect(parseArgv(["prepare", "v0.4.2-rc.1"]).tag).toBeUndefined()
    expect(parseArgv(["prepare", "v0.4"]).bumppArgs).toEqual(["v0.4"])
  })

  // `-t v9.9.9` names bumpp's tag template. Reading a forwarded flag's value as
  // the release tag would cut the wrong version.
  test("a forwarded flag's value is not mistaken for the tag", () => {
    expect(parseArgv(["prepare", "-t", "v9.9.9"]).tag).toBeUndefined()
    expect(parseArgv(["prepare", "-t", "v9.9.9"]).bumppArgs).toEqual(["-t", "v9.9.9"])
    expect(parseArgv(["prepare", TAG, "-t", "v9.9.9"]).tag).toBe(TAG)
  })

  // Two sources for the version is how `v0.1.1` came to be tagged off a `0.1.0`
  // manifest. There is one source, and it is the tag.
  test("--release is refused, not forwarded", () => {
    expect(parseArgv(["prepare", TAG, "--release", "minor"]).objection).toContain("REFUSING")
  })

  test("this script's own flags are never forwarded", () => {
    expect(parseArgv(["prepare", TAG, NO_PUBLISH_FLAG, REBUILD_FLAG]).bumppArgs).toEqual([])
  })
})

describe("the release commit's subject", () => {
  // THE COUPLING THAT MAKES THE TWO-PHASE FLOW POSSIBLE. Gate 5 blocks any PR
  // open in the milestone being cut, and the release PR is by definition one of
  // those on a re-run. `release-gates.ts` exempts it by TITLE, so the title this
  // builds has to match that regex — pinned here rather than left to two files
  // agreeing in prose.
  test("the PR title is exactly what gate 5 exempts", () => {
    expect(RELEASE_COMMIT_RE.test(releaseCommitSubject(TAG))).toBe(true)
    expect(RELEASE_COMMIT_RE.test(releaseCommitSubject("v1.10.0"))).toBe(true)
  })

  // It is also bumpp's own default commit message (`chore: release v` + the new
  // version), so the commit and the PR carry one subject without configuring
  // anything — and the tag annotation reuses it, matching every tag from v0.4.1.
  test("it is bumpp's default commit message, verbatim", () => {
    expect(releaseCommitSubject(TAG)).toBe(`chore: release ${TAG}`)
  })

  test("the branch is named from the tag", () => {
    expect(releaseBranch(TAG)).toBe(`release/${TAG}`)
  })

  // A reviewer cannot derive from the diff that a second command is still owed.
  test("the PR body says the tag is not cut yet", () => {
    const body = releasePrBody(TAG)
    expect(body).toContain(`release:tag ${TAG}`)
    expect(body).toContain("not cut yet")
    expect(body).toContain(DEFAULT_BASE)
  })
})

describe("prepare", () => {
  const ok = (
    porcelain: string,
    argv: Array<string> = ["prepare", TAG],
    prs = [merged(42, "feat: a thing")],
  ): {
    code: number
    calls: Array<Invocation>
    gitCalls: Array<Array<string>>
    ghCalls: Array<Array<string>>
    lines: Array<string>
    handedOver: Array<string | undefined>
  } => {
    const { calls, run, handedOver, handOverBlock } = recorder()
    const { calls: gitCalls, git } = gitStub(porcelain)
    const { calls: ghCalls, gh } = ghStub(prs)
    const { lines, log } = silent()
    const code = main(argv, {
      ...ON_PIN,
      run,
      git,
      gh,
      log,
      handOverBlock,
      read: () => CHANGELOG,
      now: () => new Date("2026-08-06T00:00:00Z"),
      bun: "/pin/bun",
      script: "/x/release.ts",
    })
    return { code, calls, gitCalls, ghCalls, lines, handedOver }
  }

  // `bumpp` is the only child process this phase runs. It bumps and commits;
  // the branch, the push and the PR are `git` and `gh`, and the tag is phase B.
  test("a clean tree bumps, and that is the only thing it runs", () => {
    const { code, calls } = ok(CLEAN)
    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        command: "/pin/bun",
        args: bumppArgv(executeCommand("/pin/bun", "/x/release.ts"), ["--release", "0.4.2"]),
        block: expect.stringContaining("## [0.4.2]") as unknown as string,
      },
    ])
  })

  // THE SHAPE OF PHASE A, END TO END: branch, bump, push the BRANCH, open the
  // PR — and no `git tag` anywhere, because the squash merge has not happened
  // and any tag cut here would name a commit `main` never receives.
  test("it branches, pushes the branch, and cuts no tag", () => {
    const { code, gitCalls } = ok(CLEAN)
    expect(code).toBe(0)
    expect(gitCalls).toEqual([
      ["status", "--porcelain"],
      ["tag", "--list"],
      ["ls-remote", "--tags", "origin"],
      ["switch", "-c", `release/${TAG}`],
      ["push", "--set-upstream", "origin", `release/${TAG}`],
    ])
    expect(gitCalls.some((call) => call[0] === "tag" && call[1] !== "--list")).toBe(false)
  })

  // The title is the whole of gate 5's exemption. A PR opened under any other
  // one is a PR open in the milestone being cut, and refuses the re-run.
  test("the PR is opened with the title gate 5 exempts, and no milestone", () => {
    const { ghCalls, lines } = ok(CLEAN)
    const create = ghCalls.find((call) => call[0] === "pr" && call[1] === "create")
    expect(create).toBeDefined()
    expect(create).toContain("--head")
    expect(create).toContain(`release/${TAG}`)
    expect(create?.[create.indexOf("--title") + 1]).toBe(releaseCommitSubject(TAG))
    expect(create).not.toContain("--milestone")
    expect(lines.join("\n")).toContain("NO TAG HAS BEEN CUT")
  })

  // The branch is the first thing written, and it is written LAST of the
  // preparatory steps — so every refusal above leaves the checkout where it was.
  test("nothing is branched until every gate has passed", () => {
    const { gitCalls } = ok(" M src/main.ts")
    expect(gitCalls.some((call) => call[0] === "switch")).toBe(false)
  })

  // A pushed branch with no PR is recoverable, but only if the failure says so
  // — and says which title to reopen it under.
  test("a failed `gh pr create` reports the branch is already pushed", () => {
    const { calls, run, handOverBlock } = recorder()
    const { git } = gitStub(CLEAN)
    const { gh } = ghStub([merged(1, "feat: x")], { prCreate: 1 })
    const { lines, log } = silent()
    const code = prepare({
      ...ON_PIN, tag: TAG, run, git, gh, log, handOverBlock, read: () => CHANGELOG,
      now: () => new Date("2026-08-06T00:00:00Z"),
    })
    expect(code).toBe(2)
    expect(calls).toHaveLength(1)
    expect(lines.join("\n")).toContain("is pushed")
    expect(lines.join("\n")).toContain(releaseCommitSubject(TAG))
  })

  // The branch already existing means a previous attempt got further than this
  // one, and deleting it blind could throw away a finished release commit.
  test("a branch that already exists refuses before bumpp", () => {
    const { calls, run } = recorder()
    const { git } = gitStub(CLEAN, { switch: 128 })
    const { gh } = ghStub([merged(1, "feat: x")])
    const { lines, log } = silent()
    expect(prepare({
      ...ON_PIN, tag: TAG, run, git, gh, log, read: () => CHANGELOG,
      now: () => new Date("2026-08-06T00:00:00Z"),
    })).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
    expect(lines.join("\n")).toContain(`release/${TAG}`)
  })

  // The version reaches bumpp from the tag, so gate 3 — "the tag matches
  // package.json" — is true by construction rather than by a preflight anyone
  // can skip. That is the failure `v0.1.1` shipped.
  test("bumpp is told the exact version, never left to prompt", () => {
    const { calls } = ok(CLEAN)
    expect(calls[0]?.args.slice(-2)).toEqual(["--release", "0.4.2"])
  })

  // The block is live for exactly the bumpp call — the hook runs inside it —
  // and is cleared afterwards, so nothing this process spawns later inherits it.
  test("the block is handed over for bumpp only", () => {
    const { calls, handedOver } = ok(CLEAN)
    expect(calls[0]?.block).toContain("## [0.4.2]")
    expect(handedOver[handedOver.length - 1]).toBeUndefined()
  })

  test("no tag refuses with the usage, and nothing spawned", () => {
    const { code, calls, lines } = ok(CLEAN, ["prepare"])
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("release:prepare vX.Y.Z")
    expect(lines.join("\n")).toContain("release:tag vX.Y.Z")
  })

  // Neither phase is a default. An argv that names no phase gets both spelled
  // out rather than one of them run.
  test("no phase refuses, naming both", () => {
    const { code, calls, lines } = ok(CLEAN, [TAG])
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("prepare")
    expect(lines.join("\n")).toContain("tag")
  })

  // Nothing irreversible may happen on the refusal path: `bumpp` commits, tags
  // AND pushes, so a refusal that arrived after it would already be public.
  test("a dirty tree refuses with nothing spawned", () => {
    const { code, calls, lines } = ok(" M src/main.ts")
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
  })

  // The whole reason the notes are fetched BEFORE bumpp: a milestone problem
  // costs a message, not a bumped manifest.
  test("a milestone that cannot produce notes refuses before bumpp", () => {
    const { code, calls, lines } = ok(CLEAN, [TAG], [])
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
  })

  test("an untracked file is noted, and does not stop the release", () => {
    const { code, calls, lines } = ok("?? scratch.md")
    expect(code).toBe(0)
    expect(calls).toHaveLength(1) // bumpp
    expect(lines.join("\n")).toContain("scratch.md")
  })

  test("the tree is read before anything else runs", () => {
    const { calls: gitCalls, git } = gitStub(" M src/main.ts")
    const { calls: ghCalls, gh } = ghStub([merged(1, "feat: x")])
    const { calls, run } = recorder()
    const { log } = silent()
    prepare({ ...ON_PIN, tag: TAG, run, git, gh, log, read: () => CHANGELOG })
    expect(gitCalls[0]).toEqual(["status", "--porcelain"])
    expect(calls).toEqual([])
    expect(ghCalls).toEqual([])
  })

  test("a `git status` that cannot run is a cannot-run, never a pass", () => {
    const { calls, run } = recorder()
    const { git } = gitStub(CLEAN, { status: 128 })
    const { lines, log } = silent()
    expect(prepare({ ...ON_PIN, tag: TAG, run, git, log })).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("could not read the working tree")
  })

  test("an off-pin Bun refuses before bumpp, with the prepack wording", () => {
    const { calls, run } = recorder()
    const { git } = gitStub(CLEAN)
    const { lines, log } = silent()
    expect(prepare({ tag: TAG, run, git, log, running: "1.3.14", pinned: PINNED })).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
  })

  test("a failed bumpp is a failed release", () => {
    const { calls, run, handOverBlock } = recorder([1])
    const { git } = gitStub(CLEAN)
    const { gh } = ghStub([merged(1, "feat: x")])
    const { log } = silent()
    expect(prepare({
      ...ON_PIN, tag: TAG, run, git, gh, log, handOverBlock, read: () => CHANGELOG,
    })).toBe(2)
    expect(calls).toHaveLength(1)
  })

  // Accepted and inert. The flag used to skip a `bun publish` this script no
  // longer runs; erroring on it now would break a muscle-memory invocation for
  // no gain, so it produces the same release as omitting it.
  test("--no-publish is accepted and changes nothing", () => {
    const { code, calls } = ok(CLEAN, ["prepare", TAG, NO_PUBLISH_FLAG])
    expect(code).toBe(0)
    expect(calls).toEqual(ok(CLEAN, ["prepare", TAG]).calls)
  })

  // `--no-publish` is ours; forwarding it would make `bumpp` set `publish: false`
  // on its own config and skip the push.
  test("this script's own flags are not forwarded to bumpp", () => {
    const { calls } = ok(CLEAN, ["prepare", TAG, NO_PUBLISH_FLAG, "-y"])
    expect(calls[0]?.args).not.toContain(NO_PUBLISH_FLAG)
    expect(calls[0]?.args.slice(-1)).toEqual(["-y"])
  })

  test("--rebuild runs only the hook, and never bumps anything", () => {
    const { calls, run } = recorder()
    const { calls: gitCalls, git } = gitStub(CLEAN)
    const { log } = silent()
    expect(main([REBUILD_FLAG], { ...ON_PIN, run, git, log })).toBe(0)
    expect(calls.every((call) => !call.args.includes("bumpp"))).toBe(true)
    expect(gitCalls).toEqual([["add", "-f", "--", "dist/lib", "dist/main.js"]])
  })

  // The hook is a separate process; the environment is how the block crosses.
  test("--rebuild picks the block up from the environment", () => {
    const previous = process.env[CHANGELOG_ENV]
    process.env[CHANGELOG_ENV] = "## 0.4.2 (2026-08-06)\n"
    try {
      const { run } = recorder()
      const { git } = gitStub(CLEAN)
      const { log } = silent()
      let written = ""
      expect(main([REBUILD_FLAG], {
        ...ON_PIN, run, git, log, read: () => CHANGELOG, write: (c) => { written = c },
      })).toBe(0)
      expect(written).toContain("## 0.4.2 (2026-08-06)")
    } finally {
      if (previous === undefined) delete process.env[CHANGELOG_ENV]
      else process.env[CHANGELOG_ENV] = previous
    }
  })
})

describe("prepare — gate 4, the tag must be ahead of every tag that exists", () => {
  const cut = (
    tags: { local?: Array<string>; remote?: Array<string> },
    statuses: Record<string, number> = {},
    open: Array<unknown> = [],
  ): { code: number; calls: Array<Invocation>; ghCalls: Array<Array<string>>; lines: Array<string> } => {
    const { calls, run, handOverBlock } = recorder()
    const { git } = gitStub(CLEAN, statuses, tags)
    const { calls: ghCalls, gh } = ghStub([merged(42, "feat: a thing")], { open })
    const { lines, log } = silent()
    const code = prepare({
      ...ON_PIN, tag: TAG, run, git, gh, log, handOverBlock, read: () => CHANGELOG,
      now: () => new Date("2026-08-06T00:00:00Z"), bun: "/pin/bun", script: "/x/release.ts",
    })
    return { code, calls, ghCalls, lines }
  }

  // THE HAZARD, END TO END. v0.5.0 landed while v0.4.2 was being prepared;
  // cutting v0.4.2 now would publish a lower tag with strictly more content, and
  // a published tag must never be moved, so there is no repair afterwards.
  test("a tag below one that already exists refuses before bumpp", () => {
    const { code, calls, lines } = cut({ remote: ["v0.4.1", "v0.5.0"] })
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("tag-not-highest")
    expect(lines.join("\n")).toContain("nothing has been committed, tagged or pushed")
  })

  test("a tag that already exists refuses before bumpp", () => {
    const { code, calls, lines } = cut({ remote: [TAG] })
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("tag-already-exists")
  })

  // The stale-checkout case, which is the whole reason the remote is read: this
  // checkout has never heard of v0.5.0.
  test("a tag known only to the remote still refuses", () => {
    const { code, calls } = cut({ local: ["v0.4.1"], remote: ["v0.4.1", "v0.5.0"] })
    expect(code).toBe(1)
    expect(calls).toEqual([])
  })

  test("the highest tag being below the release lets it through", () => {
    const { code, calls } = cut({ local: ["v0.4.1"], remote: ["v0.4.0", "v0.4.1"] })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1) // bumpp
  })

  // Cheapest refusal first: gate 4 is two local `git` calls, so it must not be
  // paid for behind four `gh` round trips — and a refusal must not have made any.
  test("the tags are read before any GitHub call", () => {
    const { ghCalls } = cut({ remote: ["v0.5.0"] })
    expect(ghCalls).toEqual([])
  })

  // A gate that cannot READ what it compares against must not read as a pass:
  // that is the reading that lets the reverse-order tag through. It is safe to
  // fail closed here precisely because nothing has happened yet.
  test("a remote that cannot be read stops the release at 2", () => {
    const { code, calls, lines } = cut({}, { "ls-remote": 128 })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("ls-remote")
  })

  // `git fetch --tags` would answer the same question and mutate the ref store
  // of a repository this run may be about to refuse from.
  test("nothing fetches", () => {
    const { calls: gitCalls, git } = gitStub(CLEAN, {}, { remote: ["v0.5.0"] })
    const { run } = recorder()
    const { gh } = ghStub([merged(1, "feat: x")])
    const { log } = silent()
    prepare({ ...ON_PIN, tag: TAG, run, git, gh, log, read: () => CHANGELOG })
    expect(gitCalls.map((c) => c[0])).toEqual(["status", "tag", "ls-remote"])
  })
})

describe("prepare — gate 5, nothing that ships here is still open", () => {
  const open = (number: number, milestone: string | null): unknown => ({
    number,
    title: "fix: in flight",
    milestone: milestone === null ? null : { title: milestone },
    labels: [],
  })

  const cut = (
    openPrs: Array<unknown>,
    changelog = CHANGELOG,
  ): { code: number; calls: Array<Invocation>; lines: Array<string> } => {
    const { calls, run, handOverBlock } = recorder()
    const { git } = gitStub(CLEAN)
    const { gh } = ghStub([merged(42, "feat: a thing")], { open: openPrs })
    const { lines, log } = silent()
    const code = prepare({
      ...ON_PIN, tag: TAG, run, git, gh, log, handOverBlock, read: () => changelog,
      now: () => new Date("2026-08-06T00:00:00Z"),
    })
    return { code, calls, lines }
  }

  test("an open PR assigned to the release being cut refuses before bumpp", () => {
    const { code, calls, lines } = cut([open(9, TAG)])
    expect(code).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("open-pr-in-release")
  })

  // THE HOLE THIS CLOSES. `release:notes` also refuses on an open PR in the
  // milestone — but `release.ts` skips the changelog step, `gh` reads included,
  // when the entry is already there. Before this gate, a re-run after a failed
  // bumpp (or a hand-pasted block) cut the tag with the open PR unnoticed.
  test("it still refuses when the CHANGELOG already documents the version", () => {
    const already = CHANGELOG.replace("## [0.4.1]", "## [0.4.2]")
    expect(cut([], already).code).toBe(0)
    const { code, calls } = cut([open(9, TAG)], already)
    expect(code).toBe(1)
    expect(calls).toEqual([])
  })

  test("an unmilestoned open PR is listed and does NOT block", () => {
    const { code, calls, lines } = cut([open(11, null)])
    expect(code).toBe(0)
    expect(calls).toHaveLength(1) // bumpp
    expect(lines.join("\n")).toContain("open-pr-unmilestoned")
    expect(lines.join("\n")).toContain("#11")
  })

  test("an open PR in a later release is silent", () => {
    const { code, lines } = cut([open(12, "v0.9.0")])
    expect(code).toBe(0)
    expect(lines.join("\n")).not.toContain("#12")
  })

  test("an open PR in an earlier release warns and does not block", () => {
    const { code, lines } = cut([open(13, "v0.4.1")])
    expect(code).toBe(0)
    expect(lines.join("\n")).toContain("open-pr-earlier-release")
  })

  // THE ONE THE TWO-PHASE FLOW ADDED. Phase A now opens a real PR for the
  // release commit, so from the second run onwards there IS a PR open in the
  // milestone being cut — its own. Gate 5 exempts it by title, which is why
  // `releaseCommitSubject` has to keep matching `RELEASE_COMMIT_RE`. Without
  // this, a re-run after a failed push could never get past its own PR.
  test("the release PR does not refuse the release it is cutting", () => {
    const releasePr = {
      number: 91,
      title: releaseCommitSubject(TAG),
      milestone: { title: TAG },
      labels: [],
    }
    const { code, lines } = cut([releasePr])
    expect(code).toBe(0)
    expect(lines.join("\n")).not.toContain("open-pr-in-release")

    // And it is the TITLE doing the work, not the branch or the number: the
    // same PR under any other title is blocking.
    expect(cut([{ ...releasePr, title: "chore: cut the release" }]).code).toBe(1)
  })
})

describe("tagRelease", () => {
  const cut = (
    options: {
      porcelain?: string
      statuses?: Record<string, number>
      tags?: { local?: Array<string>; remote?: Array<string> }
      refs?: { merged?: string; head?: string; manifest?: string }
      tag?: string
    } = {},
  ): { code: number; gitCalls: Array<Array<string>>; lines: Array<string> } => {
    const { calls: gitCalls, git } = gitStub(
      options.porcelain ?? CLEAN,
      options.statuses ?? {},
      options.tags ?? { local: ["v0.4.1"], remote: ["v0.4.0", "v0.4.1"] },
      options.refs ?? {},
    )
    const { lines, log } = silent()
    return { code: tagRelease({ tag: options.tag ?? TAG, git, log }), gitCalls, lines }
  }

  // THE GOOD PATH, IN ORDER. Fetch, read both SHAs, read the merged manifest,
  // read the tree, gate 4, then exactly one annotated tag and one push.
  test("it fetches, asserts, gates, then cuts one annotated tag on the merged head", () => {
    const { code, gitCalls, lines } = cut()
    expect(code).toBe(0)
    expect(gitCalls).toEqual([
      ["fetch", "origin", DEFAULT_BASE],
      ["rev-parse", "FETCH_HEAD"],
      ["rev-parse", "HEAD"],
      ["show", `${MERGED_SHA}:package.json`],
      ["status", "--porcelain"],
      ["tag", "--list"],
      ["ls-remote", "--tags", "origin"],
      ["tag", "-a", TAG, "-m", releaseCommitSubject(TAG), MERGED_SHA],
      ["push", "origin", TAG],
    ])
    expect(lines.join("\n")).toContain("publish-package.yml")
  })

  // `-a`, never a lightweight tag: nothing else in the repo checks it, and
  // `git tag -f` without `-a` silently downgrades an annotated tag to one.
  test("the tag is annotated, and names the merged SHA explicitly", () => {
    const { gitCalls } = cut()
    const tagged = gitCalls.find((call) => call[0] === "tag" && call[1] === "-a")
    expect(tagged?.[1]).toBe("-a")
    expect(tagged?.[tagged.length - 1]).toBe(MERGED_SHA)
  })

  // THE FAILURE THIS PHASE EXISTS FOR. The PR did not merge, or something else
  // did: the manifest on `main` is not the version being tagged, and a tag whose
  // commit disagrees with it has already shipped here once (v0.1.1 / 0.1.0).
  test("a merged manifest at another version refuses, before any tag", () => {
    const { code, gitCalls, lines } = cut({
      refs: { manifest: `{ "version": "0.4.1" }` },
    })
    expect(code).toBe(1)
    expect(gitCalls.some((call) => call[0] === "tag")).toBe(false)
    expect(gitCalls.some((call) => call[0] === "push")).toBe(false)
    expect(lines.join("\n")).toContain("REFUSING")
    expect(lines.join("\n")).toContain("0.4.1")
  })

  test("a manifest that cannot be parsed is a refusal, not a guess", () => {
    const { code, lines } = cut({ refs: { manifest: "<!DOCTYPE html>" } })
    expect(code).toBe(1)
    expect(lines.join("\n")).toContain("REFUSING")
  })

  // The tag is cut on the tree the releaser is looking at, so `git show`, a
  // local run and the tag cannot disagree — and so the clean-tree check below
  // is checking the tree that is about to be tagged.
  test("a checkout that is not on the merged commit refuses", () => {
    const { code, gitCalls, lines } = cut({ refs: { head: "aaaaaaaabbbbbbbbccccccccdddddddd00000000" } })
    expect(code).toBe(1)
    expect(gitCalls.some((call) => call[0] === "tag")).toBe(false)
    expect(lines.join("\n")).toContain(`git switch ${DEFAULT_BASE}`)
  })

  test("a dirty tree at the merged head refuses", () => {
    const { code, gitCalls, lines } = cut({ porcelain: " M src/main.ts" })
    expect(code).toBe(1)
    expect(gitCalls.some((call) => call[0] === "tag")).toBe(false)
    expect(lines.join("\n")).toContain("REFUSING")
  })

  // Gate 4 runs again HERE because the release PR may have sat open for hours,
  // which is long enough for another agent to push the very tag this is about.
  test("a tag that appeared while the PR was open refuses", () => {
    const { code, gitCalls, lines } = cut({ tags: { remote: [TAG] } })
    expect(code).toBe(1)
    expect(gitCalls.some((call) => call[0] === "tag" && call[1] === "-a")).toBe(false)
    expect(lines.join("\n")).toContain("tag-already-exists")
  })

  test("a tag below one that appeared while the PR was open refuses", () => {
    const { code, lines } = cut({ tags: { remote: ["v0.9.0"] } })
    expect(code).toBe(1)
    expect(lines.join("\n")).toContain("tag-not-highest")
  })

  // A fetch that cannot run must not read as "main has not moved": the whole
  // phase is about comparing against what actually merged.
  test("a fetch that fails stops before anything is read", () => {
    const { code, gitCalls, lines } = cut({ statuses: { fetch: 128 } })
    expect(code).toBe(2)
    expect(gitCalls).toEqual([["fetch", "origin", DEFAULT_BASE]])
    expect(lines.join("\n")).toContain("could not fetch")
  })

  // The local tag exists at this point and nothing downstream has fired, so the
  // message has to name both ways out.
  test("a push that fails says the tag exists locally, and how to undo it", () => {
    const { code, lines } = cut({ statuses: { push: 1 } })
    expect(code).toBe(2)
    expect(lines.join("\n")).toContain("LOCALLY")
    expect(lines.join("\n")).toContain(`git tag -d ${TAG}`)
  })

  test("no tag refuses with the usage", () => {
    const { git } = gitStub(CLEAN)
    const { lines, log } = silent()
    expect(tagRelease({ git, log })).toBe(1)
    expect(lines.join("\n")).toContain("release:tag vX.Y.Z")
  })

  test("`main` routes the tag phase here", () => {
    const { calls: gitCalls, git } = gitStub(CLEAN, {}, { remote: ["v0.4.1"] })
    const { log } = silent()
    expect(main(["tag", TAG], { git, log })).toBe(0)
    expect(gitCalls[0]).toEqual(["fetch", "origin", DEFAULT_BASE])
  })
})

describe("manifestVersion and its objections", () => {
  test("reads a string version, and nothing else", () => {
    expect(manifestVersion(`{"version":"0.4.2"}`)).toBe("0.4.2")
    expect(manifestVersion(`{"version":42}`)).toBeUndefined()
    expect(manifestVersion(`{}`)).toBeUndefined()
    expect(manifestVersion("not json")).toBeUndefined()
  })

  test("the tag and the merged manifest must agree exactly", () => {
    expect(mergedManifestObjection(TAG, `{"version":"0.4.2"}`, "origin/main")).toBeUndefined()
    expect(mergedManifestObjection(TAG, `{"version":"0.4.20"}`, "origin/main")).toContain("REFUSING")
    expect(mergedManifestObjection(TAG, `{"version":"0.4.2"}\n`, "origin/main")).toBeUndefined()
  })

  test("standing anywhere but the merged commit is an objection", () => {
    expect(notOnMergedHeadObjection("abc", "abc", "origin", "main")).toBeUndefined()
    expect(notOnMergedHeadObjection("abc", "def", "origin", "main")).toContain("REFUSING")
  })
})
