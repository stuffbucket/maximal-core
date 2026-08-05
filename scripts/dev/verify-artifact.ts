/**
 * Verify a *shipped* binary — the exact file that will be uploaded to a release.
 *
 * ## Why this is not the dev-loop staleness check
 *
 * `scripts/dev/verify-build.ts` (`bun run dev:stale-check`) used to be called
 * `verify:build`, which read like the release check its name implied and is not
 * one. It takes no artifact: it probes a proxy already *running* on the
 * developer's machine, extracts the `+<sha>` suffix an `app:dev` build embeds
 * in `x-maximal-version`, and compares that commit to `origin/main`. A release
 * binary is built by `buildBinary()` with `__MAXIMAL_VERSION__` set to
 * package.json's version and **no `+<sha>` suffix**, so the check reports
 * `UNKNOWN` and exits 1 on every release artifact, by construction. It also
 * reads the developer's own `config.json` to report a flag one E2E scenario
 * needs. Useful for "is my dev sidecar stale"; structurally unable to gate a
 * release. Run it against a compiled binary and see for yourself.
 *
 * ## What this checks instead
 *
 * Given a path and the version the release claims to be:
 *
 *   1. `<binary> --version` prints exactly that version. Catches a binary built
 *      from the wrong tree, or a matrix leg that shipped a stale cache.
 *   2. The binary boots on ephemeral ports, in a throwaway `COPILOT_API_HOME`,
 *      and announces its ready-line — the same contract a supervising host
 *      parses (`~/lib/live/supervisor`).
 *   3. `GET /status` returns 200 with `x-maximal-version` equal to that same
 *      version. This is the assertion docs/release-runbook.md always claimed
 *      the staleness check made.
 *   4. `SIGTERM` stops it. A release artifact that will not shut down is one a
 *      host cannot quit. On Windows there is no SIGTERM to send — `kill()` is
 *      `TerminateProcess` — so this check proves the process is terminable
 *      there, not that it drained.
 *
 * Deliberately cross-platform and network-free: it must give the same verdict
 * on a Windows runner as on macOS, and it must not need a GitHub token. The
 * deeper behavioural suite is `e2e:binary --binary=<path>`, which now runs on
 * both platforms too.
 *
 * Usage:
 *   bun run verify:artifact -- --binary dist-bin/maximal
 *   bun run verify:artifact -- --binary out/maximal.exe --expect-version 0.3.2
 *
 * Exit codes: 0 every check passed, 1 something failed.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import packageJson from "../../package.json" with { type: "json" }

import { createReporter, startSidecar, waitForExit } from "./harness/sidecar"

const SIGTERM_GRACE_MS = 10_000

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")

const binaryArg = flag("binary")
if (!binaryArg) {
  console.error("usage: verify-artifact.ts --binary=<path> [--expect-version=<v>]")
  process.exit(1)
}
const binary = resolve(binaryArg)
// A tag may legitimately lead package.json in the window release-tag-check.yml
// exists to close, so the expected version is an explicit input; package.json
// is only the local-run default.
const expected = flag("expect-version") ?? packageJson.version

if (!existsSync(binary)) {
  console.error(`FAIL  no such artifact: ${binary}`)
  process.exit(1)
}

// startSidecar() launches whatever MAXIMAL_E2E_BINARY names. Setting it here is
// what points the shared harness at the artifact instead of the source tree.
process.env.MAXIMAL_E2E_BINARY = binary

const report = createReporter(
  `verify:artifact — the file we are about to publish, expecting v${expected}`,
)

const cli = spawnSync(binary, ["--version"], { encoding: "utf8" })
// `--version` prints through consola, which prefixes a level tag (`[log] `) and
// drops colour whenever stdout is not a TTY — a terminal sees `0.3.1` and a CI
// runner sees `[log] 0.3.1`. Comparing the whole line would pass locally and
// fail on every runner, so pull the semver token out instead.
const rawVersion = (cli.stdout ?? "").replace(/\[[0-9;]*m/g, "").trim()
const printed = rawVersion.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? null
report.check(
  "--version",
  cli.status === 0 && printed === expected,
  cli.status === 0 ?
    `printed ${JSON.stringify(rawVersion)}${printed === expected ? "" : ` — expected ${JSON.stringify(expected)}`}`
  : `exited ${cli.status ?? "null"}: ${(cli.stderr ?? "").trim() || "no stderr"}`,
)

const sidecar = await startSidecar()
report.check(
  "ready-line",
  sidecar.proxyPort > 0 && sidecar.port > 0,
  `proxy=${sidecar.proxyPort} control=${sidecar.port} pid=${sidecar.pid}`,
)

let status: Response | null = null
try {
  status = await fetch(`${sidecar.proxyUrl}/status`, {
    signal: AbortSignal.timeout(10_000),
  })
} catch (error) {
  status = null
  console.error(`  /status fetch threw: ${String(error)}`)
}
const header = status?.headers.get("x-maximal-version") ?? null
report.check(
  "version header",
  status?.status === 200 && header === expected,
  status === null ?
    "no response from the bound proxy port"
  : `HTTP ${status.status} x-maximal-version=${header ?? "<absent>"}`,
)

sidecar.child.kill("SIGTERM")
const exit = await waitForExit(sidecar.child, SIGTERM_GRACE_MS)
report.check(
  "shutdown",
  exit !== null,
  exit ?
    `exited code=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`
  : `still running ${SIGTERM_GRACE_MS}ms after SIGTERM — a host quit would hang`,
)
if (exit === null) sidecar.child.kill("SIGKILL")

report.finish()
