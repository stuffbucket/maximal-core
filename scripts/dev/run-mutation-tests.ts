#!/usr/bin/env bun
/**
 * `bun run test:mutation` — the command Stryker's `testRunner: "command"`
 * executes once per mutant (`stryker.conf.json`).
 *
 * WHY THIS IS A SCRIPT AND NOT A `bun test …` ONE-LINER. A command runner
 * decides "killed" or "survived" from the child's EXIT CODE alone. Exit 0 is
 * read as "the suite passed, this mutant survived" — including when the suite
 * never finished. Measured: under the `isLoopbackAddress` mutant
 * `if (!address) return false` → `return true`, an in-process `app.request` has
 * a null peer IP, so it passes the loopback gate on `/_internal/shutdown`,
 * whose handler exits the process. The run died after 9 of 132 files with exit
 * code 0 and no summary, and the mutant — one that KILLS THE TEST PROCESS —
 * was scored SURVIVED on the security surface where it matters most.
 *
 * THE RULE: trust the exit code only once the run has proven it COMPLETED.
 * `bun test` writes `Ran <n> tests across <n> files.` to stderr after the last
 * file and nowhere else; a process that died mid-run cannot have written it.
 * So:
 *   - marker present  → exit with bun's own code, verbatim. A legitimately
 *     failing suite still exits non-zero and the mutant is still KILLED; a
 *     clean suite still exits 0 and the mutant is still SURVIVED. This script
 *     adds no verdicts of its own, so it can invent neither a false kill nor a
 *     false survivor.
 *   - marker absent → the run is INCONCLUSIVE, not a pass. Exit non-zero and
 *     record the mutant id in `reports/mutation/incomplete-runs.log`.
 *
 * ON THAT LAST BRANCH: Stryker's command runner has a two-valued channel —
 * `MutantRunStatus.Error` is reachable only from a spawn failure, so a child
 * process cannot report "inconclusive" and this exit is scored KILLED. That
 * over-counts, which is why the ledger exists: any sweep whose log file is
 * non-empty has kills that were not earned, named by mutant id. The branch is
 * an alarm rather than a routine path because the mechanism that produced it —
 * product code calling `process.exit` inside the runner — is now blocked in
 * `tests/test-setup.ts`, which turns such a mutant into an ordinary test
 * failure instead.
 *
 * SCOPE: the whole suite minus six port-binding / process-spawning files.
 * Never narrow it further — see `docs/dev/testing-strategy.md` §6.
 *
 * Exit codes: bun's own when the run completed · 97 when it did not.
 */

/**
 * Files excluded from the mutation runner. They bind real ports or spawn real
 * processes (docs/dev/testing-strategy.md §5.8) and Stryker runs N suites
 * concurrently, so a collision produces a FALSE KILL — it hides a survivor.
 * None exercises pure request-path logic, so excluding them costs no kills.
 */
const EXCLUDED = [
  "start-run-server",
  "start-unauthenticated",
  "start-multi-account",
  "spawned-engine-ports",
  "cli-branding",
  "main-cli-global-options",
]

/** Written by `bun test` to stderr after the final file, and nowhere else. */
const COMPLETION_MARKER = /^Ran \d+ tests? across \d+ files?\./m

const INCOMPLETE_EXIT_CODE = 97
const LEDGER_PATH = "reports/mutation/incomplete-runs.log"

const files = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: "tests" })]
  .map((file) => `tests/${file}`)
  .filter((file) => !EXCLUDED.some((name) => file.includes(name)))
  .sort()

if (files.length === 0) {
  console.error("test:mutation: no test files matched — refusing to report a pass")
  process.exit(INCOMPLETE_EXIT_CODE)
}

const child = Bun.spawn(["bun", "test", ...files], {
  stderr: "pipe",
  stdin: "inherit",
  stdout: "inherit",
})

// Tee stderr through so Stryker still captures it as the failure message,
// while accumulating it to look for the completion marker.
let stderrText = ""
for await (const chunk of child.stderr) {
  stderrText += new TextDecoder().decode(chunk)
  process.stderr.write(chunk)
}

const exitCode = await child.exited

if (COMPLETION_MARKER.test(stderrText)) {
  process.exit(exitCode)
}

const mutant = process.env.__STRYKER_ACTIVE_MUTANT__ ?? "none (direct run)"
console.error(
  `\ntest:mutation: SUITE DID NOT COMPLETE (exit ${exitCode}, mutant ${mutant}).`
    + "\nNo `Ran <n> tests across <n> files.` summary was written, so this run"
    + " proves nothing about the mutant and its exit code is not a verdict."
    + `\nRecorded in ${LEDGER_PATH}.`,
)

await Bun.write(
  LEDGER_PATH,
  (await Bun.file(LEDGER_PATH).text().catch(() => ""))
    + `${new Date().toISOString()} mutant=${mutant} exit=${exitCode}\n`,
)

process.exit(INCOMPLETE_EXIT_CODE)
