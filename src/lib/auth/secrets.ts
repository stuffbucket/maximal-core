/**
 * File-based secrets loader.
 *
 * Reads provider keys from `~/.local/share/maximal/secrets/<name>`.
 * Env vars still win — this is a fallback for "I don't want my API
 * key in shell history."
 *
 * Format: one key value per file, trailing whitespace stripped. On POSIX the
 * file must be mode 0600; broader modes are warned about and skipped (the
 * proxy refuses to read a key that any other user can read). Windows has no
 * POSIX mode bits, so that gate does not apply there — see
 * {@link modeIsOwnerOnly}.
 *
 * The directory is created on first read with mode 0700 if absent.
 *
 * `SECRET_DEFS` is the canonical list of known secrets — boot
 * loader, debug subcommand, and `/_debug/state` all iterate this
 * table so adding a third provider is a one-line change.
 */

import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"

const SECRETS_DIR = path.join(PATHS.APP_DIR, "secrets")
const SAFE_FILE_MODE = 0o600
const SAFE_DIR_MODE = 0o700

export type SecretSource = "env" | "file" | "unset"

/**
 * True when a secrets file's on-disk permissions are narrow enough to read it.
 *
 * POSIX: the low 9 bits must be exactly {@link SAFE_FILE_MODE}. Anything
 * broader means group or world can read the key, so we refuse rather than let
 * a drive-by chmod become a credential leak.
 *
 * **win32: the gate is skipped, not inverted.** Windows has no POSIX mode
 * bits; Node synthesizes `stats.mode` from the read-only attribute alone, so
 * every writable file reports 0o666. The comparison above therefore rejected
 * *every* secrets file on the platform we ship a `windows-x64` binary for —
 * the file tier was dead code there, its only symptom a misleading
 * "insecure mode 666" warning. There is nothing equivalent to check in its
 * place: Node exposes no ACL API, and the secrets dir lives under `%APPDATA%`,
 * which Windows already ACLs to the owning user. So on win32 the
 * "no one else can read this" property is delegated to the directory ACL
 * rather than asserted here.
 */
function modeIsOwnerOnly(mode: number): boolean {
  if (process.platform === "win32") return true
  return (mode & 0o777) === SAFE_FILE_MODE
}

export interface SecretRead {
  /** The resolved value, or undefined if neither source produced one. */
  value: string | undefined
  /** Where the value came from. */
  source: SecretSource
  /** Diagnostic message about file-mode warnings, etc. Used by debug
   *  subcommand and /_debug/state. Empty when there's nothing to say. */
  diagnostic?: string
}

/** Read a secret with env > file > unset precedence. The env-var name
 *  and file name are separate; conventionally the env is uppercase
 *  (`OLLAMA_API_KEY`) and the file is the provider name lowercase
 *  (`ollama`). */
export function readSecret(opts: {
  envVar: string
  fileName: string
  /** Override env source (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Override the secrets dir (tests). */
  dir?: string
}): SecretRead {
  const env = opts.env ?? process.env
  const envVal = env[opts.envVar]
  if (envVal !== undefined && envVal.length > 0) {
    return { value: envVal, source: "env" }
  }

  const dir = opts.dir ?? SECRETS_DIR
  const file = path.join(dir, opts.fileName)

  // Open once and operate on the fd to avoid a TOCTOU race between the
  // mode check and the read. ENOENT on openSync → "unset"; any other
  // open failure → "unset" (best effort, treat as unreadable).
  let fd: number
  try {
    // O_NOFOLLOW refuses to traverse symlinks so a planted symlink under
    // any dir can't redirect the read.
    //
    // win32: `fs.constants.O_NOFOLLOW` is undefined there (Bun matches Node —
    // the constant is only installed where the platform `#define`s it), so this
    // degrades to `O_RDONLY | undefined` === `O_RDONLY`, a plain open. Neither
    // runtime can express no-follow through `fs.open` flags on Windows at all,
    // and the only alternative — an `lstat` pre-check — would reinstate exactly
    // the TOCTOU race this fd-based read exists to avoid. So, as with
    // {@link modeIsOwnerOnly}, the property is delegated to the `%APPDATA%`
    // directory ACL: an attacker who can plant a symlink there can already
    // overwrite the secret file outright.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return { value: undefined, source: "unset" }
  }

  try {
    const stats = fs.fstatSync(fd)

    if (!stats.isFile()) {
      return {
        value: undefined,
        source: "unset",
        diagnostic: `${file} is not a regular file; ignored`,
      }
    }

    // POSIX file mode lives in the lower 9 bits of stats.mode; see
    // modeIsOwnerOnly for why win32 takes a different branch.
    const mode = stats.mode & 0o777
    if (!modeIsOwnerOnly(mode)) {
      const msg = `${file} has insecure mode ${mode.toString(8).padStart(3, "0")} (expected 600); skipped`
      consola.warn(msg)
      return { value: undefined, source: "unset", diagnostic: msg }
    }

    let value: string
    try {
      value = fs.readFileSync(fd, "utf8").trim()
    } catch {
      return {
        value: undefined,
        source: "unset",
        diagnostic: `${file} could not be read`,
      }
    }
    if (value.length === 0) {
      return { value: undefined, source: "unset" }
    }
    return { value, source: "file" }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* best effort */
    }
  }
}

/** Materialize a secret into process.env if not already present.
 *  Used by the boot sequence so the rest of the codebase (existing
 *  process.env reads in selectExecutor, debug, etc.) keeps working
 *  without per-call rewiring. */
export function loadSecretIntoEnv(opts: {
  envVar: string
  fileName: string
}): SecretRead {
  const r = readSecret(opts)
  if (r.source === "file" && r.value !== undefined) {
    process.env[opts.envVar] = r.value
  }
  return r
}

/** Ensure the secrets dir exists with safe perms. Creates with
 *  0o700 if absent. Idempotent. */
export function ensureSecretsDir(dir: string = SECRETS_DIR): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: SAFE_DIR_MODE })
  } catch {
    /* best effort — caller will see ENOENT or EACCES on read */
  }
}

/** @public Surfaced in `debug` output and external tooling for the secrets dir path. */
export const SECRETS_PATHS = {
  DIR: SECRETS_DIR,
}

/** Canonical list of known secrets. Extend here, not at call sites. */
export interface SecretDef {
  /** Display name for diagnostic output (`debug`, `/_debug/state`). */
  name: string
  envVar: string
  fileName: string
  /** Optional read-back of the value from AppConfig — only some
   *  secrets (e.g. `anthropicApiKey`) have a config-tier fallback. */
  readConfig?: (config: { anthropicApiKey?: string }) => string | undefined
}

export const SECRET_DEFS: ReadonlyArray<SecretDef> = [
  { name: "ollama_api_key", envVar: "OLLAMA_API_KEY", fileName: "ollama" },
  {
    name: "anthropic_api_key",
    envVar: "ANTHROPIC_API_KEY",
    fileName: "anthropic",
    readConfig: (c) => c.anthropicApiKey,
  },
]

/** Returns true if the on-disk secrets file matches `value` and is
 *  mode 0600. Used by debug surfaces to distinguish env-from-file
 *  from env-from-shell. Best-effort — any I/O error → false. */
export function secretIsFromFile(fileName: string, value: string): boolean {
  const filePath = path.join(SECRETS_DIR, fileName)
  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return false
  }
  try {
    const stats = fs.fstatSync(fd)
    if (!stats.isFile()) return false
    if (!modeIsOwnerOnly(stats.mode)) return false
    return fs.readFileSync(fd, "utf8").trim() === value
  } catch {
    return false
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* best effort */
    }
  }
}
