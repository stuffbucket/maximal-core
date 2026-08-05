import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  BINDINGS_DIR,
  type BuildRunner,
  collectDrift,
  diffTrees,
  type Drift,
  exitCodeFor,
  type FileTree,
  type GitRunner,
  hashBuiltTree,
  listFiles,
  main,
  readIndexTree,
  realGit,
  REGEN_COMMAND,
  renderAnnotation,
  renderReport,
} from "./check-bindings"

// Offline and deterministic: the build and every `git` read are injected, so
// nothing here runs tsup or touches the repo's real dist/lib. The two parity
// guards are the deliberate exception — they read the real config and the real
// index, which is the point of them.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

/** A `git` that answers `ls-files -s -z` with the given `path → blob`. */
function fakeIndex(entries: Record<string, string>): GitRunner {
  return (args) => {
    if (args[0] !== "ls-files") return { status: 1, stdout: "", stderr: `unexpected: ${args[0]}` }
    const stdout = Object.entries(entries)
      .map(([file, blob]) => `100644 ${blob} 0\t${BINDINGS_DIR}/${file}\0`)
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
function splitGit(entries: Record<string, string>): GitRunner {
  const index = fakeIndex(entries)
  return (args) => (args[0] === "ls-files" ? index(args) : realGit(args))
}

/** A temp dir with the given `relative path → contents`, removed by the caller. */
function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-bindings-test-"))
  fakeBuild(files)(dir)
  return dir
}

describe("parity with the real build config", () => {
  // If someone repoints tsup's outDir, BINDINGS_DIR and the regen command in
  // every failure message go stale together and the gate silently checks a
  // directory nothing writes to.
  test("BINDINGS_DIR is the outDir tsup.config.ts actually writes", () => {
    const config = fs.readFileSync(path.join(REPO_ROOT, "tsup.config.ts"), "utf8")
    expect(config).toContain(`outDir: "${BINDINGS_DIR}"`)
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
})

describe("reading trees", () => {
  test("readIndexTree keys by path relative to the bindings dir", () => {
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
      { kind: "content-mismatch", file: "client.js" },
    ])
  })

  // The #14 shape: the .d.ts is untouched while the .js behaviour moves. A
  // type-surface-only comparison would call this clean.
  test("a .js-only change is caught even when the .d.ts still matches", () => {
    expect(diffTrees(same, { "client.js": "new-runtime", "client.d.ts": "bbb" })).toEqual([
      { kind: "content-mismatch", file: "client.js" },
    ])
  })

  test("a file the build emits but nobody committed is reported", () => {
    expect(diffTrees(same, { ...same, "chunk-NEW.js": "ccc" })).toEqual([
      { kind: "not-committed", file: "chunk-NEW.js" },
    ])
  })

  // tsup runs with clean:false and content-hashes chunk names, so an edit to
  // shared code renames the chunk and strands the old one in the commit.
  test("a committed file the build no longer emits is reported as orphaned", () => {
    expect(diffTrees({ ...same, "chunk-OLD.js": "ccc" }, same)).toEqual([
      { kind: "orphaned", file: "chunk-OLD.js" },
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
  const drifts: ReadonlyArray<Drift> = [
    { kind: "content-mismatch", file: "supervisor.d.ts" },
  ]

  test("the report names the stale file and the exact fix command", () => {
    const out = renderReport(drifts)
    expect(out).toContain(`${BINDINGS_DIR}/supervisor.d.ts`)
    expect(out).toContain(REGEN_COMMAND)
  })

  // `dist/` is gitignored, so a bare `git add` skips a newly named chunk and
  // the next run fails identically. The `-f` is the whole point of printing a
  // command instead of saying "regenerate the bindings".
  test("the fix command force-adds, because dist/ is gitignored", () => {
    expect(REGEN_COMMAND).toBe(`bun run build:lib && git add -f ${BINDINGS_DIR}`)
  })

  test("a clean report says so and offers no command to run", () => {
    expect(renderReport([])).not.toContain(REGEN_COMMAND)
  })

  test("the annotation is a GitHub error carrying the same command", () => {
    const line = renderAnnotation(drifts)
    expect(line.startsWith("::error title=check-bindings::")).toBe(true)
    expect(line).toContain(REGEN_COMMAND)
    expect(line).toContain("supervisor.d.ts")
  })
})

describe("exit codes", () => {
  test("clean is 0, any drift is 1", () => {
    expect(exitCodeFor([])).toBe(0)
    expect(exitCodeFor([{ kind: "orphaned", file: "x.js" }])).toBe(1)
  })

  test("main returns 0 when the rebuild matches the index", () => {
    // `git hash-object` of "same" — supplied as the index entry so the two
    // sides agree without hardcoding a second hash implementation.
    const dir = makeDir({ "client.js": "same" })
    const blob = hashBuiltTree(realGit, dir)["client.js"]
    fs.rmSync(dir, { recursive: true, force: true })
    expect(
      main({ build: fakeBuild({ "client.js": "same" }), git: splitGit({ "client.js": blob }) }),
    ).toBe(0)
  })

  test("main returns 1 when the index holds a stale blob", () => {
    expect(
      main({
        build: fakeBuild({ "client.js": "new" }),
        git: splitGit({ "client.js": "0".repeat(40) }),
      }),
    ).toBe(1)
  })

  // A broken build must never read as "no drift" — that is the silent-green
  // failure the gate exists to remove.
  test("a failed build is exit 2, never a silent pass", () => {
    const failing: BuildRunner = () => ({ status: 1, output: "tsup exploded" })
    expect(main({ build: failing })).toBe(2)
    expect(() => collectDrift({ build: failing })).toThrow("build:lib exited 1")
  })

  test("a git failure is exit 2, never a silent pass", () => {
    expect(
      main({
        build: fakeBuild({ "client.js": "x" }),
        git: () => ({ status: 128, stdout: "", stderr: "not a git repository" }),
      }),
    ).toBe(2)
  })
})

describe("the repo tree is never touched", () => {
  const noDrift: GitRunner = () => ({ status: 0, stdout: "", stderr: "" })

  test("collectDrift removes the scratch dir it created", () => {
    let seen = ""
    collectDrift({
      git: noDrift,
      build: (outDir) => {
        seen = outDir
        return { status: 0, output: "" }
      },
    })
    expect(seen.startsWith(os.tmpdir())).toBe(true)
    expect(fs.existsSync(seen)).toBe(false)
  })

  test("the scratch dir is removed even when the build fails", () => {
    let seen = ""
    expect(() =>
      collectDrift({
        git: noDrift,
        build: (outDir) => {
          seen = outDir
          return { status: 1, output: "boom" }
        },
      }),
    ).toThrow()
    expect(fs.existsSync(seen)).toBe(false)
  })

  // The check has to survive `typecheck:downstream`, which rebuilds dist/lib
  // in place before this runs in both ci.yml and check:deep. Reading the index
  // is what makes that harmless — nothing here may read dist/lib from disk.
  test("the scratch dir is outside the repo, so no step ever sees it", () => {
    let seen = ""
    collectDrift({
      git: noDrift,
      build: (outDir) => {
        seen = outDir
        return { status: 0, output: "" }
      },
    })
    expect(seen.startsWith(REPO_ROOT)).toBe(false)
  })
})
