/**
 * Boot must survive a `config.json` it cannot rewrite.
 *
 * `readConfigFromDisk` wraps its read in a `try` and falls back to defaults with
 * a logged error — but `ensureConfigFile()` was called OUTSIDE that `try`. When
 * the file exists and is readable but not writable, `ensureConfigFile`'s
 * access check fails, it takes the "create it" branch, and the `writeFileSync`
 * throws `EACCES` straight past every guard in the read path. `run-server.ts`
 * calls this through `mergeConfigWithDefaults()` before the port is bound, so
 * the proxy dies at boot printing a raw errno — and the user's config, which
 * was perfectly readable, is never even opened.
 *
 * A read-only config is a state users create deliberately (it holds
 * `anthropicApiKey`) and one they inherit accidentally (a file left owned by
 * root after a single `sudo` run). Either way `ensureConfigFile` is a
 * best-effort convenience: if it cannot seed a file, the read below is still
 * entitled to try.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"

import { mergeConfigWithDefaults } from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"

const CONFIG_PATH = PATHS.CONFIG_PATH

/** Restore write permission (if the file is still there) and delete it, so the
 *  shared per-worker COPILOT_API_HOME is left exactly as a fresh boot would
 *  find it. Runs on the way IN and the way OUT — a module-level `cachedConfig`
 *  only reset on one side leaks in the other direction (testing-strategy §5.6),
 *  and the trailing `mergeConfigWithDefaults()` reseeds it from a clean file. */
function resetConfigFile(): void {
  try {
    fs.chmodSync(CONFIG_PATH, 0o600)
  } catch {
    /* not there, or the platform has no mode bits */
  }
  fs.rmSync(CONFIG_PATH, { force: true })
  mergeConfigWithDefaults()
}

beforeEach(resetConfigFile)
afterEach(resetConfigFile)

/** True when the platform actually made the file unwritable. Windows has no
 *  POSIX mode bits; `chmodSync` maps only the read-only attribute, so this is a
 *  precondition to check rather than assume.
 *
 *  It is a precondition, NOT an escape hatch. On POSIX a 0o400 file is
 *  unwritable, and a false there means the fixture silently stopped existing —
 *  both cases below would fall through to asserting that a file is a file and
 *  report green while checking nothing. The way to get that is running as root,
 *  which bypasses DAC: exactly what a container run as root does, and why
 *  `docs/dev/container-toolchain.md` runs as the host uid instead. Fail loudly
 *  rather than quietly stop testing. */
function makeUnwritable(file: string): boolean {
  fs.chmodSync(file, 0o400)
  let writable = true
  try {
    fs.accessSync(file, fs.constants.W_OK)
  } catch {
    writable = false
  }
  if (!writable) return true
  if (process.platform !== "win32") {
    throw new Error(
      `${file} is still writable at mode 0o400, so this test cannot construct `
        + `its fixture. Almost certainly the suite is running as root, which `
        + `bypasses DAC — run as an unprivileged user. See `
        + `docs/dev/container-toolchain.md.`,
    )
  }
  return false
}

describe("config boot with an unwritable config.json", () => {
  test("reads the user's settings instead of dying with a raw errno", () => {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      CONFIG_PATH,
      `${JSON.stringify({ smallModel: "gpt-5-mini-readonly" }, null, 2)}\n`,
      "utf8",
    )
    if (!makeUnwritable(CONFIG_PATH)) {
      // Fixture not constructible here; assert what is still observable.
      expect(fs.statSync(CONFIG_PATH).isFile()).toBe(true)
      return
    }

    const config = mergeConfigWithDefaults()

    expect(config.smallModel).toBe("gpt-5-mini-readonly")
  })
})
