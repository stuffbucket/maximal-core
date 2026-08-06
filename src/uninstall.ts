#!/usr/bin/env node
/**
 * `maximal uninstall` — reverse of `setup`.
 *
 * Stops the running proxy (launchd / Windows scheduled task), removes the
 * on-disk binary, and reverts every app integration through the registry
 * (`getAllApps()` → each app's ownership-guarded `uninstall()`). Refuses to run
 * while any app is still enabled — naming them — unless `--force`, which
 * disables each app first, then uninstalls. Secrets are kept by default; pass
 * `--purge` to remove them.
 *
 * Spec: docs/spec/archive/internal-distribution-stream-b.md §B6.
 */

import { defineCommand } from "citty"
import consola from "consola"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ClientApp } from "./apps/index"

import { getAllApps } from "./apps/registry"
import { PATHS } from "./lib/platform/paths"

interface RunUninstallOptions {
  purge: boolean
  /** When true, uninstall even if apps are still enabled: disable each app
   *  (idempotent) first, then run the registry revert sweep. Without it,
   *  uninstall refuses while any app is enabled. Replaces the old
   *  `--revert-claude` opt-in. */
  force: boolean
  unattended: boolean
  /** Accepted for compatibility with the shell's in-app uninstall, which
   *  passes it over IPC. maximal ships no `.app` bundle, so there is no
   *  application-bundle target left to filter — the flag is currently a
   *  no-op and every PATH binary is removed either way. */
  keepApp: boolean
}

export async function runUninstall(opts: RunUninstallOptions): Promise<void> {
  consola.box("maximal uninstall")

  // Precondition: refuse while any app still routes through the proxy, UNLESS
  // --force. Uninstall removes maximal; it must not silently rip routing out
  // from under an integration the user left switched ON. Name the enabled apps
  // and fail with what to do. `--force` means "uninstall anyway": we disable
  // each app first (step 4), so routing is cleaned up rather than orphaned.
  // Checked via the registry's isEnabled(), so this needs no per-app knowledge.
  const enabled = enabledApps()
  if (enabled.length > 0 && !opts.force) {
    const names = enabled.map((a) => a.name).join(", ")
    consola.error(`These apps are still routing through maximal: ${names}.`)
    consola.info(
      "Turn them off in Settings → Apps (or e.g. `maximal app claude-code"
        + " --disable`), then re-run `maximal uninstall`. Or pass `--force` to"
        + " disable them and uninstall in one step.",
    )
    throw new Error(
      `Refusing to uninstall while apps are enabled: ${names}. Disable them or pass --force.`,
    )
  }

  // 1. Stop the running proxy (best effort) -------------------------
  consola.info("Step 1/5: Stop the running proxy")
  stopProxy()

  // 2. Remove launchd plist / Windows scheduled task ----------------
  consola.info("Step 2/5: Remove startup integration")
  removeStartupIntegration()

  // 3. Remove the binary --------------------------------------------
  consola.info("Step 3/5: Remove the binary")
  removeBinary()

  // 4. Revert any residual app integrations ------------------------
  // Registry-driven: each app reverts its own (ownership-guarded) config via the
  // contract. With the precondition above every app is already disabled, so this
  // is a defensive sweep.
  consola.info("Step 4/5: Revert app integrations")
  await revertAppIntegrations(enabled)

  // 5. Optional: secrets --------------------------------------------
  consola.info("Step 5/5: Optional cleanup")
  await maybePurgeSecrets(opts)

  consola.box("Uninstall complete.")
}

// ────────────────────────────────────────────────────────────────────
// Step 1: stop the proxy.
// ────────────────────────────────────────────────────────────────────

function stopProxy(): void {
  if (process.platform === "darwin") {
    const r = spawnSync(
      "launchctl",
      ["bootout", `gui/${process.getuid?.() ?? 0}/co.stuffbucket.maximal`],
      { encoding: "utf8" },
    )
    if (r.status === 0) {
      consola.success("  launchd agent stopped")
    } else {
      // bootout returns non-zero if the agent isn't running. Soft
      // success — the goal is "no longer running," not "we did the
      // stop."
      consola.info("  launchd agent not running (or already removed)")
    }
    return
  }
  if (process.platform === "win32") {
    const r = spawnSync("schtasks", ["/End", "/TN", "maximal"], {
      encoding: "utf8",
    })
    if (r.status === 0) {
      consola.success("  scheduled task stopped")
    } else {
      consola.info("  scheduled task not running (or already removed)")
    }
    return
  }
  consola.info("  unsupported platform; skipping startup integration")
}

// ────────────────────────────────────────────────────────────────────
// Step 2: remove launchd plist / scheduled task.
// ────────────────────────────────────────────────────────────────────

function removeStartupIntegration(): void {
  if (process.platform === "darwin") {
    const plist = path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      "co.stuffbucket.maximal.plist",
    )
    if (fs.existsSync(plist)) {
      try {
        fs.rmSync(plist)
        consola.success(`  removed ${plist}`)
      } catch (err) {
        consola.warn(`  could not remove ${plist}`, err)
      }
    } else {
      consola.info("  launchd plist not found; nothing to remove")
    }
    return
  }
  if (process.platform === "win32") {
    const r = spawnSync("schtasks", ["/Delete", "/TN", "maximal", "/F"], {
      encoding: "utf8",
    })
    if (r.status === 0) {
      consola.success("  scheduled task unregistered")
    } else {
      consola.info("  scheduled task not registered; nothing to remove")
    }
    return
  }
  consola.info("  unsupported platform; skipping")
}

// ────────────────────────────────────────────────────────────────────
// Step 3: remove the binary.
// ────────────────────────────────────────────────────────────────────

/** Candidate install locations, in order of likelihood. We delete every
 *  one we find; a user may have copies in more than one place.
 *
 *  Homebrew is the only packaged install shape maximal has: the formula
 *  links `maximal` into `/opt/homebrew/bin` on Apple Silicon and
 *  `/usr/local/bin` on Intel. Everything else runs from a checkout or a
 *  binary the user placed themselves, neither of which we own. Windows
 *  has no packaged install path at all, so there is nothing to remove. */
export function installTargets(): Array<string> {
  if (process.platform === "win32") return []
  return ["/usr/local/bin/maximal", "/opt/homebrew/bin/maximal"]
}

function removeBinary(): void {
  let removed = 0
  for (const target of installTargets()) {
    // lstat (not existsSync) so a *broken* symlink — the brew shim still
    // pointing at a Cellar dir that has already been removed — is detected
    // and unlinked rather than silently skipped as "not found".
    try {
      fs.lstatSync(target)
    } catch {
      continue
    }
    try {
      fs.rmSync(target)
      consola.success(`  removed ${target}`)
      removed++
    } catch (err) {
      consola.warn(`  could not remove ${target}`, err)
    }
  }
  if (removed === 0) {
    consola.info("  no installed binary found")
  }
}

// ────────────────────────────────────────────────────────────────────
// Step 4: disable + revert app integrations (registry).
// ────────────────────────────────────────────────────────────────────

/** Apps currently routing through the proxy, by the contract's `isEnabled()`.
 *  Drives both the precondition message and the `--force` disable pass — no
 *  per-app knowledge lives here. */
export function enabledApps(): Array<ClientApp> {
  return getAllApps().filter((app) => app.isEnabled())
}

/**
 * Revert every app's integration via the registry. `stillEnabled` are the apps
 * that were on at invocation (only non-empty under `--force`): we `disable()`
 * each first so routing is cleaned, not orphaned. Then every app's `uninstall()`
 * runs as an ownership-guarded sweep (idempotent — safe even for already-
 * disabled apps).
 */
export async function revertAppIntegrations(
  stillEnabled: ReadonlyArray<ClientApp>,
): Promise<void> {
  for (const app of stillEnabled) {
    try {
      await app.disable()
      consola.success(`  disabled ${app.name}`)
    } catch (err) {
      consola.warn(`  could not disable ${app.name}`, err)
    }
  }
  for (const app of getAllApps()) {
    try {
      const result = await app.uninstall()
      for (const line of result.reverted) consola.success(`  ${line}`)
    } catch (err) {
      consola.warn(`  could not revert ${app.name}`, err)
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Step 4a: purge secrets + tokens.
// ────────────────────────────────────────────────────────────────────

async function maybePurgeSecrets(opts: RunUninstallOptions): Promise<void> {
  const secretsDir = path.join(PATHS.APP_DIR, "secrets")
  // Both token stores: the legacy single-record file and the multi-account
  // registry. Purge must take both, or --purge leaves every account's token
  // on disk in accounts.json.
  const tokenPaths = [PATHS.GITHUB_TOKEN_PATH, PATHS.ACCOUNTS_PATH]
  const willPurge = opts.purge || (await confirmPurge(opts))
  if (!willPurge) {
    consola.info(`  ℹ secrets dir kept (${secretsDir}); use --purge to remove`)
    consola.info(`  ℹ github tokens kept (${tokenPaths.join(", ")})`)
    return
  }
  if (fs.existsSync(secretsDir)) {
    try {
      fs.rmSync(secretsDir, { recursive: true })
      consola.success(`  removed ${secretsDir}`)
    } catch (err) {
      consola.warn(`  could not remove ${secretsDir}`, err)
    }
  }
  for (const tokenPath of tokenPaths) {
    if (!fs.existsSync(tokenPath)) continue
    try {
      fs.rmSync(tokenPath)
      consola.success(`  removed ${tokenPath}`)
    } catch (err) {
      consola.warn(`  could not remove ${tokenPath}`, err)
    }
  }
}

async function confirmPurge(opts: RunUninstallOptions): Promise<boolean> {
  if (opts.unattended) return false
  const answer = await consola.prompt(
    "Remove secrets directory and GitHub token? (default: no)",
    { type: "confirm", initial: false },
  )
  return answer
}

// ────────────────────────────────────────────────────────────────────
// citty wrapper.
// ────────────────────────────────────────────────────────────────────

export const uninstall = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Stop the proxy, remove the binary, and revert app integrations. Refuses while apps are enabled unless --force.",
  },
  args: {
    purge: {
      type: "boolean",
      default: false,
      description:
        "Also remove ~/.local/share/maximal/secrets and the GitHub token",
    },
    force: {
      type: "boolean",
      default: false,
      description:
        "Uninstall even if apps are still enabled: disable each app, then revert and remove. Without it, uninstall refuses while any app is enabled.",
    },
    unattended: {
      type: "boolean",
      default: false,
      description:
        "No prompts. Combined with default flags, leaves secrets untouched.",
    },
    "keep-app": {
      type: "boolean",
      default: false,
      description:
        "Accepted for the shell's in-app uninstall, which passes it over IPC. Currently a no-op: maximal ships no application bundle, so there is no bundle to keep and the Homebrew binaries are removed either way.",
    },
  },
  run({ args }) {
    return runUninstall({
      purge: args.purge,
      force: args.force,
      unattended: args.unattended,
      keepApp: args["keep-app"],
    })
  },
})
