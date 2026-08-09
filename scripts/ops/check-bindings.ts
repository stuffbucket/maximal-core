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
 * changed while the `.d.ts` did not. Everything that ships is checked.
 *
 * THE TWO ARTIFACTS DO NOT HAVE THE SAME REPRODUCIBILITY ENVELOPE, and the
 * difference is why `Artifact.requires` exists. Measured on a 2x2 of
 * {ubuntu-latest, macos-latest} x {Bun 1.3.11, Bun 1.3.14}, run from
 * `bundle-repro-probe.yml` on a scratch branch (maximal-core#31):
 *
 *   - `build:lib` (tsup) bundles with ESBUILD, which is a pinned dependency in
 *     `package.json`. Its output is byte-identical across Bun versions — Bun is
 *     only the process runner. It needs `node_modules`, nothing more.
 *   - `build` (`bun build`) bundles with BUN'S OWN BUNDLER, so its output is a
 *     function of the Bun version. Both OSes agreed exactly within a version
 *     (`f2d4ce49…` on 1.3.11, `8dfc9ac8…` on 1.3.14, on ubuntu AND macos), and
 *     the two versions disagreed. The host OS makes no difference; the Bun
 *     version is the whole story. So this artifact additionally requires the
 *     Bun in `.bun-version`.
 *
 * That asymmetry is exactly why this gate was green for `dist/lib` from #24
 * until `dist/main.js` was added: dev machines run ahead of the pin routinely,
 * and only one of the two builds notices.
 *
 * A TOOLCHAIN DIFFERENCE IS A CANNOT-RUN, NEVER A STALE REPORT. This is the
 * load-bearing rule of `requires`. If the check said "stale" when the real
 * answer is "your Bun differs from the pin", the fix command it prints would
 * have the developer commit a bundle built by the wrong toolchain — which does
 * not fix CI, it makes CI wrong in the other direction, and it launders an
 * unreproducible artifact into `main`. That has already happened here twice
 * without anyone noticing (the committed bundle on `main` at #30 reproduces
 * only under an unpinned Bun), which is what this gate caught first.
 *
 * The same reasoning covers `node_modules`: `bun build` writes each module's
 * path as a banner comment relative to the resolved build root, so a checkout
 * with no `node_modules` of its own (a fresh `git worktree`, which this repo's
 * parallel-agent convention creates routinely) resolves upward and emits
 * `// ../../../node_modules/consola/…` where a normal checkout emits
 * `// node_modules/consola/…`. Also a cannot-run, also with the fix named.
 *
 * Beyond the toolchain the bytes are stable: consecutive rebuilds are
 * byte-identical for both builders, and neither depends on `--outdir`
 * (`/tmp/x`, `<repo>/dist2` and `<repo>/deep/a/b` all hash the same).
 * `bun build` inlines `package.json` — so a `bumpp` version bump is real drift
 * the gate will report, which is correct: that bundle ships the version it
 * prints.
 *
 * WHY COMPARE RATHER THAN HAVE CI REGENERATE AND COMMIT. Auto-committing needs
 * `contents: write` and a push to the PR head ref, which the read-only
 * `pull_request` token cannot do for a fork — the workaround is
 * `pull_request_target`, i.e. untrusted code with write credentials. It also
 * fights the merge queue (a bot push invalidates the queued ref), and it
 * removes the signal: a source change that moves the shipped bundle should be
 * visible in review, not silently amended in. #24 chose comparison for
 * `dist/lib`; running two different models out of one file would be worse than
 * either.
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
 * run (a build, a `git` read, or an artifact's `requires` failed). Both non-zero
 * codes fail CI; they are distinct only so a failure reads as "your committed
 * dist is stale" or "the check could not answer" without reading the log. An
 * artifact that could not be verified never counts as fresh — 2 wins over 0
 * even when every artifact that DID run was clean.
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

/** The repo's single source of truth for the Bun version (docs/bun-version-policy.md). */
export const BUN_VERSION_FILE = ".bun-version"

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
 *
 * `process.execPath x tsup` rather than `bunx tsup` for the same reason as the
 * bundle build: `bunx` is a separate binary that need not be on PATH beside the
 * Bun actually running, and this way only one thing has to be found.
 */
export const realLibBuild: BuildRunner = (outDir) =>
  spawnBuild(process.execPath, ["x", "tsup", "--out-dir", outDir])

/**
 * The real CLI bundle build, pointed at `outDir` instead of `dist`. `--outdir`
 * is the only difference from `bun run build`, and it provably does not move the
 * bytes (see the header), so this is what `bun run build` would have written.
 *
 * Spawns `process.execPath`, NOT `bun` off PATH. `needsPinnedBun` can only
 * measure the Bun interpreting this file, and the two are not always the same
 * binary — `/path/to/1.3.11/bun run build` re-resolves `bun` from PATH inside
 * the script and can bundle with 1.3.14. Building with the exact interpreter
 * that was version-checked is what makes the check's answer about the bundler
 * that actually ran.
 */
export const realMainBuild: BuildRunner = (outDir) =>
  spawnBuild(process.execPath, [...MAIN_BUILD_ARGV, "--outdir", outDir])

// --- environment requirements ---

/**
 * Why a rebuild of some artifact would not be byte-comparable on this machine,
 * or `undefined` if it would be. Never a finding — see the header: a toolchain
 * difference reported as staleness sends a developer to commit the wrong bytes.
 */
export type Requirement = (root?: string) => string | undefined

/**
 * Both builds read `node_modules`, and `bun build` additionally encodes where it
 * found it (module paths are banner comments relative to the resolved build
 * root), so a worktree that resolves upward to a sibling checkout's
 * `node_modules` produces different bytes for identical sources.
 *
 * It probes `node_modules/.bin`, NOT `node_modules`, because the directory
 * existing does not mean it was installed into. A linked worktree used with
 * `container:run` acquires an EMPTY `node_modules` — the docker bind-mount
 * target is created on the host — and Bun then resolves upward anyway. Measured
 * here: an existence check passed, the bundle came out with
 * `// ../../../node_modules/consola/dist/core.mjs` banners, and the only
 * difference from the correct bundle was 21 such lines. `.bin` is the same
 * probe the container's own bootstrap uses to decide whether to `bun install`.
 */
export const needsNodeModules: Requirement = (root = REPO_ROOT) => {
  if (fs.existsSync(path.join(root, "node_modules", ".bin"))) return undefined
  return (
    `no installed \`node_modules\` in ${root}, so a rebuild would not be `
    + "byte-comparable (`bun build` writes module paths relative to the resolved "
    + "build root, and resolves upward when this one is empty).\n"
    + "    bun install"
  )
}

/** The pinned Bun, read from the repo's one source of truth. */
export function pinnedBunVersion(root = REPO_ROOT): string {
  return fs.readFileSync(path.join(root, BUN_VERSION_FILE), "utf8").trim()
}

/** What `bun build` is bundling with right now. `undefined` off Bun entirely. */
export function runningBunVersion(): string | undefined {
  return process.versions.bun
}

/**
 * `bun build` bundles with Bun's own bundler, so the committed bytes are a
 * function of the Bun version — measured across a 2x2 of OS x version, where
 * the OS made no difference and the version made all of it. Building on an
 * unpinned Bun and committing the result is how `main` acquired a `bin` bundle
 * nobody following `docs/bun-version-policy.md` can regenerate.
 */
export const needsPinnedBun: Requirement = (root = REPO_ROOT) => {
  const running = runningBunVersion()
  let pinned: string
  try {
    pinned = pinnedBunVersion(root)
  } catch (err) {
    return `could not read ${BUN_VERSION_FILE}: ${err instanceof Error ? err.message : String(err)}`
  }
  if (running === pinned) return undefined
  return (
    `Bun ${running ?? "(not running under Bun)"} is bundling but ${BUN_VERSION_FILE} pins `
    + `${pinned}, and \`bun build\` output is a function of the Bun version. `
    + "A bundle built here is one CI cannot reproduce, so this is not "
    + "a staleness report — do not regenerate until the toolchain matches.\n"
    + "Build on the pin, which needs nothing on your PATH:\n"
    + "    bun run container:run -- bun run build\n"
    + "or put the pinned Bun first on your own PATH:\n"
    + `    curl -fsSL https://bun.sh/install | bash -s bun-v${pinned}`
  )
}

/** First objection wins, so the developer is handed one fix at a time. */
export function firstObjection(
  requirements: ReadonlyArray<Requirement>,
  root?: string,
): string | undefined {
  for (const requirement of requirements) {
    const objection = requirement(root)
    if (objection !== undefined) return objection
  }
  return undefined
}

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
  /** What this artifact's build needs before its bytes mean anything. */
  readonly requires: ReadonlyArray<Requirement>
}

export const LIB_ARTIFACT: Artifact = {
  id: BINDINGS_DIR,
  base: BINDINGS_DIR,
  script: "build:lib",
  build: realLibBuild,
  // esbuild, pinned in package.json — Bun is only the process runner here, and
  // its version provably does not move these bytes.
  requires: [needsNodeModules],
}

export const MAIN_ARTIFACT: Artifact = {
  id: MAIN_BUNDLE,
  base: path.posix.dirname(MAIN_BUNDLE),
  script: "build",
  build: realMainBuild,
  requires: [needsNodeModules, needsPinnedBun],
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

/** An artifact whose freshness this machine could not honestly answer. */
export interface Blocked {
  artifact: string
  reason: string
}

export interface CheckResult {
  drifts: Array<Drift>
  blocked: Array<Blocked>
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

/**
 * 2 beats 1 beats 0. An unverifiable artifact must never read as fresh, and it
 * outranks a drift finding because "some of this answer is missing" is the more
 * important thing to say.
 */
export function exitCodeFor(result: CheckResult): number {
  if (result.blocked.length > 0) return 2
  return result.drifts.length > 0 ? 1 : 0
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
  result: CheckResult,
  artifacts: ReadonlyArray<Artifact> = ARTIFACTS,
): string {
  const { blocked, drifts } = result
  const lines: Array<string> = []

  if (drifts.length > 0) {
    const stale = artifacts.filter((a) => drifts.some((d) => d.artifact === a.id))
    lines.push(
      `check-bindings: committed \`dist\` is STALE — ${drifts.length} file(s) disagree with a fresh build:`,
      "",
    )
    for (const d of drifts) lines.push(`  ${displayPath(d, artifacts)} — ${KIND_LABEL[d.kind]}`)
    lines.push(
      "",
      "These files are committed so a git-dependency install gets a working `bin`",
      "and resolvable types without a build, which means a consumer compiles and",
      "RUNS them. Stale ones publish new runtime behaviour behind an old",
      "declaration (see maximal-core#14/#19), or execute last week's code.",
      "",
      stale.length > 1
        ? "Fix it by regenerating and staging them:"
        : "Fix it by regenerating and staging it:",
      "",
    )
    for (const artifact of stale) lines.push(`    ${regenCommand(artifact)}`)
    lines.push(
      "",
      "If you just merged, rebased or ran `gh pr update-branch`: REBUILD. Never",
      "resolve a conflict in `dist/` by hand or by taking one side — the two",
      "sides are whole artifacts, and a line-level merge of them corresponds to",
      "no source tree at all (maximal-core#116). `.gitattributes` marks",
      "`dist/**` `-merge` so git conflicts rather than splicing them silently.",
      "",
    )
  }

  if (blocked.length > 0) {
    lines.push(
      `check-bindings: ${blocked.length} artifact(s) could NOT be verified on this machine.`,
      "This is not a staleness report — regenerating now would commit bytes that",
      "disagree with CI. Resolve the environment first:",
      "",
    )
    for (const b of blocked) lines.push(`  ${b.artifact} — ${b.reason}`, "")
  }

  if (lines.length === 0) {
    return `check-bindings: ${artifacts.map((a) => a.id).join(" + ")} match a fresh build.`
  }
  return lines.join("\n")
}

/** GitHub Actions annotation, so the failure surfaces on the Checks tab. */
export function renderAnnotation(
  result: CheckResult,
  artifacts: ReadonlyArray<Artifact> = ARTIFACTS,
): string | undefined {
  const { blocked, drifts } = result
  if (blocked.length > 0) {
    const names = blocked.map((b) => b.artifact).join(", ")
    return `::error title=check-bindings::could not verify ${names} — the toolchain does not match the pin, so this is not a staleness report. See the step log.`
  }
  if (drifts.length === 0) return undefined
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
  /**
   * Emit the GitHub Actions annotation. Defaults to whether we are ON Actions —
   * tests must pass `false`, or a test that exercises a stale report writes a
   * real `::error` onto the run's Checks tab and invents a failure.
   */
  annotate?: boolean
  /** Where the report and the annotation go. Defaults to stdout. */
  log?: (line: string) => void
}

/**
 * Rebuild each artifact into its own scratch directory and diff it against what
 * git has recorded. An artifact whose `requires` objects is not built at all —
 * it is reported as blocked instead. Throws when a build or a `git` read fails —
 * that is a cannot-run too, and must never read as "no drift".
 */
export function collectDrift(options: CheckOptions = {}): CheckResult {
  const artifacts = options.artifacts ?? ARTIFACTS
  const runner = options.git ?? realGit
  const result: CheckResult = { drifts: [], blocked: [] }

  for (const artifact of artifacts) {
    const objection = firstObjection(artifact.requires)
    if (objection !== undefined) {
      result.blocked.push({ artifact: artifact.id, reason: objection })
      continue
    }
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-bindings-"))
    try {
      const res = artifact.build(outDir)
      if (res.status !== 0) {
        throw new Error(
          `${artifact.script} exited ${res.status} — ${artifact.id} cannot be verified.\n${res.output.trim()}`,
        )
      }
      result.drifts.push(
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
  return result
}

// --- entry point ---

export function main(options: CheckOptions = {}): number {
  const artifacts = options.artifacts ?? ARTIFACTS
  const annotate = options.annotate ?? process.env.GITHUB_ACTIONS !== undefined
  const log =
    options.log
    ?? ((line: string) => {
      console.log(line)
    })
  let result: CheckResult
  try {
    result = collectDrift(options)
  } catch (err) {
    console.error(
      `check-bindings: could not run — ${err instanceof Error ? err.message : String(err)}`,
    )
    return 2
  }
  log(renderReport(result, artifacts))
  if (annotate) {
    const annotation = renderAnnotation(result, artifacts)
    if (annotation !== undefined) log(annotation)
  }
  return exitCodeFor(result)
}

if (import.meta.main) {
  process.exit(main())
}
