import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  type Artifact,
  ARTIFACTS,
  BINDINGS_DIR,
  type Blocked,
  type BuildRunner,
  BUN_VERSION_FILE,
  type CheckResult,
  collectDrift,
  diffTrees,
  type Drift,
  exitCodeFor,
  type FileTree,
  firstObjection,
  type GitRunner,
  hashBuiltTree,
  LIB_ARTIFACT,
  listFiles,
  main,
  MAIN_ARTIFACT,
  MAIN_BUNDLE,
  needsNodeModules,
  needsPinnedBun,
  pinnedBunVersion,
  readIndexTree,
  realGit,
  REGEN_COMMAND,
  regenCommand,
  renderAnnotation,
  renderReport,
  runningBunVersion,
} from "./check-bindings"
import { BUILD_COMMAND, OUT_DIR as BUILD_OUT_DIR } from "./build-bundle"

// Offline and deterministic: every build and every `git` read is injected, so
// nothing here runs a bundler or touches the repo's real dist/. The parity
// guards are the deliberate exception — they read the real configs and the real
// index, which is the point of them.
//
// Nothing here may assert on the AMBIENT environment. release-gates.yml's
// `gate` job runs `check:ops` with no `bun install`, on purpose, so a test that
// asserted "this checkout has node_modules" failed there and nowhere else.
// Requirements are tested against temp roots and injected versions instead.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

/** No environment objection — the gate under test is drift, not the toolchain. */
const noRequirements: ReadonlyArray<never> = []

/** A `git` that answers `ls-files -s -z` with the given `path → blob`. */
function fakeIndex(entries: Record<string, string>, base = BINDINGS_DIR): GitRunner {
  return (args) => {
    if (args[0] !== "ls-files") return { status: 1, stdout: "", stderr: `unexpected: ${args[0]}` }
    const stdout = Object.entries(entries)
      .map(([file, blob]) => `100644 ${blob} 0\t${base}/${file}\0`)
      .join("")
    return { status: 0, stdout, stderr: "" }
  }
}

/** A build that materialises `files` into whatever outDir it is handed. */
function fakeBuild(files: Record<string, string>): BuildRunner {
  return (outDir) => {
    fs.mkdirSync(outDir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(outDir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    return { status: 0, output: "" }
  }
}

/** Index reads faked, `hash-object` delegated to the real git. */
function splitGit(entries: Record<string, string>, base = BINDINGS_DIR): GitRunner {
  const index = fakeIndex(entries, base)
  return (args) => (args[0] === "ls-files" ? index(args) : realGit(args))
}

/** A stand-in artifact wired to a fake build and no environment requirements. */
function fakeArtifact(build: BuildRunner, over: Partial<Artifact> = {}): Artifact {
  return {
    id: BINDINGS_DIR,
    base: BINDINGS_DIR,
    script: "build:lib",
    build,
    requires: noRequirements,
    ...over,
  }
}

/** A temp dir with the given `relative path → contents`, removed by the caller. */
function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-bindings-test-"))
  fakeBuild(files)(dir)
  return dir
}

/** A scratch repo root, optionally with a `node_modules` and a `.bun-version`. */
function makeRoot(
  opts: { nodeModules?: boolean, emptyNodeModules?: boolean, bunVersion?: string } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-bindings-root-"))
  // `.bin`, not the bare directory: an empty `node_modules` is not an install,
  // and Bun resolves upward past one. See `needsNodeModules`.
  if (opts.nodeModules === true) {
    fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true })
  }
  if (opts.emptyNodeModules === true) fs.mkdirSync(path.join(dir, "node_modules"))
  if (opts.bunVersion !== undefined) {
    fs.writeFileSync(path.join(dir, BUN_VERSION_FILE), `${opts.bunVersion}\n`)
  }
  return dir
}

function result(over: Partial<CheckResult> = {}): CheckResult {
  return { drifts: [], blocked: [], ...over }
}

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Record<
    string,
    unknown
  >
}

describe("parity with the real build config", () => {
  // If someone repoints tsup's outDir, BINDINGS_DIR and the regen command in
  // every failure message go stale together and the gate silently checks a
  // directory nothing writes to.
  test("BINDINGS_DIR is the outDir tsup.config.ts actually writes", () => {
    const config = fs.readFileSync(path.join(REPO_ROOT, "tsup.config.ts"), "utf8")
    expect(config).toContain(`outDir: "${BINDINGS_DIR}"`)
  })

  // The same failure for the bundle: the gate is only worth anything if the
  // file it checks is the file `bin` ships. Repointing `bin` without updating
  // MAIN_BUNDLE would leave a covered file nobody runs and a shipped file
  // nobody checks.
  test("MAIN_BUNDLE is what package.json's `bin` actually ships", () => {
    const bin = readPackageJson().bin as Record<string, string>
    expect(bin.maximal).toBe(`./${MAIN_BUNDLE}`)
  })

  // The rebuild must be the build. It used to be asserted textually, because
  // `build` was an inline `bun build …` that this file restated as
  // MAIN_BUILD_ARGV. `build` is now a script — an inline one could not carry a
  // pin guard — and both sides call the SAME `realMainBuild`, so the argv
  // parity is structural. What is left to assert is that `build` still routes
  // through that script and still writes where the committed bundle lives.
  test("`build` is the guarded script, writing where `bin` ships", () => {
    const scripts = readPackageJson().scripts as Record<string, string>
    expect(scripts.build).toBe(BUILD_COMMAND)
    expect(BUILD_OUT_DIR).toBe(path.posix.dirname(MAIN_BUNDLE))
  })

  // The pin is the whole basis of the bundle's reproducibility, so the file has
  // to exist and read as a bare version. It is tracked, so this holds with no
  // install — which the `gate` job relies on.
  test("the real .bun-version parses as a bare version", () => {
    expect(pinnedBunVersion()).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  // The real `git ls-files -s -z` output shape, parsed by the real parser. A
  // git version that changed it would otherwise leave the gate reading an
  // empty index — which looks exactly like "everything is orphaned", but only
  // in CI.
  test("the real index actually yields the committed bindings", () => {
    const tree = readIndexTree(realGit)
    expect(Object.keys(tree)).toContain("supervisor.d.ts")
    expect(Object.keys(tree)).toContain("supervisor.js")
    for (const blob of Object.values(tree)) expect(blob).toMatch(/^[0-9a-f]{40,64}$/u)
  })

  // A single-file artifact relativises against its PARENT, so the index entry
  // `dist/main.js` keys as `main.js` and lines up with a scratch outDir.
  test("the real index yields the committed bundle, keyed by basename", () => {
    const tree = readIndexTree(realGit, MAIN_ARTIFACT.id, MAIN_ARTIFACT.base)
    expect(Object.keys(tree)).toEqual(["main.js"])
    expect(tree["main.js"]).toMatch(/^[0-9a-f]{40,64}$/u)
  })

  test("both committed artifacts are covered", () => {
    expect(ARTIFACTS.map((a) => a.id)).toEqual([BINDINGS_DIR, MAIN_BUNDLE])
  })

  // The measured asymmetry, encoded: tsup bundles with esbuild (pinned in
  // package.json) and is Bun-version-independent; `bun build` bundles with
  // Bun's own bundler and is not. Wiring the pin check onto the wrong artifact
  // would either under-protect the bundle or needlessly block the bindings.
  test("only the bun-bundled artifact requires the pinned Bun", () => {
    expect(LIB_ARTIFACT.requires).toContain(needsNodeModules)
    expect(LIB_ARTIFACT.requires).not.toContain(needsPinnedBun)
    expect(MAIN_ARTIFACT.requires).toContain(needsNodeModules)
    expect(MAIN_ARTIFACT.requires).toContain(needsPinnedBun)
  })
})

describe("environment requirements", () => {
  // `bun build` writes module paths relative to the resolved build root, so a
  // worktree with no node_modules of its own emits `../../../node_modules/...`
  // for byte-identical sources. Reporting that as drift would be a lie whose
  // own fix command commits the wrong bundle.
  test("a checkout without node_modules objects, naming `bun install`", () => {
    const root = makeRoot()
    try {
      expect(needsNodeModules(root)).toContain("bun install")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // The hole this closed. A linked worktree driven through `container:run`
  // acquires an EMPTY `node_modules` — docker creates the bind-mount target on
  // the host — and Bun then resolves upward to the parent checkout anyway. An
  // existence check passed, and the bundle came out with
  // `../../../node_modules/...` banner comments: 21 lines of difference for
  // byte-identical sources, reported as staleness.
  test("an EMPTY node_modules objects too — existing is not installed", () => {
    const root = makeRoot({ emptyNodeModules: true })
    try {
      expect(needsNodeModules(root)).toContain("bun install")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a checkout with node_modules does not object", () => {
    const root = makeRoot({ nodeModules: true })
    try {
      expect(needsNodeModules(root)).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // The finding this gate surfaced: `bun build` bundles with Bun's own bundler,
  // so an unpinned Bun produces a bundle CI cannot reproduce. Measured on a 2x2
  // of {ubuntu, macos} x {1.3.11, 1.3.14}: the OS made no difference, the
  // version made all of it.
  test("a Bun that differs from the pin objects, and names the switch command", () => {
    expect(runningBunVersion()).toBeDefined()
    const root = makeRoot({ bunVersion: "0.0.0-not-your-bun" })
    try {
      const objection = needsPinnedBun(root)
      expect(objection).toContain("0.0.0-not-your-bun")
      expect(objection).toContain("bash -s bun-v0.0.0-not-your-bun")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // The rule the whole design turns on. If this ever reads as staleness, the
  // printed fix has a developer commit bytes built by the wrong toolchain,
  // which does not fix CI — it makes CI wrong the other way.
  test("a version objection says it is NOT a staleness report", () => {
    const root = makeRoot({ bunVersion: "0.0.0-not-your-bun" })
    try {
      expect(needsPinnedBun(root)).toContain("not a staleness report")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a Bun that matches the pin does not object", () => {
    const running = runningBunVersion()
    expect(running).toBeDefined()
    const root = makeRoot({ bunVersion: running as string })
    try {
      expect(needsPinnedBun(root)).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("an unreadable .bun-version is an objection, not a crash", () => {
    const root = makeRoot()
    try {
      expect(needsPinnedBun(root)).toContain(BUN_VERSION_FILE)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("firstObjection returns the first and stops", () => {
    const calls: Array<string> = []
    const objection = firstObjection([
      () => {
        calls.push("a")
        return undefined
      },
      () => {
        calls.push("b")
        return "b objects"
      },
      () => {
        calls.push("c")
        return "c objects"
      },
    ])
    expect(objection).toBe("b objects")
    expect(calls).toEqual(["a", "b"])
  })

  test("no requirements means no objection", () => {
    expect(firstObjection([])).toBeUndefined()
  })
})

describe("reading trees", () => {
  test("readIndexTree keys by path relative to the artifact base", () => {
    expect(readIndexTree(fakeIndex({ "client.js": "aaa", "n/b.d.ts": "bbb" }))).toEqual({
      "client.js": "aaa",
      "n/b.d.ts": "bbb",
    })
  })

  test("an empty index is an empty tree, not a throw", () => {
    expect(readIndexTree(() => ({ status: 0, stdout: "", stderr: "" }))).toEqual({})
  })

  test("a failing git read throws rather than reading as no drift", () => {
    expect(() =>
      readIndexTree(() => ({ status: 128, stdout: "", stderr: "not a git repository" })),
    ).toThrow("not a git repository")
  })

  test("listFiles walks recursively and sorts", () => {
    const dir = makeDir({ "z.js": "1", "a.js": "2", "n/b.d.ts": "3" })
    try {
      expect(listFiles(dir)).toEqual(["a.js", "n/b.d.ts", "z.js"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a missing directory lists as empty", () => {
    expect(listFiles(path.join(os.tmpdir(), "check-bindings-does-not-exist"))).toEqual([])
  })

  // Both sides must be the same kind of id or every file reads as changed.
  test("hashBuiltTree produces git blob ids, matching what the index stores", () => {
    const dir = makeDir({ "a.js": "hello\n" })
    try {
      const tree = hashBuiltTree(realGit, dir)
      // `echo hello | git hash-object --stdin`
      expect(tree["a.js"]).toBe("ce013625030ba8dba906f756967f9e9ca394464a")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("hashBuiltTree skips the git call entirely for an empty build", () => {
    expect(
      hashBuiltTree(() => {
        throw new Error("git should not have been called")
      }, path.join(os.tmpdir(), "check-bindings-does-not-exist")),
    ).toEqual({})
  })
})

describe("diffTrees", () => {
  const same: FileTree = { "client.js": "aaa", "client.d.ts": "bbb" }

  test("an identical tree has no drift", () => {
    expect(diffTrees(same, { ...same })).toEqual([])
  })

  test("changed content is a content-mismatch", () => {
    expect(diffTrees(same, { ...same, "client.js": "zzz" })).toEqual([
      { kind: "content-mismatch", file: "client.js", artifact: BINDINGS_DIR },
    ])
  })

  // The #14 shape: the .d.ts is untouched while the .js behaviour moves. A
  // type-surface-only comparison would call this clean.
  test("a .js-only change is caught even when the .d.ts still matches", () => {
    expect(diffTrees(same, { "client.js": "new-runtime", "client.d.ts": "bbb" })).toEqual([
      { kind: "content-mismatch", file: "client.js", artifact: BINDINGS_DIR },
    ])
  })

  test("a file the build emits but nobody committed is reported", () => {
    expect(diffTrees(same, { ...same, "chunk-NEW.js": "ccc" })).toEqual([
      { kind: "not-committed", file: "chunk-NEW.js", artifact: BINDINGS_DIR },
    ])
  })

  // tsup runs with clean:false and content-hashes chunk names, so an edit to
  // shared code renames the chunk and strands the old one in the commit.
  test("a committed file the build no longer emits is reported as orphaned", () => {
    expect(diffTrees({ ...same, "chunk-OLD.js": "ccc" }, same)).toEqual([
      { kind: "orphaned", file: "chunk-OLD.js", artifact: BINDINGS_DIR },
    ])
  })

  test("findings carry the artifact they belong to, so the fix command can differ", () => {
    expect(diffTrees({ "main.js": "old" }, { "main.js": "new" }, MAIN_BUNDLE)).toEqual([
      { kind: "content-mismatch", file: "main.js", artifact: MAIN_BUNDLE },
    ])
  })

  test("findings are sorted by filename, so the report is stable", () => {
    const drifts = diffTrees(
      { "z.js": "1", "a.js": "1", "m.js": "1" },
      { "z.js": "2", "a.js": "2", "m.js": "2" },
    )
    expect(drifts.map((d) => d.file)).toEqual(["a.js", "m.js", "z.js"])
  })
})

describe("rendering", () => {
  const libDrift: Drift = {
    kind: "content-mismatch",
    file: "supervisor.d.ts",
    artifact: BINDINGS_DIR,
  }
  const mainDrift: Drift = { kind: "content-mismatch", file: "main.js", artifact: MAIN_BUNDLE }
  const blockedMain: Blocked = { artifact: MAIN_BUNDLE, reason: "Bun 9.9.9 is bundling" }

  test("the report names the stale file and the exact fix command", () => {
    const out = renderReport(result({ drifts: [libDrift] }))
    expect(out).toContain(`${BINDINGS_DIR}/supervisor.d.ts`)
    expect(out).toContain(regenCommand(LIB_ARTIFACT))
  })

  // The bundle's fix is a DIFFERENT command; printing the bindings one would
  // send a developer round a loop that never clears the failure.
  test("a stale bundle prints its own build script, not build:lib", () => {
    const out = renderReport(result({ drifts: [mainDrift] }))
    expect(out).toContain(MAIN_BUNDLE)
    expect(out).toContain("bun run build && git add -f dist/main.js")
    expect(out).not.toContain("build:lib")
  })

  test("both stale prints both commands", () => {
    const out = renderReport(result({ drifts: [libDrift, mainDrift] }))
    expect(out).toContain(regenCommand(LIB_ARTIFACT))
    expect(out).toContain(regenCommand(MAIN_ARTIFACT))
  })

  // A blocked artifact must never be handed a regen command — that command is
  // exactly the wrong thing to run when the toolchain is the problem.
  test("a blocked artifact is reported as unverifiable, with no regen command", () => {
    const out = renderReport(result({ blocked: [blockedMain] }))
    expect(out).toContain("could NOT be verified")
    expect(out).toContain("Bun 9.9.9 is bundling")
    expect(out).not.toContain(regenCommand(MAIN_ARTIFACT))
  })

  // The mixed case a developer on an unpinned Bun actually sees: the bindings
  // were checked and are stale, the bundle could not be judged at all.
  test("drift and blocked are both reported when they co-occur", () => {
    const out = renderReport(result({ drifts: [libDrift], blocked: [blockedMain] }))
    expect(out).toContain(regenCommand(LIB_ARTIFACT))
    expect(out).toContain("could NOT be verified")
  })

  // `dist/` is gitignored, so a bare `git add` skips a newly named chunk and
  // the next run fails identically. The `-f` is the whole point of printing a
  // command instead of saying "regenerate the bindings".
  test("every fix command force-adds, because dist/ is gitignored", () => {
    expect(REGEN_COMMAND).toBe(`bun run build:lib && git add -f ${BINDINGS_DIR}`)
    for (const artifact of ARTIFACTS) {
      expect(regenCommand(artifact)).toBe(`bun run ${artifact.script} && git add -f ${artifact.id}`)
    }
  })

  test("a clean report says so and offers no command to run", () => {
    const out = renderReport(result())
    expect(out).not.toContain(regenCommand(LIB_ARTIFACT))
    expect(out).not.toContain(regenCommand(MAIN_ARTIFACT))
    expect(out).toContain("match a fresh build")
  })

  test("the annotation is a GitHub error carrying the same commands", () => {
    const line = renderAnnotation(result({ drifts: [libDrift, mainDrift] }))
    expect(line?.startsWith("::error title=check-bindings::")).toBe(true)
    expect(line).toContain(regenCommand(LIB_ARTIFACT))
    expect(line).toContain(regenCommand(MAIN_ARTIFACT))
    expect(line).toContain("supervisor.d.ts")
    expect(line).toContain(MAIN_BUNDLE)
  })

  // A blocked run must not annotate "stale" onto the Checks tab — that is the
  // one line a reviewer reads, and it would be false.
  test("a blocked annotation says unverifiable, not stale", () => {
    const line = renderAnnotation(result({ blocked: [blockedMain] }))
    expect(line).toContain("could not verify")
    expect(line).not.toContain("is stale")
  })

  test("a clean run has no annotation at all", () => {
    expect(renderAnnotation(result())).toBeUndefined()
  })
})

describe("exit codes", () => {
  test("clean is 0, drift is 1, blocked is 2", () => {
    expect(exitCodeFor(result())).toBe(0)
    expect(
      exitCodeFor(result({ drifts: [{ kind: "orphaned", file: "x.js", artifact: BINDINGS_DIR }] })),
    ).toBe(1)
    expect(exitCodeFor(result({ blocked: [{ artifact: MAIN_BUNDLE, reason: "no" }] }))).toBe(2)
  })

  // The silent-pass this replaces: if an artifact could not be judged, a clean
  // result for the OTHER one must not be reported as success.
  test("blocked outranks a clean run and a drifting one alike", () => {
    const blocked = [{ artifact: MAIN_BUNDLE, reason: "no" }]
    expect(exitCodeFor(result({ blocked }))).toBe(2)
    expect(
      exitCodeFor(
        result({ blocked, drifts: [{ kind: "orphaned", file: "x.js", artifact: BINDINGS_DIR }] }),
      ),
    ).toBe(2)
  })

  test("main returns 0 when the rebuild matches the index", () => {
    // `git hash-object` of "same" — supplied as the index entry so the two
    // sides agree without hardcoding a second hash implementation.
    const dir = makeDir({ "client.js": "same" })
    const blob = hashBuiltTree(realGit, dir)["client.js"]
    fs.rmSync(dir, { recursive: true, force: true })
    expect(
      main({
        artifacts: [fakeArtifact(fakeBuild({ "client.js": "same" }))],
        git: splitGit({ "client.js": blob }),
        annotate: false,
      }),
    ).toBe(0)
  })

  test("main returns 1 when the index holds a stale blob", () => {
    expect(
      main({
        artifacts: [fakeArtifact(fakeBuild({ "client.js": "new" }))],
        git: splitGit({ "client.js": "0".repeat(40) }),
        annotate: false,
      }),
    ).toBe(1)
  })

  // Both directions. `annotate: false` on every other test proves a fixture run
  // cannot paint a passing job; without this pair the production annotation
  // could stop firing and nobody would notice until a gate failed quietly.
  test("annotate: true emits the ::error — the real CI path still annotates", () => {
    const lines: Array<string> = []
    main({
      artifacts: [fakeArtifact(fakeBuild({ "client.js": "new" }))],
      git: splitGit({ "client.js": "0".repeat(40) }),
      annotate: true,
      log: (line) => lines.push(line),
    })
    expect(lines.some((l) => l.startsWith("::error title=check-bindings::"))).toBe(
      true,
    )
  })

  test("annotate: false emits the report but no ::error", () => {
    const lines: Array<string> = []
    main({
      artifacts: [fakeArtifact(fakeBuild({ "client.js": "new" }))],
      git: splitGit({ "client.js": "0".repeat(40) }),
      annotate: false,
      log: (line) => lines.push(line),
    })
    expect(lines.some((l) => l.includes("client.js"))).toBe(true)
    expect(lines.some((l) => l.startsWith("::"))).toBe(false)
  })

  // A stale bundle must fail even when the bindings are pristine — that is the
  // whole hole this gate grew to cover.
  test("a stale bundle alone is exit 1", () => {
    const bundle = fakeArtifact(fakeBuild({ "main.js": "new" }), {
      id: MAIN_BUNDLE,
      base: "dist",
      script: "build",
    })
    expect(
      main({
        artifacts: [bundle],
        git: splitGit({ "main.js": "0".repeat(40) }, "dist"),
        annotate: false,
      }),
    ).toBe(1)
  })

  test("an unmet requirement is exit 2, and that artifact never builds", () => {
    let built = false
    const build: BuildRunner = () => {
      built = true
      return { status: 0, output: "" }
    }
    const code = main({
      artifacts: [fakeArtifact(build, { requires: [() => "toolchain differs"] })],
      annotate: false,
    })
    expect(code).toBe(2)
    expect(built).toBe(false)
  })

  // The mixed case end to end: one artifact verified clean, one blocked. If the
  // blocked one were dropped this would be a green run that checked half.
  test("one artifact blocked and one clean is still exit 2", () => {
    const dir = makeDir({ "client.js": "same" })
    const blob = hashBuiltTree(realGit, dir)["client.js"]
    fs.rmSync(dir, { recursive: true, force: true })
    expect(
      main({
        artifacts: [
          fakeArtifact(fakeBuild({ "client.js": "same" })),
          fakeArtifact(fakeBuild({ "main.js": "x" }), {
            id: MAIN_BUNDLE,
            base: "dist",
            script: "build",
            requires: [() => "Bun differs from the pin"],
          }),
        ],
        git: splitGit({ "client.js": blob }),
        annotate: false,
      }),
    ).toBe(2)
  })

  // A broken build must never read as "no drift" — that is the silent-green
  // failure the gate exists to remove.
  test("a failed build is exit 2, never a silent pass", () => {
    const failing = fakeArtifact(() => ({ status: 1, output: "tsup exploded" }))
    expect(main({ artifacts: [failing], annotate: false })).toBe(2)
    expect(() => collectDrift({ artifacts: [failing] })).toThrow("build:lib exited 1")
  })

  test("a git failure is exit 2, never a silent pass", () => {
    expect(
      main({
        artifacts: [fakeArtifact(fakeBuild({ "client.js": "x" }))],
        git: () => ({ status: 128, stdout: "", stderr: "not a git repository" }),
        annotate: false,
      }),
    ).toBe(2)
  })
})

describe("the repo tree is never touched", () => {
  const noDrift: GitRunner = () => ({ status: 0, stdout: "", stderr: "" })

  function seenOutDir(status: number): string {
    let seen = ""
    const artifacts = [
      fakeArtifact((outDir) => {
        seen = outDir
        return { status, output: "boom" }
      }),
    ]
    try {
      collectDrift({ artifacts, git: noDrift })
    } catch {
      // a failing build is the point of the second case
    }
    return seen
  }

  test("collectDrift removes the scratch dir it created", () => {
    const seen = seenOutDir(0)
    expect(seen.startsWith(os.tmpdir())).toBe(true)
    expect(fs.existsSync(seen)).toBe(false)
  })

  test("the scratch dir is removed even when the build fails", () => {
    const seen = seenOutDir(1)
    expect(seen).not.toBe("")
    expect(fs.existsSync(seen)).toBe(false)
  })

  // The check has to survive `typecheck:downstream` (which rebuilds dist/lib)
  // and `bun run build` (which rewrites dist/main.js), both of which run BEFORE
  // this in ci.yml and check:deep. Reading the index is what makes that
  // harmless — nothing here may read dist/ from disk.
  test("the scratch dir is outside the repo, so no step ever sees it", () => {
    expect(seenOutDir(0).startsWith(REPO_ROOT)).toBe(false)
  })

  // Two artifacts, two scratch dirs: sharing one would let tsup's clean:false
  // output leak into the bundle's file set and read as `not-committed`.
  test("each artifact gets its own scratch dir", () => {
    const seen: Array<string> = []
    const probe = (id: string): Artifact =>
      fakeArtifact((outDir) => {
        seen.push(outDir)
        return { status: 0, output: "" }
      }, { id })
    collectDrift({ artifacts: [probe(BINDINGS_DIR), probe(MAIN_BUNDLE)], git: noDrift })
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })

  // A blocked artifact must not even create a scratch dir, let alone build.
  test("a blocked artifact creates no scratch dir", () => {
    let called = false
    collectDrift({
      artifacts: [
        fakeArtifact(() => {
          called = true
          return { status: 0, output: "" }
        }, { requires: [() => "nope"] }),
      ],
      git: noDrift,
    })
    expect(called).toBe(false)
  })
})
