#!/usr/bin/env bun
/**
 * Committed-`dist` freshness gate — every generated file that is COMMITTED must
 * equal what its build emits from the current `src/`.
 *
 * Two artifacts qualify, and both are force-tracked against the `dist/` entry in
 * `.gitignore`:
 *
 *   - `dist/lib/**` — the `exports` map's targets, so a git-dependency install
 *     (`bun add github:stuffbucket/maximal-core`) resolves types and runtime
 *     without a build. Built by `build:lib` (tsup).
 *   - `dist/main.js` — the `bin.maximal` target, so that same install gets a
 *     working `maximal` command. Built by `build` (`bun build`).
 *
 * That makes them GENERATED FILES THAT ARE ALSO SOURCE OF TRUTH for every
 * consumer. PR #14 changed `src/lib/live/supervisor.ts`, nothing regenerated
 * `dist/lib`, and `main` published new runtime behaviour behind the old
 * `{ port, pid }` declaration: a downstream `const { port } = await
 * awaitReadyLine(...)` typechecked clean and was `undefined` at runtime. Fixed
 * by hand in #19; this is the check that would have caught it in #14.
 *
 * `dist/main.js` was scoped out of the first version of this gate (#24) only
 * because it is a ~7 MB bundle. Its failure mode is strictly worse than
 * `dist/lib`'s: a stale declaration misleads a compiler at build time, where a
 * stale `dist/main.js` silently RUNS old code — `bin` points straight at the
 * committed bytes, so a git-dependency consumer executes whatever was last
 * committed, not what `src/` says.
 *
 * WHY NOT JUST STOP COMMITTING `dist/main.js` and build it on install? Because
 * the git-dependency install is the whole reason it is committed (`f79f7b6`,
 * `d607485`) and it has no build step. Measured, not assumed: with
 * `dist/main.js` removed from the index and `prepare: bun run build` added,
 * `npm install git+file://…` does produce the file — but only because `bun` is
 * on that machine's PATH; an install-time build turns a zero-toolchain install
 * into one that hard-fails without Bun. Bun's own installer additionally gates
 * dependency lifecycle scripts (`bun add ./probe.tgz` → "Blocked 1
 * postinstall"), so the fallback is a DANGLING `bin` symlink — a silently
 * broken install, which is worse than the staleness this file exists to catch.
 * The registry path already builds via `prepack`; committing is only for the
 * git path. So the file stays committed, and the gate grows to cover it.
 *
 * WHY BYTES, NOT THE TYPE SURFACE. A type-surface comparison (extract the
 * declarations, compare structurally) tolerates cosmetic bundler churn, but it
 * is blind to exactly the half of #14 that broke: the `.js` runtime behaviour
 * changed while the `.d.ts` did not. Everything that ships is checked. The cost
 * of byte equality is false positives from a nondeterministic bundler —
 * measured here rather than assumed, for both builders:
 *
 *   - tsup: consecutive rebuilds, rebuilds from a different checkout path, and
 *     rebuilds into an out-of-tree directory are byte-identical, and the output
 *     embeds no path, timestamp, or machine name.
 *   - `bun build`: consecutive rebuilds are byte-identical, and the bytes do NOT
 *     depend on `--outdir` (`/tmp/x`, `<repo>/dist2`, and `<repo>/deep/a/b` all
 *     hash the same). It inlines `package.json` — so a `bumpp` version bump is
 *     real drift the gate will report, which is correct, that bundle ships the
 *     version it prints. The one input that does move the bytes is the RESOLVED
 *     LOCATION OF `node_modules`: `bun build` writes each module's path as a
 *     banner comment relative to the build root, so a checkout with no
 *     `node_modules` of its own (a fresh `git worktree`, which this repo's
 *     parallel-agent convention creates routinely) resolves upward and emits
 *     `// ../../../node_modules/consola/…` where a normal checkout emits
 *     `// node_modules/consola/…`. That is an ENVIRONMENT fault, not drift, and
 *     `preflight()` turns it into a cannot-run with `bun install` as the fix —
 *     otherwise the gate would report a 7 MB mismatch and its own fix command
 *     would commit the wrong bytes.
 *
 * THE REBUILD GOES TO A TEMP DIR, never over `dist/`. Both builds rewrite the
 * tree in place, so checking by "rebuild, then `git diff`" would leave later
 * steps (and a developer's working tree) dirty on the failure path and would
 * destroy the evidence it just found. Building elsewhere keeps the check
 * read-only with respect to the repo.
 *
 * THE COMMITTED SIDE IS READ FROM GIT'S INDEX, not from `dist/` on disk. That is
 * not paranoia, and it is what lets this cover `dist/main.js` at all:
 * `typecheck:downstream` runs tsup into `dist/lib`, and `check:deep` runs
 * `bun run build` into `dist/main.js` — BOTH before this check, in both `ci.yml`
 * and `check:deep`. A working-tree comparison would therefore be diffing a
 * rebuild against a rebuild — permanently, silently green. Reading
 * `git ls-files -s` makes the check independent of anything that touches the
 * working copy, and it compares what will actually be committed and shipped,
 * which is the thing that broke.
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
 * run (a build, a `git` read, or the preflight failed). Both non-zero codes fail
 * CI; they are distinct only so a failure reads as "your committed dist is
 * stale" or "the check broke" without reading the log.
 *
 * The builds and `git` are the only I/O and each goes through one injectable
 * runner, mirroring `release-notes.ts`'s `GhRunner`, so every test runs offline
 * without invoking a bundler or touching a repository.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Repo root resolved from this file, so the check works from any cwd. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

/** Repo-relative home of the committed bindings. Parity-tested against tsup's `outDir`. */
export const BINDINGS_DIR = "dist/lib"

/** Repo-relative path of the committed CLI bundle. Parity-tested against `bin.maximal`. */
export const MAIN_BUNDLE = "dist/main.js"

/**
 * `bun build`'s argv minus `--outdir`, which the check supplies. Parity-tested
 * against `package.json`'s `build` script so the rebuild cannot silently stop
 * being the build.
 */
export const MAIN_BUILD_ARGV: ReadonlyArray<string> = ["build", "src/main.ts", "--target=bun"]

// --- run seam ---

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

export interface BuildResult {
  status: number
  output: string
}

/** Runs one artifact's build into `outDir`. The single seam every rebuild passes. */
export type BuildRunner = (outDir: string) => BuildResult

function spawnBuild(command: string, args: ReadonlyArray<string>): BuildResult {
  const res = spawnSync(command, [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.error) {
    return { status: 127, output: `could not run \`${command}\`: ${res.error.message}` }
  }
  return { status: res.status ?? 1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

/**
 * The real library build, pointed at `outDir` instead of `dist/lib`. `tsup`'s
 * `--out-dir` overrides the config's `outDir` and changes nothing else, so the
 * bytes are the ones `bun run build:lib` would have written.
 */
export const realLibBuild: BuildRunner = (outDir) => spawnBuild("bunx", ["tsup", "--out-dir", outDir])

/**
 * The real CLI bundle build, pointed at `outDir` instead of `dist`. `--outdir`
 * is the only difference from `bun run build`, and it provably does not move the
 * bytes (see the header), so this is what `bun run build` would have written.
 */
export const realMainBuild: BuildRunner = (outDir) =>
  spawnBuild("bun", [...MAIN_BUILD_ARGV, "--outdir", outDir])

// --- artifacts ---

/** One committed, generated thing: where git keeps it and how to regenerate it. */
export interface Artifact {
  /** Repo-relative pathspec handed to `git ls-files`, and the label in reports. */
  readonly id: string
  /**
   * Prefix that a build's output paths hang off. For a directory artifact this
   * is the directory; for a single-file artifact it is the file's PARENT, so
   * `dist/main.js` in the index and `main.js` in a scratch outDir key alike.
   */
  readonly base: string
  /** The `package.json` script that regenerates it, named in the fix command. */
  readonly script: string
  readonly build: BuildRunner
}

export const LIB_ARTIFACT: Artifact = {
  id: BINDINGS_DIR,
  base: BINDINGS_DIR,
  script: "build:lib",
  build: realLibBuild,
}

export const MAIN_ARTIFACT: Artifact = {
  id: MAIN_BUNDLE,
  base: path.posix.dirname(MAIN_BUNDLE),
  script: "build",
  build: realMainBuild,
}

export const ARTIFACTS: ReadonlyArray<Artifact> = [LIB_ARTIFACT, MAIN_ARTIFACT]

/**
 * The one command a developer runs to fix a failure, printed verbatim in the
 * report. `-f` is not optional: `dist/` is in `.gitignore`, so a NEW file (a
 * renamed content-hash chunk) is silently skipped by a bare `git add`.
 */
export function regenCommand(artifact: Artifact): string {
  return `bun run ${artifact.script} && git add -f ${artifact.id}`
}

/** Kept for the fix command's shape test and for callers that only mean the bindings. */
export const REGEN_COMMAND = regenCommand(LIB_ARTIFACT)

// --- preflight ---

/**
 * Why a real rebuild would not be comparable, or `undefined` if it would be.
 *
 * `bun build` writes module paths relative to the resolved build root, so a
 * checkout without its own `node_modules` (a fresh `git worktree`) emits
 * different bytes for identical sources. Reporting that as drift would be a lie
 * whose fix command commits the wrong bundle, so it is a cannot-run instead.
 */
export function preflight(root = REPO_ROOT): string | undefined {
  if (fs.existsSync(path.join(root, "node_modules"))) return undefined
  return (
    `no \`node_modules\` in ${root}, so a rebuild would not be byte-comparable ` +
    `(\`bun build\` writes module paths relative to the resolved build root). ` +
    `Run \`bun install\` first.`
  )
}

// --- trees ---

/** Path relative to an artifact's `base` → the file's git blob id. */
export type FileTree = Readonly<Record<string, string>>

/**
 * What git has recorded for `pathspec` — the INDEX, so a developer who has
 * already run the fix command and staged the result reads as fixed, and so a
 * step that rebuilt `dist/` on disk cannot launder the answer.
 *
 * An empty result is an empty tree, not an error: "the artifact was deleted"
 * is drift to report, not a crash.
 */
export function readIndexTree(
  runner: GitRunner,
  pathspec = BINDINGS_DIR,
  base = pathspec,
): FileTree {
  // `-z` because a path is bytes, not a line. Each record is
  // `<mode> <blob> <stage>\t<path>`.
  const out = git(runner, ["ls-files", "-s", "-z", "--", pathspec])
  const tree: Record<string, string> = {}
  for (const record of out.split("\0")) {
    if (!record) continue
    const tab = record.indexOf("\t")
    if (tab < 0) continue
    const blob = record.slice(0, tab).split(" ")[1]
    const file = path.posix.relative(base, record.slice(tab + 1))
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
  /** Path relative to the artifact's `base`. */
  file: string
  /** The `Artifact.id` this finding belongs to, so the report names its fix. */
  artifact: string
}

const KIND_LABEL: Record<DriftKind, string> = {
  "content-mismatch": "differs from the rebuild",
  "not-committed": "emitted by the build but not committed",
  orphaned: "committed but no longer emitted by the build",
}

/**
 * Every way one artifact's committed tree can disagree with a fresh build.
 * Pure. Sorted by filename so the report is stable and reviewable in a diff.
 */
export function diffTrees(
  committed: FileTree,
  rebuilt: FileTree,
  artifact = BINDINGS_DIR,
): Array<Drift> {
  const files = [
    ...new Set([...Object.keys(committed), ...Object.keys(rebuilt)]),
  ].sort()
  const drifts: Array<Drift> = []
  for (const file of files) {
    const before = committed[file]
    const after = rebuilt[file]
    if (before === undefined) drifts.push({ kind: "not-committed", file, artifact })
    else if (after === undefined) drifts.push({ kind: "orphaned", file, artifact })
    else if (before !== after) drifts.push({ kind: "content-mismatch", file, artifact })
  }
  return drifts
}

export function exitCodeFor(drifts: ReadonlyArray<Drift>): number {
  return drifts.length > 0 ? 1 : 0
}

// --- rendering ---

function artifactById(
  id: string,
  artifacts: ReadonlyArray<Artifact>,
): Artifact | undefined {
  return artifacts.find((a) => a.id === id)
}

/** `dist/lib` + `client.js` → `dist/lib/client.js`; `dist` + `main.js` → `dist/main.js`. */
function displayPath(drift: Drift, artifacts: ReadonlyArray<Artifact>): string {
  const base = artifactById(drift.artifact, artifacts)?.base ?? drift.artifact
  return path.posix.join(base, drift.file)
}

export function renderReport(
  drifts: ReadonlyArray<Drift>,
  artifacts: ReadonlyArray<Artifact> = ARTIFACTS,
): string {
  const names = artifacts.map((a) => a.id).join(" + ")
  if (drifts.length === 0) {
    return `check-bindings: ${names} match a fresh build.`
  }
  const stale = artifacts.filter((a) => drifts.some((d) => d.artifact === a.id))
  const lines = [
    `check-bindings: committed \`dist\` is STALE — ${drifts.length} file(s) disagree with a fresh build:`,
    "",
  ]
  for (const d of drifts) {
    lines.push(`  ${displayPath(d, artifacts)} — ${KIND_LABEL[d.kind]}`)
  }
  lines.push(
    "",
    "These files are committed so a git-dependency install gets a working `bin`",
    "and resolvable types without a build, which means a consumer compiles and",
    "RUNS them. Stale ones publish new runtime behaviour behind an old",
    "declaration (see maximal-core#14/#19), or execute last week's code.",
    "",
    stale.length > 1 ? "Fix it by regenerating and staging them:" : "Fix it by regenerating and staging it:",
    "",
  )
  for (const artifact of stale) lines.push(`    ${regenCommand(artifact)}`)
  lines.push("")
  return lines.join("\n")
}

/** GitHub Actions annotation, so the failure surfaces on the Checks tab. */
export function renderAnnotation(
  drifts: ReadonlyArray<Drift>,
  artifacts: ReadonlyArray<Artifact> = ARTIFACTS,
): string {
  const files = drifts.map((d) => displayPath(d, artifacts)).join(", ")
  const fixes = artifacts
    .filter((a) => drifts.some((d) => d.artifact === a.id))
    .map((a) => regenCommand(a))
    .join(" ; ")
  return `::error title=check-bindings::committed dist is stale (${files}). Regenerate and stage: ${fixes}`
}

// --- collection ---

export interface CheckOptions {
  /** Which artifacts to verify. Defaults to every committed one. */
  artifacts?: ReadonlyArray<Artifact>
  git?: GitRunner
  /** Overrides the environment gate. Tests inject; nothing else should. */
  preflight?: () => string | undefined
}

/**
 * Rebuild each artifact into its own scratch directory and diff it against what
 * git has recorded. Throws when a build, a `git` read, or the preflight fails —
 * that is a cannot-run (exit 2), not a finding, and must never read as "no
 * drift".
 */
export function collectDrift(options: CheckOptions = {}): Array<Drift> {
  const artifacts = options.artifacts ?? ARTIFACTS
  const runner = options.git ?? realGit
  const problem = (options.preflight ?? preflight)()
  if (problem !== undefined) throw new Error(problem)

  const drifts: Array<Drift> = []
  for (const artifact of artifacts) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-bindings-"))
    try {
      const res = artifact.build(outDir)
      if (res.status !== 0) {
        throw new Error(
          `${artifact.script} exited ${res.status} — ${artifact.id} cannot be verified.\n${res.output.trim()}`,
        )
      }
      drifts.push(
        ...diffTrees(
          readIndexTree(runner, artifact.id, artifact.base),
          hashBuiltTree(runner, outDir),
          artifact.id,
        ),
      )
    } finally {
      // The repo tree is never touched, so nothing here can dirty it; the
      // scratch dir still goes away, including on the throw path.
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  }
  return drifts
}

// --- entry point ---

export function main(options: CheckOptions = {}): number {
  const artifacts = options.artifacts ?? ARTIFACTS
  let drifts: Array<Drift>
  try {
    drifts = collectDrift(options)
  } catch (err) {
    console.error(
      `check-bindings: could not run — ${err instanceof Error ? err.message : String(err)}`,
    )
    return 2
  }
  console.log(renderReport(drifts, artifacts))
  if (drifts.length > 0 && process.env.GITHUB_ACTIONS) {
    console.log(renderAnnotation(drifts, artifacts))
  }
  return exitCodeFor(drifts)
}

if (import.meta.main) {
  process.exit(main())
}
