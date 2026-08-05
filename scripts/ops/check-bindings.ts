#!/usr/bin/env bun
/**
 * Committed-bindings freshness gate — `dist/lib` must equal what `build:lib`
 * emits from the current `src/`.
 *
 * `dist/lib/*.js` and `*.d.ts` are force-tracked against the `dist/` entry in
 * `.gitignore` so a git-dependency install (`bun add
 * github:stuffbucket/maximal-core`) resolves the `exports` map without running
 * a build. That makes them GENERATED FILES THAT ARE ALSO SOURCE OF TRUTH for
 * every consumer, and nothing checked the two halves agreed. PR #14 changed
 * `src/lib/live/supervisor.ts`, nothing regenerated `dist/lib`, and `main`
 * published new runtime behaviour behind the old `{ port, pid }` declaration:
 * a downstream `const { port } = await awaitReadyLine(...)` typechecked clean
 * and was `undefined` at runtime. Fixed by hand in #19; this is the check that
 * would have caught it in #14.
 *
 * WHY BYTES, NOT THE TYPE SURFACE. A type-surface comparison (extract the
 * declarations, compare structurally) tolerates cosmetic tsup churn, but it is
 * blind to exactly the half of #14 that broke: the `.js` runtime behaviour
 * changed while the `.d.ts` did not. Both files ship, so both are checked. The
 * cost of byte equality is false positives from a nondeterministic bundler —
 * measured here rather than assumed: consecutive rebuilds, rebuilds from a
 * different checkout path, and rebuilds into an out-of-tree directory are all
 * byte-identical, and the output embeds no path, timestamp, or machine name.
 * If tsup ever does start emitting churn, the failure mode is a loud diff on
 * an unrelated PR, not a silent miss.
 *
 * THE REBUILD GOES TO A TEMP DIR, never over `dist/`. `build:lib` rewrites the
 * tree in place, so checking by "rebuild, then `git diff`" would leave later
 * steps (and a developer's working tree) dirty on the failure path and would
 * destroy the evidence it just found. Building elsewhere keeps the check
 * read-only with respect to the repo.
 *
 * THE COMMITTED SIDE IS READ FROM GIT'S INDEX, not from `dist/lib` on disk.
 * That is not paranoia: `typecheck:downstream` runs tsup into `dist/lib` as its
 * first step, and it runs BEFORE this check in both `ci.yml` and `check:deep`.
 * A working-tree comparison would therefore be diffing a rebuild against a
 * rebuild — permanently, silently green. Reading `git ls-files -s` makes the
 * check independent of anything that touches the working copy, and it compares
 * what will actually be committed and shipped, which is the thing that broke.
 *
 * File-set differences count, in both directions: `tsup` runs with
 * `clean: false` and names shared chunks by content hash
 * (`chunk-ITKEMUH2.js`), so an edit to shared code renames the chunk and
 * leaves the old one behind as a committed orphan that no entry imports.
 *
 * The same force-tracking is why `lint-staged`'s glob is `!dist/**` rather than
 * `*`: lint-staged re-stages the files a task touched with a plain `git add`,
 * which refuses an ignored path and aborts the whole hook with
 * `paths are ignored`. Nothing in `dist/` is lintable anyway (ESLint already
 * ignores it), so excluding it there costs no coverage.
 *
 * Usage:
 *   bun run bindings:check
 *
 * Exit codes: 0 fresh · 1 stale (the blocking finding) · 2 the check could not
 * run (the build or a `git` read failed). Both non-zero codes fail CI; they are
 * distinct only so a failure reads as "your bindings are stale" or "the check
 * broke" without reading the log.
 *
 * The build and `git` are the only I/O and each goes through one injectable
 * runner, mirroring `release-notes.ts`'s `GhRunner`, so every test runs offline
 * without invoking tsup or touching a repository.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Repo root resolved from this file, so the check works from any cwd. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

/** Repo-relative home of the committed bindings. Parity-tested against tsup's `outDir`. */
export const BINDINGS_DIR = "dist/lib"

/**
 * The one command a developer runs to fix a failure, printed verbatim in the
 * report. `-f` is not optional: `dist/` is in `.gitignore`, so a NEW file (a
 * renamed content-hash chunk) is silently skipped by a bare `git add`.
 */
export const REGEN_COMMAND = `bun run build:lib && git add -f ${BINDINGS_DIR}`

// --- git seam ---

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** Runs `git` with the given argv. The single seam every repository read passes. */
export type GitRunner = (args: ReadonlyArray<string>) => RunResult

export const realGit: GitRunner = (args) => {
  const res = spawnSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.error) {
    return { status: 127, stdout: "", stderr: `could not run \`git\`: ${res.error.message}` }
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

function git(runner: GitRunner, args: ReadonlyArray<string>): string {
  const res = runner(args)
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} → exit ${res.status}: ${res.stderr.trim() || "(no stderr)"}`,
    )
  }
  return res.stdout
}

// --- trees ---

/** Path relative to `BINDINGS_DIR` → the file's git blob id. */
export type FileTree = Readonly<Record<string, string>>

/**
 * What git has recorded for `BINDINGS_DIR` — the INDEX, so a developer who has
 * already run the fix command and staged the result reads as fixed, and so a
 * step that rebuilt `dist/lib` on disk cannot launder the answer.
 *
 * An empty result is an empty tree, not an error: "the bindings were deleted"
 * is drift to report, not a crash.
 */
export function readIndexTree(runner: GitRunner, dir = BINDINGS_DIR): FileTree {
  // `-z` because a path is bytes, not a line. Each record is
  // `<mode> <blob> <stage>\t<path>`.
  const out = git(runner, ["ls-files", "-s", "-z", "--", dir])
  const tree: Record<string, string> = {}
  for (const record of out.split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    if (tab < 0) continue
    const blob = record.slice(0, tab).split(" ")[1]
    const file = path.posix.relative(dir, record.slice(tab + 1))
    if (blob) tree[file] = blob
  }
  return tree
}

/** Every file under `dir`, as paths relative to `dir`, sorted. */
export function listFiles(dir: string): Array<string> {
  const files: Array<string> = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel)
      else if (entry.isFile()) files.push(rel)
    }
  }
  if (fs.existsSync(dir)) walk(dir, "")
  return files.sort()
}

/**
 * Blob ids for a freshly built tree, computed by git itself so both sides of
 * the comparison speak the same hash (and the same object format, whatever the
 * repo uses). `--no-filters` hashes the raw bytes: the rebuild lives outside
 * the repo where no gitattributes apply, and on a `core.autocrlf=true` checkout
 * raw bytes are what the index holds anyway.
 */
export function hashBuiltTree(runner: GitRunner, dir: string): FileTree {
  const files = listFiles(dir)
  if (files.length === 0) return {}
  const out = git(runner, [
    "hash-object",
    "--no-filters",
    "--",
    ...files.map((f) => path.join(dir, f)),
  ])
  const blobs = out.split("\n").filter(Boolean)
  if (blobs.length !== files.length) {
    throw new Error(
      `git hash-object returned ${blobs.length} ids for ${files.length} files`,
    )
  }
  return Object.fromEntries(files.map((file, i) => [file, blobs[i]]))
}

// --- findings ---

export type DriftKind = "content-mismatch" | "not-committed" | "orphaned"

export interface Drift {
  kind: DriftKind
  /** Path relative to `BINDINGS_DIR`. */
  file: string
}

const KIND_LABEL: Record<DriftKind, string> = {
  "content-mismatch": "differs from the rebuild",
  "not-committed": "emitted by the build but not committed",
  orphaned: "committed but no longer emitted by the build",
}

/**
 * Every way the committed tree can disagree with a fresh build. Pure. Sorted
 * by filename so the report is stable and reviewable in a diff.
 */
export function diffTrees(committed: FileTree, rebuilt: FileTree): Array<Drift> {
  const files = [
    ...new Set([...Object.keys(committed), ...Object.keys(rebuilt)]),
  ].sort()
  const drifts: Array<Drift> = []
  for (const file of files) {
    const before = committed[file]
    const after = rebuilt[file]
    if (before === undefined) drifts.push({ kind: "not-committed", file })
    else if (after === undefined) drifts.push({ kind: "orphaned", file })
    else if (before !== after) drifts.push({ kind: "content-mismatch", file })
  }
  return drifts
}

export function exitCodeFor(drifts: ReadonlyArray<Drift>): number {
  return drifts.length > 0 ? 1 : 0
}

// --- rendering ---

export function renderReport(drifts: ReadonlyArray<Drift>): string {
  if (drifts.length === 0) {
    return `check-bindings: ${BINDINGS_DIR} matches a fresh \`build:lib\`.`
  }
  const lines = [
    `check-bindings: ${BINDINGS_DIR} is STALE — ${drifts.length} file(s) disagree with a fresh \`build:lib\`:`,
    "",
  ]
  for (const d of drifts) {
    lines.push(`  ${BINDINGS_DIR}/${d.file} — ${KIND_LABEL[d.kind]}`)
  }
  lines.push(
    "",
    "These files are committed so a git-dependency install gets types without a",
    "build, which means a consumer compiles against them. Stale ones publish new",
    "runtime behaviour behind an old declaration (see maximal-core#14/#19).",
    "",
    "Fix it by regenerating and staging them:",
    "",
    `    ${REGEN_COMMAND}`,
    "",
  )
  return lines.join("\n")
}

/** GitHub Actions annotation, so the failure surfaces on the Checks tab. */
export function renderAnnotation(drifts: ReadonlyArray<Drift>): string {
  const files = drifts.map((d) => `${BINDINGS_DIR}/${d.file}`).join(", ")
  return `::error title=check-bindings::${BINDINGS_DIR} is stale (${files}). Regenerate and stage: ${REGEN_COMMAND}`
}

// --- build seam ---

export interface BuildResult {
  status: number
  output: string
}

/** Runs `build:lib` into `outDir`. The single seam the rebuild passes. */
export type BuildRunner = (outDir: string) => BuildResult

/**
 * The real library build, pointed at `outDir` instead of `dist/lib`. `tsup`'s
 * `--out-dir` overrides the config's `outDir` and changes nothing else, so the
 * bytes are the ones `bun run build:lib` would have written.
 */
export const realBuild: BuildRunner = (outDir) => {
  const res = spawnSync("bunx", ["tsup", "--out-dir", outDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.error) {
    return { status: 127, output: `could not run \`tsup\`: ${res.error.message}` }
  }
  return {
    status: res.status ?? 1,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  }
}

export interface CheckOptions {
  build?: BuildRunner
  git?: GitRunner
  /** Where the rebuild goes. Defaults to a fresh temp dir, removed afterwards. */
  outDir?: string
}

/**
 * Rebuild into a scratch directory and diff it against what git has recorded.
 * Throws when the build or a `git` read fails — that is a cannot-run (exit 2),
 * not a finding, and must never read as "no drift".
 */
export function collectDrift(options: CheckOptions = {}): Array<Drift> {
  const build = options.build ?? realBuild
  const runner = options.git ?? realGit
  const owned = options.outDir === undefined
  const outDir =
    options.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "maximal-bindings-"))
  try {
    const res = build(outDir)
    if (res.status !== 0) {
      throw new Error(
        `build:lib exited ${res.status} — the bindings cannot be verified.\n${res.output.trim()}`,
      )
    }
    return diffTrees(readIndexTree(runner), hashBuiltTree(runner, outDir))
  } finally {
    // The repo tree is never touched, so nothing here can dirty it; the scratch
    // dir still goes away, including on the throw path.
    if (owned) fs.rmSync(outDir, { recursive: true, force: true })
  }
}

// --- entry point ---

export function main(options: CheckOptions = {}): number {
  let drifts: Array<Drift>
  try {
    drifts = collectDrift(options)
  } catch (err) {
    console.error(
      `check-bindings: could not run — ${err instanceof Error ? err.message : String(err)}`,
    )
    return 2
  }
  console.log(renderReport(drifts))
  if (drifts.length > 0 && process.env.GITHUB_ACTIONS) {
    console.log(renderAnnotation(drifts))
  }
  return exitCodeFor(drifts)
}

if (import.meta.main) {
  process.exit(main())
}
