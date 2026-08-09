/**
 * The `bin` must declare the runtime that can actually execute it.
 *
 * `package.json`'s `bin.maximal` points at `dist/main.js`, which `bun build
 * --target=bun` produces. A `--target=bun` bundle uses Bun-runtime internals —
 * `__require` above all — that Node does not provide. So the shebang decides
 * whether the shipped CLI runs at all, and it is the ONE line of the artifact
 * that no other check looks at.
 *
 * IT SHIPPED WRONG. `src/main.ts` carried `#!/usr/bin/env node`, the bundler
 * preserved it, and `@stuffbucket/maximal-core@0.4.4` went to the registry with
 * a `bin` that Node picks up and dies in:
 *
 *     $ ./node_modules/.bin/maximal start --port 0
 *      ERROR  __require is not a function
 *         at node_modules/@stuffbucket/maximal-core/dist/main.js:33557:14
 *
 * `--version` printed `0.4.4` and looked fine, because citty answers it before
 * reaching the module that needs `__require`. That is why a smoke test of the
 * bin would have missed this and why the check below is on the shebang itself.
 *
 * WHY NOTHING ELSE COVERS IT. `downstream/check.ts` symlinks the package, so
 * `files` and `bin` are never exercised — it proves the exports map compiles.
 * `verify:artifact` and `e2e:binary` run the `--compile` binary, where a shebang
 * is meaningless. Every e2e harness spawns `process.execPath` — the Bun already
 * running — rather than the bin through its own shebang. And `bindings:check`
 * compares bytes, so identical wrong bytes are identical.
 *
 * WHY IT LIVES IN `tests/` AND NOT `scripts/ops/check-bindings.test.ts`, where
 * the rest of the build-config parity assertions are: that suite runs in
 * `check:ops`, which runs in `tooling-ci.yml`, which is path-filtered to
 * `scripts/ops/**`, `package.json` and `.bun-version`. A change to
 * `src/main.ts`'s first line would not trigger it. `bun test` runs in the
 * required `test` job on every PR, which is where a gate on this has to be.
 *
 * The expectation is DERIVED, not recorded: the interpreter comes from the
 * `--target=` the bundler is actually invoked with. That used to be readable
 * straight out of `package.json`'s `build` script; `build` is now
 * `scripts/ops/build-bundle.ts` (an inline `bun build` could not carry the pin
 * guard), so the argv it bundles with — `MAIN_BUILD_ARGV` — is the source of
 * truth. Retarget the build and this follows, rather than going stale and
 * asserting the old runtime.
 */
import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import packageJson from "../package.json" with { type: "json" }
import { MAIN_BUILD_ARGV } from "../scripts/ops/check-bindings"

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))

/**
 * The first line, without its line terminator.
 *
 * `split(/\r?\n/u)`, not `split("\n")`. There is no `.gitattributes` here, so a
 * Windows checkout can carry CRLF, and splitting on `\n` alone leaves the `\r`
 * on the end of every line — which makes the shebang compare unequal to itself
 * and fails this suite on `ci.yml`'s `windows` job while passing everywhere
 * else. `scripts/dev/harness/sidecar.ts`'s `lineSplitter` already carries this
 * warning; this is the same trap, in the same repo, one file over.
 */
const readFirstLine = (file: string): string =>
  fs.readFileSync(`${REPO_ROOT}${file}`, "utf8").split(/\r?\n/u)[0] ?? ""

/**
 * The `--target=<t>` `bun run build` bundles with. `undefined` when the build
 * names none, which is itself worth failing on: a bundle whose target is
 * implicit has no shebang this test could justify.
 */
export function buildTarget(argv: ReadonlyArray<string>): string | undefined {
  const flag = argv.find((a) => a.startsWith("--target="))
  return flag?.slice("--target=".length)
}

/** The interpreter a `--target=<t>` bundle must ask the OS for. */
export function shebangFor(target: string): string {
  return `#!/usr/bin/env ${target}`
}

describe("the shipped bin declares the runtime that can run it", () => {
  it("the bundler is invoked with an explicit --target", () => {
    expect(buildTarget(MAIN_BUILD_ARGV)).toBe("bun")
  })

  // The source of the shebang. `bun build` preserves the entry's first line
  // verbatim, so this is where the artifact's shebang is actually decided.
  it("src/main.ts asks for the build's target, not another runtime", () => {
    const target = buildTarget(MAIN_BUILD_ARGV) ?? ""
    expect(readFirstLine("src/main.ts")).toBe(shebangFor(target))
  })

  // The artifact itself, because the entry's shebang only matters if it
  // survives the bundler. `dist/main.js` is force-tracked, so this reads what
  // a consumer receives rather than what a rebuild would produce.
  it("the committed dist/main.js carries it too", () => {
    const target = buildTarget(MAIN_BUILD_ARGV) ?? ""
    expect(readFirstLine("dist/main.js")).toBe(shebangFor(target))
  })

  // Belt and braces on the link between them: a repointed `bin` would leave
  // this checking a file nobody runs.
  it("bin.maximal is the file whose shebang was just checked", () => {
    expect(packageJson.bin.maximal).toBe("./dist/main.js")
  })
})
