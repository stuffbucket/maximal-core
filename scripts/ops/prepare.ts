#!/usr/bin/env bun
/**
 * `prepare` — install the git hooks, and verify they actually landed.
 *
 * This is a TypeScript file rather than an inline `package.json` shell string
 * on purpose. The inline version used `> /dev/null 2>&1` and `$(…)`, which
 * Bun's built-in shell rejects on Windows:
 *
 *     error: expected a command or assignment but got: "Redirect"
 *     error: prepare script from "@stuffbucket/maximal" exited with 1
 *
 * That failed `bun install` outright on Windows. Nothing caught it: `ci.yml`
 * was Linux-only, and the sole Windows leg ran on a tag push — so it surfaced
 * only after v0.4.2 was tagged, with the release left asset-less. `ci.yml` now
 * has a `windows` job whose whole point is running this script under Bun's
 * Windows shell on every PR; that pipeline is gone, this check is not.
 *
 * The verification itself exists because `simple-git-hooks` ends its CLI in
 * `.catch(e => console.log(...))`, so every install error exits 0 — a failed
 * install silently removes the pre-commit lint and secret scan.
 *
 * `git rev-parse --git-path hooks` resolves through the common dir, so a linked
 * worktree correctly reports the main checkout's hooks directory. Outside a git
 * repo (a consumer installing this as a dependency) this is a no-op.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** Run a command, returning stdout trimmed, or null if it failed to run. */
function run(cmd: string, args: Array<string>): string | null {
  const res = spawnSync(cmd, args, { encoding: "utf8", env: process.env })
  if (res.error || res.status !== 0) return null
  return (res.stdout ?? "").trim()
}

const hooksDir = run("git", ["rev-parse", "--git-path", "hooks"])
if (hooksDir === null) {
  // Not a git repo — a consumer installing this package as a dependency.
  process.exit(0)
}

const install = spawnSync(process.execPath, ["x", "simple-git-hooks"], {
  encoding: "utf8",
  env: process.env,
  stdio: "inherit",
})
if (install.error) {
  console.error(`prepare: could not run simple-git-hooks: ${install.error.message}`)
  process.exit(1)
}

// Do not trust the exit code: simple-git-hooks swallows its own failures.
const preCommit = join(hooksDir, "pre-commit")
if (!existsSync(preCommit)) {
  console.error(
    `prepare: simple-git-hooks reported success but ${preCommit} does not exist.\n`
      + "The pre-commit lint and secret scan are NOT installed. Check the\n"
      + "`simple-git-hooks` block in package.json and re-run `bun install`.",
  )
  process.exit(1)
}
