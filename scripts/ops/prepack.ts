#!/usr/bin/env bun
/**
 * The `prepack` build, with the pin enforced — so the tarball a registry serves
 * is as reproducible as the bundle `bindings:check` guards in git.
 *
 * `bindings:check` (see `check-bindings.ts`) closes the COMMITTED path: what is
 * in the index equals what the pinned Bun builds from `src/`. This file closes
 * the PUBLISHED one. They are different artifacts and only one of them was
 * guarded.
 *
 * WHAT `bun publish` ACTUALLY RUNS — measured against Bun 1.3.14, not inferred
 * from npm's docs, because the whole exposure depends on it:
 *
 *     bun publish  →  prepublishOnly → prepack → prepare → (pack) → upload
 *     bun pm pack  →                   prepack → prepare → (pack)
 *
 * So `prepack` does fire, npm-style, and it fires on `bun pm pack` too. It runs
 * `build` (`bun build`, Bun's own bundler) into `dist/`, whose bytes are a
 * function of the Bun version — measured on a 2x2 of {ubuntu, macos} x {1.3.11,
 * 1.3.14} in maximal-core#31, where the OS made no difference and the version
 * made all of it. `release:manual` used to invoke `bun publish` with whatever
 * Bun the releaser had on PATH, so the tarball could carry a `dist/main.js` that
 * disagrees with the committed, verified one and that nobody can regenerate.
 * Measured here, off-pin, on `main` at v0.3.2:
 *
 *     committed dist/main.js   85697a48…  (= Bun 1.3.11, the pin)
 *     tarball   dist/main.js   ffdee378…  (= Bun 1.3.14, whatever was on PATH)
 *
 * WHY THE INTERPRETER IS NOT ENOUGH, AND WHY THIS FILE EXISTS AT ALL. The
 * obvious fix — "run the release with the pinned Bun" — does not work, and
 * this is the trap `check-bindings.ts` already hit. Bun runs lifecycle scripts
 * through a shell whose PATH contains NEITHER `node_modules/.bin` NOR Bun's own
 * bindir, so the bare `bun` in `bun run build` re-resolves from the developer's
 * PATH. Invoking the pin explicitly therefore still bundles with PATH's Bun:
 *
 *     $ /path/to/1.3.11/bin/bun pm pack     # tarball dist/main.js → ffdee378…
 *
 * i.e. the pinned binary produced the UNPINNED bundle. Version-checking one
 * process and bundling with another answers a question nobody asked. So this
 * file checks `process.versions.bun` and then bundles with `process.execPath` —
 * the same binary, no PATH lookup in between — exactly as `realMainBuild` does.
 *
 * WHY REFUSE RATHER THAN CORRECT. Downloading the right Bun mid-publish would
 * make the release path a network operation with a silent fallback, and the
 * releaser would never learn their toolchain is wrong. Refusing is one line of
 * output and one command to run.
 *
 * WHY THE PREFLIGHT (`--check`) EXISTS, AND WHY IT IS THE PRIMARY GATE.
 * `release:tag` ends at a pushed tag, and `publish-package.yml` publishes
 * from that tag — so by the time `prepack` runs in CI, the tag is public and
 * `docs/release-runbook.md` is explicit that a published tag must not be moved.
 * A refusal there is already too late to be cheap. `--check` runs the identical
 * assertion with no build, wired ahead of `bumpp`, so the common failure costs
 * nothing. `prepack` keeps the same assertion as a backstop for that workflow
 * and for anyone who runs `bun publish` or `bun pm pack` directly.
 *
 * Both measure the same thing: each is launched by a bare `bun` resolved from
 * PATH through a shell, so the preflight's interpreter is the interpreter
 * `prepack` will later get.
 *
 * WHY NOT COMPARE THE TARBALL'S BUNDLE AGAINST THE COMMITTED BLOB. It looks
 * like the stronger check and it is unusable: `bun build` inlines
 * `package.json` (`BUILD_VERSION` in `src/lib/update/build-info.ts` falls back
 * to `packageJson.version`), and `bumpp` bumps that version before `prepack`
 * runs. Same Bun, one bumped version, measured:
 *
 *     1.3.11 @ 0.3.2   85697a48…   (= committed)
 *     1.3.11 @ 0.3.3   2e541596…
 *
 * A blob comparison would therefore fail on every genuine release and pass only
 * on a no-op one. The invariant that DOES hold across a bump is the toolchain,
 * which is what is asserted here.
 *
 * PUBLISHING NOW HAPPENS IN CI, which pins the version by construction —
 * `publish-package.yml` installs `.bun-version`'s Bun and runs `bun publish` on
 * the tag. That was always the better end state and this file is what made the
 * manual path safe until it existed. It stays as the belt-and-braces check
 * inside that workflow, and as the only guard on a by-hand `bun pm pack`.
 *
 * IT ALSO STAYS BECAUSE OF WHAT IT REFUSES: `process.versions.bun` is
 * `undefined` under node, so `npm publish` cannot get past this assertion at
 * all. The workflow uses `bun publish` for that reason and says so.
 *
 * Usage:
 *   bun scripts/ops/prepack.ts            # assert the pin, then build
 *   bun scripts/ops/prepack.ts --check    # assert the pin only (preflight)
 *
 * Exit codes: 0 ok · 1 refused, the running Bun is not the pin · 2 a build
 * failed. Any non-zero aborts `bun publish` before anything is uploaded.
 *
 * The two builds are the only I/O and both go through one injectable runner,
 * mirroring `check-bindings.ts`'s `BuildRunner`, so every test runs offline
 * without invoking a bundler.
 */

import { spawnSync } from "node:child_process"
import path from "node:path"

import {
  BUN_VERSION_FILE,
  firstObjection,
  MAIN_ARTIFACT,
  MAIN_BUILD_ARGV,
  needsPinnedBun,
  pinnedBunVersion,
  type Requirement,
  runningBunVersion,
} from "./check-bindings"

/** Repo root resolved from this file, so `prepack` works from any cwd. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

/** Where the two builds write. This is the `dist` the tarball ships. */
export const OUT_DIR = "dist"

/** The flag that turns the build into a bare assertion. */
export const CHECK_FLAG = "--check"

// --- run seam ---

export interface RunResult {
  status: number
  output: string
}

/** Runs one build. The single seam every child process passes. */
export type CommandRunner = (command: string, args: ReadonlyArray<string>) => RunResult

/**
 * `env` IS PASSED EXPLICITLY, AND IT HAS TO BE. Bun's `spawnSync` defaults the
 * child's environment to the SNAPSHOT this process started with, not to its
 * current `process.env` — so anything a script sets at runtime is silently
 * dropped on the way out. Measured, Bun 1.3.11:
 *
 *     process.env.PROBE = "set-by-parent"
 *     spawnSync(bun, ["-e", "…"])                      → PROBE undefined
 *     spawnSync(bun, ["-e", "…"], { env: process.env }) → PROBE set-by-parent
 *
 * `release.ts` hands the rendered CHANGELOG block to `bumpp`'s execute hook that
 * way, and the failure mode without this line is the worst shape available: a
 * green release whose commit simply has no changelog entry in it. Node passes
 * the live `process.env` here, so this is also the portable spelling.
 */
export const realRunner: CommandRunner = (command, args) => {
  const res = spawnSync(command, [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
  })
  if (res.error) {
    return { status: 127, output: `could not run \`${command}\`: ${res.error.message}` }
  }
  return { status: res.status ?? 1, output: "" }
}

// --- the two builds ---

/**
 * `bun build`'s argv, argv-identical to `package.json`'s `build` script.
 * Parity-tested there, so `prepack` cannot silently stop being the build.
 */
export function mainBuildArgv(outDir: string = OUT_DIR): Array<string> {
  return [...MAIN_BUILD_ARGV, "--outdir", outDir]
}

/**
 * `build:lib`'s argv. `bun x tsup` rather than `bunx tsup` for the same reason
 * as `check-bindings.ts`: `bunx` is a separate binary that need not sit beside
 * the Bun actually running, and Bun's lifecycle PATH contains neither it nor
 * `node_modules/.bin`.
 */
export const LIB_BUILD_ARGV: ReadonlyArray<string> = ["x", "tsup"]

// --- the assertion ---

/**
 * Why this Bun must not produce the tarball, or `undefined` if it may. Only
 * ever about the toolchain — a build failure is a separate, louder thing.
 */
export function pinObjection(
  running: string | undefined,
  pinned: string,
): string | undefined {
  if (running === pinned) return undefined
  return (
    `prepack: REFUSING to build the published tarball.\n`
    + `\n`
    + `  Bun ${running ?? "(not running under Bun)"} would bundle, but ${BUN_VERSION_FILE} pins ${pinned}.\n`
    + `\n`
    + `\`bun build\` bundles with Bun's own bundler, so dist/main.js is a function of\n`
    + `the Bun version. Publishing from here would ship a bin bundle that disagrees\n`
    + `with the committed, verified one and that nobody can regenerate — and unlike a\n`
    + `git push, a registry publish cannot be taken back.\n`
    + `\n`
    + `Switch Bun first:\n`
    + `    curl -fsSL https://bun.sh/install | bash -s bun-v${pinned}\n`
  )
}

/**
 * The shared environment list, minus the pin. `pinObjection` IS the pin check
 * here and it takes both versions as inputs, so the tests can simulate an
 * on-pin run while themselves running off-pin (`check:ops` does, routinely);
 * re-running `needsPinnedBun` would re-measure the ambient process and
 * contradict them. Everything else in the shared list applies verbatim, and by
 * subtracting rather than re-listing, a requirement added over there reaches
 * `prepack` without anyone having to remember this file.
 */
export const REQUIREMENTS: ReadonlyArray<Requirement> = MAIN_ARTIFACT.requires.filter(
  (requirement) => requirement !== needsPinnedBun,
)

// --- entry point ---

export interface PrepackOptions {
  /** Assert only; do not build. What the release preflight runs. */
  checkOnly?: boolean
  run?: CommandRunner
  /**
   * The Bun that will bundle. Defaults to THIS process's own interpreter, never
   * a PATH lookup — see the header: `bun run build` resolves a different binary.
   */
  bun?: string
  running?: string | undefined
  pinned?: string
  /**
   * What else the environment has to be true for before these bytes mean
   * anything. Defaults to the SHARED list — the one `check-bindings.ts` judges
   * a rebuild by and `build-bundle.ts` refuses on — so `prepack` refuses in
   * exactly the cases they do rather than in a subset of its own. Injected so
   * the tests assert nothing about the ambient environment; `check:ops` runs
   * with no `bun install` and off-pin.
   */
  requirements?: ReadonlyArray<Requirement>
  outDir?: string
  /** Where `.bun-version` is read from when `pinned` is not supplied. */
  root?: string
  log?: (line: string) => void
}

export function prepack(options: PrepackOptions = {}): number {
  const log = options.log ?? ((line: string) => { console.error(line) })
  const bun = options.bun ?? process.execPath
  const run = options.run ?? realRunner
  const outDir = options.outDir ?? OUT_DIR
  const root = options.root ?? REPO_ROOT

  let pinned: string
  try {
    pinned = options.pinned ?? pinnedBunVersion(root)
  } catch (err) {
    log(`prepack: could not read ${BUN_VERSION_FILE} — ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const running = "running" in options ? options.running : runningBunVersion()
  const objection = pinObjection(running, pinned)
  if (objection !== undefined) {
    log(objection)
    return 1
  }

  // The pin was its own check above, not one of these: the refusal a publish
  // deserves is not the one a rebuild deserves, and `pinObjection` takes its
  // two versions as inputs. What this list reaches that nothing here did is
  // `needsNodeModules` — `prepack` was the one guarded build path that probe
  // never covered (maximal-core#124). `release:prepare` rebuilds `dist/`
  // through this function, so an empty `node_modules` put
  // `../../../node_modules/…` banners in the one commit you least want them in.
  const environment = firstObjection(options.requirements ?? REQUIREMENTS, root)
  if (environment !== undefined) {
    log(`prepack: REFUSING to build the published tarball.\n\n  ${environment}\n`)
    return 1
  }

  if (options.checkOnly === true) {
    log(`prepack: Bun ${pinned} matches ${BUN_VERSION_FILE}; the tarball will be reproducible.`)
    return 0
  }

  for (const argv of [mainBuildArgv(outDir), LIB_BUILD_ARGV]) {
    const res = run(bun, argv)
    if (res.status !== 0) {
      log(`prepack: \`${path.basename(bun)} ${argv.join(" ")}\` exited ${res.status}${res.output ? ` — ${res.output.trim()}` : ""}`)
      return 2
    }
  }
  return 0
}

export function main(
  argv: ReadonlyArray<string> = process.argv.slice(2),
  options: PrepackOptions = {},
): number {
  return prepack({ ...options, checkOnly: argv.includes(CHECK_FLAG) })
}

if (import.meta.main) {
  process.exit(main())
}
