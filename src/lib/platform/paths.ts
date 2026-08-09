import nodeFs from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AUTH_APP = process.env.COPILOT_API_OAUTH_APP?.trim() || ""
const ENTERPRISE_PREFIX = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""

/** Inputs to {@link resolveAppDir}, injected so the resolver is pure/testable. */
export interface AppDirEnv {
  platform: NodeJS.Platform
  homedir: string
  /** `COPILOT_API_HOME` override (highest precedence on every platform). */
  copilotApiHome?: string
  /** `%APPDATA%` (win32 only); falls back to `<home>\AppData\Roaming`. */
  appData?: string
}

/**
 * Resolve the single app-data root, per the cross-platform convention:
 *   - `COPILOT_API_HOME` overrides everywhere (highest precedence).
 *   - win32:  `%APPDATA%\maximal`  (fallback `<home>\AppData\Roaming\maximal`).
 *   - else:   `<home>/.local/share/maximal`  (macOS + Linux, unchanged).
 *
 * Logs live at `<root>/logs` on every platform — the caller derives that from
 * this single root, so there is exactly one place the convention is encoded.
 *
 * Pure by design: it does no I/O and never throws, so the win32 branch is
 * testable from POSIX and vice versa. Whether the resolved home must already
 * exist is a separate question, answered by {@link resolveHomePolicy} and
 * enforced by {@link requireExistingHome}, both applied once below.
 */
export function resolveAppDir(env: AppDirEnv): string {
  const override = env.copilotApiHome?.trim()
  if (override) {
    return override
  }
  if (env.platform === "win32") {
    const roaming =
      env.appData?.trim() || path.join(env.homedir, "AppData", "Roaming")
    return path.join(roaming, "maximal")
  }
  return path.join(env.homedir, ".local", "share", "maximal")
}

/** How maximal treats a data home that is not there yet. */
export type HomePolicy = "create" | "require"

/** Env var carrying {@link HomePolicy}. */
export const HOME_POLICY_ENV = "COPILOT_API_HOME_POLICY"

/**
 * Read the data-home policy.
 *
 * Two values, and the default is the behaviour maximal has always had:
 *
 *   - `create` (default) — the home is maximal's own directory, so maximal
 *     looks after it: a missing one is created lazily by `ensurePaths`, exactly
 *     as before. Nothing here throws.
 *   - `require` — the home is SHARED, and the caller is the one who decides
 *     what lives there. It must already exist; maximal will not create it and
 *     will not fall back to the default. See {@link requireExistingHome}.
 *
 * An env var rather than a `config.json` key, deliberately: `config.json` lives
 * *inside* the home, so a policy about the home cannot be read from it. It is
 * also what the actual consumer can set — a host spawning maximal-core as a
 * sidecar builds a child env, and `COPILOT_API_HOME_POLICY=require` next to
 * `COPILOT_API_HOME` is one line there (maximal-core#2).
 *
 * An unrecognised value throws rather than falling back to `create`. A caller
 * who wrote `required` and got the permissive default would have silently lost
 * the only guarantee they asked for, which is the exact failure `require`
 * exists to prevent.
 */
export function resolveHomePolicy(raw: string | undefined): HomePolicy {
  const value = raw?.trim().toLowerCase()
  // Blank is unset, for the same reason a blank COPILOT_API_HOME is: `""` is
  // how a spawner clears an inherited variable.
  if (!value) return "create"
  if (value === "create" || value === "require") return value
  throw new Error(
    `${HOME_POLICY_ENV} is set to "${raw}", which is not a policy. Use`
      + ' "create" (the default — maximal creates its data home as needed) or'
      + ' "require" (the home must already exist; maximal will not create it'
      + " or fall back to the default).",
  )
}

/**
 * Require a data home to already exist and be usable, and canonicalize it.
 * Throws — loudly, naming the offending value — otherwise.
 *
 * Only reached under `COPILOT_API_HOME_POLICY=require`. That policy is opt-in
 * precisely because this is the OPPOSITE of how the rest of this codebase
 * treats a missing directory: `ensureConfigFile` (`src/lib/config/config.ts`),
 * `ensurePaths` below and `markSessionRunning` all create what is missing and
 * treat a failure to seed as best-effort, never fatal. That stays the default
 * and stays correct — the home is normally maximal's own directory, and there
 * is nobody else to ask about it.
 *
 * `require` is for the case where it is NOT maximal's own directory. A host
 * (`stuffbucket/maximal`) that spawns maximal-core as a sidecar passes a home
 * so the sidecar cannot adopt or clobber the user's own long-running instance.
 * There, a mistyped home that got created — or that silently fell back to the
 * shared default — turns a typo into two engines sharing one token store,
 * pidfile and sqlite db. A caller who needs that guarantee asks for it, and
 * then a missing home is an error rather than a hint.
 *
 * Canonicalizing (`realpathSync`) matters as much as existing: two homes that
 * resolve through different symlinks to one directory are one home, and
 * `PATHS.APP_DIR` is the string every other path in the process is joined onto.
 * It belongs to `require` rather than to `create` because there is nothing to
 * canonicalize until the directory exists, and a rule that applied only when it
 * happened to exist would be worse than either policy.
 */
export function requireExistingHome(dir: string): string {
  // Quoted by hand rather than with `JSON.stringify`, which escapes every
  // backslash: it turns `C:\Users\dev\home` into `C:\\Users\\dev\\home`, so on
  // Windows the message shows a path the reader cannot paste back and a test
  // cannot match against the value it passed in.
  const shown = `"${dir}"`
  // Names the policy, not just the path: the reader has to be able to tell
  // "this directory is missing" from "and here is the setting that made that
  // fatal", because dropping the latter is a legitimate fix.
  const because = `${HOME_POLICY_ENV}=require`
  let real: string
  try {
    real = nodeFs.realpathSync(dir)
  } catch {
    throw new Error(
      `The maximal data home ${shown} does not exist, and ${because} means`
        + " maximal must not create it or fall back to the default home — an"
        + " explicit home is how a host guarantees isolation, so a missing one"
        + " is an error, not a hint. Create the directory first, or drop"
        + ` ${HOME_POLICY_ENV} to let maximal create it.`,
    )
  }
  if (!nodeFs.statSync(real).isDirectory()) {
    throw new Error(
      `The maximal data home ${shown} is not a directory, and ${because}`
        + " requires an existing directory maximal can write to.",
    )
  }
  try {
    nodeFs.accessSync(real, nodeFs.constants.W_OK | nodeFs.constants.X_OK)
  } catch {
    throw new Error(
      `The maximal data home ${shown} (resolved to "${real}") cannot be written`
        + ` to by this process, and ${because} requires a writable home. Fix`
        + " its permissions, or point COPILOT_API_HOME somewhere writable.",
    )
  }
  return real
}

/**
 * `COPILOT_API_HOME` counts as *set* only when it is non-blank — the same
 * `trim()` gate `resolveAppDir` applies. An empty or whitespace-only value is
 * "not set": clearing an inherited variable with `COPILOT_API_HOME: ""` is how
 * every spawner in this repo asks for the default home (see
 * `tests/helpers/spawn-engine.ts` and `tests/main-cli-global-options.test.ts`),
 * and that must keep meaning the default, not a hard boot failure.
 */
const HOME_OVERRIDE = process.env.COPILOT_API_HOME?.trim()

// `resolveAppDir` stays pure — no fs, no throw. It is the shared convention
// table, and `scripts/dev/verify-build.ts` plus `tests/paths.test.ts` drive it
// with win32 paths that cannot exist on the host running them. The policy is
// applied HERE instead: once, to the single process-wide root.
//
// The policy applies to the home whatever its source, rather than only to an
// explicitly-set one. One rule is easier to hold than a conjunction, and the
// alternative makes `COPILOT_API_HOME_POLICY=require` a silent no-op for anyone
// who forgot to pass a home — the same class of quiet failure the policy exists
// to remove.
const APP_DIR = ((): string => {
  const resolved = resolveAppDir({
    platform: process.platform,
    homedir: os.homedir(),
    copilotApiHome: HOME_OVERRIDE,
    appData: process.env.APPDATA,
  })
  return resolveHomePolicy(process.env[HOME_POLICY_ENV]) === "require" ?
      requireExistingHome(resolved)
    : resolved
})()

const GITHUB_TOKEN_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "github_token",
)
// Multi-account registry (schema v2). Co-located with the legacy single-record
// token file so it inherits the same oauth-app + enterprise-prefix namespacing.
const ACCOUNTS_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "accounts.json",
)
const CONFIG_PATH = path.join(APP_DIR, "config.json")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  ACCOUNTS_PATH,
  CONFIG_PATH,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(path.join(PATHS.APP_DIR, AUTH_APP), { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  await ensureFile(PATHS.CONFIG_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
