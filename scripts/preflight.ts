/**
 * preflight.ts — the first step of `check:deep`. Fails when `node_modules` is
 * absent, so the steps after it cannot misattribute that.
 *
 * WHY: on a fresh checkout — and especially a git worktree, where module
 * resolution walks up to the parent checkout so most steps still pass — `knip`
 * reports phantom unused devDependencies and unlisted binaries, and
 * `bindings:check` reports the committed `dist` as STALE. Both name a cause
 * that is not the cause, and each one has cost an agent a debugging session.
 *
 * WHAT IT DOES NOT CHECK: whether the install is complete, or current. A
 * half-finished `bun install`, or one that predates a `package.json` change,
 * passes here. This answers one question — is there a `node_modules` at all —
 * and says so rather than implying more.
 *
 * It does not run `bun install`. A check that silently mutates the environment
 * is its own defect.
 */

import fs from "node:fs"
import path from "node:path"

// This repo's own node_modules, deliberately not a resolved one: in a worktree
// `bun` finds the parent checkout's copy, which is the trap being named here.
const root = path.resolve(import.meta.dir, "..")

if (!fs.existsSync(path.join(root, "node_modules"))) {
  console.error(
    `preflight: no node_modules in ${root} — dependencies are not installed.\n\n` +
      "Later steps will fail naming something else — knip reports phantom unused\n" +
      "devDependencies and unlisted binaries, bindings:check reports the committed\n" +
      "dist as STALE. That is this, not your changes.\n\n" +
      "    bun install\n\n" +
      "This only checks that node_modules exists. It does not verify the install\n" +
      "is complete or current with package.json — that is still on you.",
  )
  process.exit(1)
}
