import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  type Artifact,
  ARTIFACTS,
  BINDINGS_DIR,
  type BuildRunner,
  collectDrift,
  diffTrees,
  type Drift,
  exitCodeFor,
  type FileTree,
  type GitRunner,
  hashBuiltTree,
  LIB_ARTIFACT,
  listFiles,
  main,
  MAIN_ARTIFACT,
  MAIN_BUILD_ARGV,
  MAIN_BUNDLE,
  preflight,
  readIndexTree,
  realGit,
  REGEN_COMMAND,
  regenCommand,
  renderAnnotation,
  renderReport,
} from "./check-bindings"

// Offline and deterministic: every build and every `git` read is injected, so
// nothing here runs a bundler or touches the repo's real dist/. The parity
// guards are the deliberate exception — they read the real configs and the real
// index, which is the point of them.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

/** No environment objection — the gate under test is drift, not `bun install`. */
const okPreflight = () => undefined

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

/** A stand-in artifact wired to a fake build, keeping the real ids out of unit tests. */
function fakeArtifact(build: BuildRunner, over: Partial<Artifact> = {}): Artifact {
  return { id: BINDINGS_DIR, base: BINDINGS_DIR, script: "build:lib", build, ...over }
}

/** A temp dir with the given `relative path → contents`, removed by the caller. */
function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-bindings-test-"))
  fakeBuild(files)(dir)
  return dir
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

  // The rebuild must be the build. If `build` grows a flag (a --define, a
  // --minify) and the checker's argv does not, the gate compares the committed
  // bundle against a bundle nobody ships.
  test("the bundle rebuild is `bun run build` with only --outdir moved", () => {
    const scripts = readPackageJson().scripts as Record<string, string>
    const outDir = path.posix.dirname(MAIN_BUNDLE)
    expect(scripts.build).toBe(`bun ${MAIN_BUILD_ARGV.join(" ")} --outdir ${outDir}`)
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
})

describe("preflight", () => {
  // `bun build` writes module paths relative to the resolved build root, so a
  // worktree with no node_modules of its own emits `../../../node_modules/...`
  // for byte-identical sources. Reporting that as drift would be a lie whose
  // own fix command commits the wrong bundle.
  test("a checkout without node_modules is a cannot-run naming `bun install`", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "check-bindings-bare-"))
    try {
      expect(preflight(bare)).toContain("bun install")
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })

  test("the real repo passes preflight", () => {
    expect(preflight()).toBeUndefined()
  })

  test("a preflight objection is exit 2, and no build runs", () => {
    let built = false
    const build: BuildRunner = () => {
      built = true
      return { status: 0, output: "" }
    }
    const code = main({
      artifacts: [fakeArtifact(build)],
      preflight: () => "no node_modules",
    })
    expect(code).toBe(2)
    expect(built).toBe(false)
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
  const libDrift: ReadonlyArray<Drift> = [
    { kind: "content-mismatch", file: "supervisor.d.ts", artifact: BINDINGS_DIR },
  ]
  const mainDrift: ReadonlyArray<Drift> = [
    { kind: "content-mismatch", file: "main.js", artifact: MAIN_BUNDLE },
  ]

  test("the report names the stale file and the exact fix command", () => {
    const out = renderReport(libDrift)
    expect(out).toContain(`${BINDINGS_DIR}/supervisor.d.ts`)
    expect(out).toContain(regenCommand(LIB_ARTIFACT))
  })

  // The bundle's fix is a DIFFERENT command; printing the bindings one would
  // send a developer round a loop that never clears the failure.
  test("a stale bundle prints its own build script, not build:lib", () => {
    const out = renderReport(mainDrift)
    expect(out).toContain(MAIN_BUNDLE)
    expect(out).toContain("bun run build && git add -f dist/main.js")
    expect(out).not.toContain("build:lib")
  })

  test("both stale prints both commands", () => {
    const out = renderReport([...libDrift, ...mainDrift])
    expect(out).toContain(regenCommand(LIB_ARTIFACT))
    expect(out).toContain(regenCommand(MAIN_ARTIFACT))
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
    const out = renderReport([])
    expect(out).not.toContain(regenCommand(LIB_ARTIFACT))
    expect(out).not.toContain(regenCommand(MAIN_ARTIFACT))
  })

  test("the annotation is a GitHub error carrying the same commands", () => {
    const line = renderAnnotation([...libDrift, ...mainDrift])
    expect(line.startsWith("::error title=check-bindings::")).toBe(true)
    expect(line).toContain(regenCommand(LIB_ARTIFACT))
    expect(line).toContain(regenCommand(MAIN_ARTIFACT))
    expect(line).toContain("supervisor.d.ts")
    expect(line).toContain(MAIN_BUNDLE)
  })
})

describe("exit codes", () => {
  test("clean is 0, any drift is 1", () => {
    expect(exitCodeFor([])).toBe(0)
    expect(exitCodeFor([{ kind: "orphaned", file: "x.js", artifact: BINDINGS_DIR }])).toBe(1)
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
        preflight: okPreflight,
      }),
    ).toBe(0)
  })

  test("main returns 1 when the index holds a stale blob", () => {
    expect(
      main({
        artifacts: [fakeArtifact(fakeBuild({ "client.js": "new" }))],
        git: splitGit({ "client.js": "0".repeat(40) }),
        preflight: okPreflight,
      }),
    ).toBe(1)
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
        preflight: okPreflight,
      }),
    ).toBe(1)
  })

  // A broken build must never read as "no drift" — that is the silent-green
  // failure the gate exists to remove.
  test("a failed build is exit 2, never a silent pass", () => {
    const failing = fakeArtifact(() => ({ status: 1, output: "tsup exploded" }))
    expect(main({ artifacts: [failing], preflight: okPreflight })).toBe(2)
    expect(() => collectDrift({ artifacts: [failing], preflight: okPreflight })).toThrow(
      "build:lib exited 1",
    )
  })

  test("a git failure is exit 2, never a silent pass", () => {
    expect(
      main({
        artifacts: [fakeArtifact(fakeBuild({ "client.js": "x" }))],
        git: () => ({ status: 128, stdout: "", stderr: "not a git repository" }),
        preflight: okPreflight,
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
      collectDrift({ artifacts, git: noDrift, preflight: okPreflight })
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
    collectDrift({
      artifacts: [probe(BINDINGS_DIR), probe(MAIN_BUNDLE)],
      git: noDrift,
      preflight: okPreflight,
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })
})
