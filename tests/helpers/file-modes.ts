/**
 * Portable assertions for "this file holds a secret, so only its owner may
 * read it" — the property every 0o600 write in this repo is reaching for.
 *
 * That property is expressible through `fs.stat` on POSIX and NOT expressible
 * through it on Windows, so a single `expect(mode & 0o777).toBe(0o600)` is a
 * POSIX statement wearing a portable costume. Windows stores permissions in
 * ACLs; Node synthesizes `stats.mode` from the read-only attribute alone, so
 * every writable file reports 0o666 no matter how it was created and no matter
 * what its ACL says. There is no `fs` call that reads back the real ACL.
 *
 * So the helpers below split the assertion honestly:
 *
 *   - POSIX — assert the exact mode. This is the real check and it still runs
 *     on every ubuntu/macOS lane.
 *   - Windows — assert everything that IS observable (the file exists and is a
 *     regular file) and record, in one place, that the confidentiality half is
 *     delegated to the parent directory's ACL (`%APPDATA%` / `%LOCALAPPDATA%`
 *     are per-user by default) rather than asserted.
 *
 * The point of routing every call site through here is that the gap is stated
 * once, in code, instead of being 0 or 6 silently-skipped assertions scattered
 * across three test files.
 */

import { expect } from "bun:test"
import fs from "node:fs"

const IS_WINDOWS = process.platform === "win32"

/** Mode a secret-bearing file is written with on POSIX: owner read/write. */
export const OWNER_ONLY_MODE = 0o600

/**
 * Assert `filePath` is owner-only.
 *
 * On POSIX this is `mode & 0o777 === 0o600`. On Windows the mode bits carry no
 * information (see the module comment), so this degrades to asserting the file
 * exists and is regular — the write landed where we said it would — while the
 * "no other principal can read it" half is left to the directory ACL and is
 * NOT covered by this suite on that platform.
 */
export function expectOwnerOnlyFile(filePath: string): void {
  const stats = fs.statSync(filePath)
  expect(stats.isFile()).toBe(true)
  if (IS_WINDOWS) return
  expect(stats.mode & 0o777).toBe(OWNER_ONLY_MODE)
}
