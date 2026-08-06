import consola from "consola"

import { getTokenUsageRetentionDays } from "~/lib/config/config"

import { isTokenUsageStorageEnabled, pruneTokenUsageEvents } from "./store"

/**
 * Token-usage retention. `token_usage_events` grows one row per billable request
 * forever; this bounds it to the configured window (default one year, ~tens of
 * MB/year at typical volume). Pruning runs once on boot and then daily.
 */

const RETENTION_DAY_MS = 86_400_000
/** Daily sweep cadence while the sidecar is up. */
const RETENTION_SWEEP_MS = RETENTION_DAY_MS

/** Prune rows older than the configured window (0 disables — keep forever). */
function runRetentionSweep(): void {
  const days = getTokenUsageRetentionDays()
  if (days <= 0) return
  const cutoff = Date.now() - days * RETENTION_DAY_MS
  // Two-arm `then`, not a bare `void`: this is the FIRST thing to open the
  // SQLite store on a cold boot, and it runs from `finalizeBoot` — after both
  // listeners are bound and after the ready banner/ready-line have gone out. A
  // store that SQLite refuses (SQLITE_NOTADB from a file truncated by a SIGKILL
  // mid-write or a full disk; SQLITE_CANTOPEN from a root-owned or read-only
  // one) rejects here, and an unhandled rejection terminates the process — so
  // the proxy announced it was ready and then died with a raw SQLite stack.
  // Usage bookkeeping is a side feature: it degrades to "no sweep this cycle"
  // and leaves the proxy serving.
  void pruneTokenUsageEvents(cutoff).then(
    (removed) => {
      if (removed > 0) {
        consola.debug(
          `Pruned ${removed} token-usage event(s) older than ${days}d`,
        )
      }
    },
    (error: unknown) => {
      consola.warn("Token-usage retention sweep failed:", error)
    },
  )
}

/**
 * Start the retention loop: prune once on boot, then daily. The timer is
 * `unref()`-ed so it never keeps the process alive on its own. Returns a stop
 * handle. No-op where SQLite storage is unavailable.
 */
export function startTokenUsageRetention(): () => void {
  if (!isTokenUsageStorageEnabled()) {
    return () => {}
  }
  runRetentionSweep()
  const timer = setInterval(runRetentionSweep, RETENTION_SWEEP_MS)
  if (typeof timer === "object" && "unref" in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  return () => clearInterval(timer)
}
