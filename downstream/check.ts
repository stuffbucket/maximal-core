/**
 * Downstream contract typecheck (maximal-core#4).
 *
 * Acceptance criterion: "A build test proves a downstream package typechecks
 * against the contract without compiling the sidecar."
 *
 * What this does, and why each step is there:
 *
 * 1. **Rebuilds `dist/lib` with tsup.** The committed `dist/lib/*.d.ts` exist so
 *    a git-dependency install gets types without a build step — they are a
 *    convenience copy, and a copy can be stale. What actually ships is whatever
 *    `prepack` (`bun run build:lib`) produces, so that is what has to be under
 *    test; checking the committed copy would green-light bindings nobody will
 *    publish and would fail for reasons unrelated to the contract whenever the
 *    copy lags. Staleness of the committed copy is a SEPARATE gate and is not
 *    this script's job. Pass `--no-build` to skip (e.g. right after a build).
 *
 * 2. **Links the repo into `downstream/node_modules/` under its published name.**
 *    Resolution then goes package-name → `exports` map → `dist/lib/*.d.ts`,
 *    exactly as it does for a consumer. A tsconfig `paths` shortcut would have
 *    been simpler and would have tested nothing: it bypasses the map.
 *
 * 3. **Runs `tsc --noEmit` under two resolvers** (Bundler and NodeNext) over the
 *    fixture sources.
 *
 * 4. **Asserts the resulting program touched no engine source.** "Without
 *    compiling the sidecar" is the load-bearing half of the criterion: a fixture
 *    that passes only because it dragged in `src/` has proven nothing. The
 *    `@ts-expect-error`s in `src/no-src-reach.ts` assert this from the inside;
 *    `--listFiles` asserts it from the outside, where no comment can lie.
 *
 * Run: `bun downstream/check.ts` (from the repo root, or anywhere — paths are
 * resolved relative to this file).
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

const fixtureDir = import.meta.dirname
const repoRoot = resolve(fixtureDir, "..")
const packageName = "@stuffbucket/maximal-core"

const skipBuild = process.argv.includes("--no-build")

/** Any non-zero (or signal-killed, i.e. null) status counts as a failure. */
function run(command: string, args: Array<string>, cwd: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8" })
}

function fail(message: string, detail?: string): never {
  console.error(`\n✗ ${message}`)
  if (detail?.trim()) console.error(detail.trimEnd())
  process.exit(1)
}

// --- 1. build the published bindings ----------------------------------------
if (skipBuild) {
  console.log("• skipping build:lib (--no-build)")
} else {
  console.log("• building library bindings (tsup)")
  const built = run(join(repoRoot, "node_modules/.bin/tsup"), [], repoRoot)
  if (built.status !== 0) {
    fail("build:lib failed", built.stdout + built.stderr)
  }
}

// --- 2. link the package under its published name ---------------------------
const scopeDir = join(
  fixtureDir,
  "node_modules",
  packageName.split("/")[0] ?? "",
)
const linkPath = join(fixtureDir, "node_modules", packageName)
rmSync(linkPath, { force: true, recursive: true })
mkdirSync(scopeDir, { recursive: true })
// Relative link so the fixture keeps working if the checkout moves.
symlinkSync("../../..", linkPath, "dir")
console.log(`• linked ${packageName} -> ${repoRoot}`)

// --- 3 + 4. typecheck under each resolver, then audit the program -----------
const tsc = join(repoRoot, "node_modules/.bin/tsc")
const configs = ["tsconfig.json", "tsconfig.nodenext.json"]

for (const config of configs) {
  console.log(`• tsc -p downstream/${config}`)
  const checked = run(
    tsc,
    ["-p", join(fixtureDir, config), "--listFiles"],
    fixtureDir,
  )

  // tsc prints the file list on stdout alongside diagnostics; keep only the
  // absolute paths so a diagnostic mentioning "src/" cannot fake a pass.
  const programFiles = checked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/") && /\.(?:d\.)?[cm]?ts$/.test(line))

  // Audit the program BEFORE reporting diagnostics: a fixture that reached
  // engine source is compiling the wrong thing entirely, and that is the more
  // fundamental failure even when there are also type errors to look at.
  const engineSources = programFiles.filter((file) =>
    file.startsWith(join(repoRoot, "src") + "/"),
  )
  if (engineSources.length > 0) {
    fail(
      `${config} pulled engine source into the program — the fixture is not testing the published surface`,
      engineSources.join("\n"),
    )
  }

  if (checked.status !== 0) {
    const diagnostics = checked.stdout
      .split("\n")
      .filter((line) => !line.trim().startsWith("/"))
      .join("\n")
    fail(
      `downstream typecheck failed (${config})`,
      diagnostics + checked.stderr,
    )
  }

  if (programFiles.length === 0) {
    fail(
      `tsc reported no program files for ${config} — the audit below would be vacuous`,
    )
  }

  // Anything resolved out of this repo's OWN sources (i.e. not from a
  // node_modules dependency and not the fixture itself) must have come from
  // dist/lib — that is the only thing the exports map points at.
  const fromRepo = programFiles.filter(
    (file) =>
      file.startsWith(repoRoot + "/")
      && !file.startsWith(fixtureDir + "/")
      && !file.includes("/node_modules/"),
  )
  const outsideDistLib = fromRepo.filter(
    (file) => !file.startsWith(join(repoRoot, "dist/lib") + "/"),
  )
  if (outsideDistLib.length > 0) {
    fail(
      `${config} resolved package files outside dist/lib — resolution did not go through the exports map`,
      outsideDistLib.join("\n"),
    )
  }

  for (const entry of ["supervisor.d.ts", "control-contract.d.ts"]) {
    const expected = join(repoRoot, "dist/lib", entry)
    if (!fromRepo.includes(expected)) {
      fail(
        `${config} never loaded dist/lib/${entry} — the fixture is not exercising the entrypoint`,
        fromRepo.join("\n"),
      )
    }
  }

  console.log(
    `  ✓ ${config}: ${String(programFiles.length)} files, ${String(fromRepo.length)} from dist/lib, 0 from src/`,
  )
}

console.log("\n✓ downstream contract typecheck passed")
