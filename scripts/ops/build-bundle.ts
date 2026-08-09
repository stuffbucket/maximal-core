#!/usr/bin/env bun
/**
 * `bun run build` — the committed CLI bundle, with the pin enforced.
 *
 * WHY THIS IS NOT JUST `bun build src/main.ts --target=bun --outdir dist`.
 *
 * `dist/main.js` is committed and `bin.maximal` points straight at it, so a
 * git-dependency install runs those exact bytes. It is produced by `bun build`,
 * which bundles with BUN'S OWN BUNDLER — its output is a function of the Bun
 * version, measured on a 2x2 of {ubuntu, macos} x {1.3.11, 1.3.14} in
 * maximal-core#31, where the OS made no difference and the version made all of
 * it. So a build on an off-pin Bun emits bytes CI cannot reproduce.
 *
 * Every OTHER path to those bytes was already guarded and this one was not:
 *
 *   - `check-bindings.ts` refuses to report staleness off-pin (exit 2).
 *   - `prepack.ts` refuses to build the published tarball off-pin (exit 1).
 *   - `bun run build` did it anyway, silently, and `git add -f dist/main.js` —
 *     step 3 of docs/bun-version-policy.md — committed the result.
 *
 * That is not hypothetical: three people hit it in a single session. The gate
 * caught it downstream every time, as `bindings:check` "could not verify",
 * which is the right report and the wrong place — by then the wrong bytes are
 * already in the work tree, and often in the index.
 *
 * WHY REFUSE RATHER THAN DELEGATE TO THE CONTAINER. Shelling out to
 * `container:run` from here would make `bun run build` require Docker, make its
 * cost and its failure modes depend on whether an image happens to exist, and —
 * fatally — recurse: `container:run -- bun run build` runs THIS script inside
 * the container. Refusing is one line of output and one command to run, and
 * in-container the refusal cannot fire because Bun there IS the pin.
 *
 * WHY IT SPAWNS `process.execPath`. `bun run build` used to end in a nested,
 * bare `bun build`, and Bun runs scripts through a shell whose PATH contains
 * neither `node_modules/.bin` nor Bun's own bindir — so that `bun` re-resolved
 * from the developer's PATH. Measured: `/tmp/bun1311/bin/bun run build`
 * produced a 1.3.14 bundle. Version-checking one binary and bundling with
 * another answers a question nobody asked, so the binary that was checked is
 * the binary that bundles — the same fix `check-bindings.ts` and `prepack.ts`
 * already made, and the reason `realMainBuild` is reused here verbatim rather
 * than re-spelled.
 *
 * WHY THE REQUIREMENTS ARE `MAIN_ARTIFACT.requires` AND NOT A LIST OF ITS OWN.
 * The build must refuse in EXACTLY the cases where `bindings:check` refuses to
 * judge the result — otherwise there is a window where `bun run build` writes
 * bytes the gate then declines to verify. Sharing the list closes it by
 * construction. It also picks up `needsNodeModules` for free, which is not
 * theoretical: built from a linked worktree that has no `node_modules` of its
 * own, `bun build` resolves upward and writes the module banner comments
 * relative to THAT root — measured here, a 21-line diff against the same
 * sources on the same Bun.
 *
 * Exit codes: 0 built · 1 refused, the environment would produce bytes CI
 * cannot reproduce · the bundler's own status otherwise.
 */
import path from "node:path"

import {
  firstObjection,
  MAIN_ARTIFACT,
  MAIN_BUNDLE,
  type BuildRunner,
  type Requirement,
} from "./check-bindings"

/** Where the bundle is written — derived from the committed path, not restated. */
export const OUT_DIR = path.posix.dirname(MAIN_BUNDLE)

/**
 * What `package.json`'s `build` must be. Parity-tested there and in
 * `prepack.test.ts`: a `build` that stops routing through this file is a build
 * with no guard, which is the entire defect.
 *
 * Deliberately ONE command with no `&&`: `check-ci-coverage.ts` expands any
 * `check:deep` member whose body contains `&&` into its parts and then demands
 * CI name each part as a step, so a two-command `build` would fail `ci:check`
 * against a workflow that correctly runs `bun run build`.
 */
export const BUILD_COMMAND = "bun scripts/ops/build-bundle.ts"

export interface BuildOptions {
  /** The environment assertions. Injected so tests need no off-pin Bun. */
  requirements?: ReadonlyArray<Requirement>
  /** The bundler. Injected so tests never run one. */
  build?: BuildRunner
  outDir?: string
  root?: string
  log?: (line: string) => void
}

export function buildBundle(options: BuildOptions = {}): number {
  const log = options.log ?? ((line: string) => { console.error(line) })
  const build = options.build ?? MAIN_ARTIFACT.build

  const objection = firstObjection(options.requirements ?? MAIN_ARTIFACT.requires, options.root)
  if (objection !== undefined) {
    log(`build: REFUSING to bundle ${MAIN_BUNDLE}.\n\n  ${objection}\n`)
    return 1
  }

  const result = build(options.outDir ?? OUT_DIR)
  if (result.output.trim()) log(result.output.trim())
  return result.status
}

if (import.meta.main) {
  process.exit(buildBundle())
}
