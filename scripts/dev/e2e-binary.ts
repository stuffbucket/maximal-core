/**
 * Harness: run the whole e2e suite against the **compiled** binary.
 *
 * `bun run e2e` exercises the engine from source. That is not what ships. The
 * DMG carries a `bun build --compile` executable, and compilation is its own
 * execution environment — `--define` substitution, bundled asset resolution and
 * embedded-runtime behaviour all differ from a source run. A defect that only
 * appears once compiled would otherwise be found by a user, in a signed build,
 * with no stack trace worth reading.
 *
 * So: compile for the host, then re-run the existing seam / feed / lifecycle
 * harnesses against it via `MAXIMAL_E2E_BINARY`. Same assertions, shipped
 * artifact. Nothing is duplicated — the checks live where they already lived.
 *
 * Host target only. Cross-compiled Windows binaries cannot be executed here, so
 * `bun run build:binary --target=bun-windows-x64` verifies they *build*; proving
 * they *run* needs a Windows runner.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildBinary } from "./build-binary"

const workdir = mkdtempSync(join(tmpdir(), "maximal-binary-e2e-"))
const binary = join(workdir, "maximal")

console.log("\ne2e:binary — the compiled artifact, not the source tree\n")
console.log("compiling for the host…")

// `--fast`: minify/sourcemap change size and stack traces, not behaviour, and
// they roughly triple the build. The release build applies them.
const { ok } = buildBinary({ outfile: binary, fast: true })
if (!ok) {
  console.error("FAIL  could not compile the binary")
  rmSync(workdir, { recursive: true, force: true })
  process.exit(1)
}

const suites = ["e2e:seam", "e2e:feed", "e2e:lifecycle"]
let failed = false

try {
  for (const suite of suites) {
    const res = spawnSync("bun", ["run", suite], {
      stdio: "inherit",
      env: { ...process.env, MAXIMAL_E2E_BINARY: binary },
    })
    if (res.status !== 0) failed = true
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

console.log(
  failed ?
    "\nFAIL  the compiled binary does not behave like the source tree\n"
  : "\nok    the compiled artifact passes every source-tree check\n",
)
process.exit(failed ? 1 : 0)
