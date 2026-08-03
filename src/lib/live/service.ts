/**
 * The process-wide control hub, wired to the real producer buses. Lazily
 * created on first use (first SSE connection or first action broadcast) so tests
 * and plain CLI runs don't spin up the usage flush timer.
 *
 * Producers → hub:
 *   - settingsEventBus "auth.changed"  → hub.emit("auth", …)   (cursored upsert)
 *   - tokenUsageEventBus recorded      → coalesced usage flush  (edge-only)
 */

import { settingsEventBus } from "~/lib/config/settings-events"
import { ControlHub } from "~/lib/live/hub"
import {
  buildControlSnapshot,
  type ControlSnapshot,
} from "~/lib/live/resources"
import { getTokenUsageSummary, onTokenUsageRecorded } from "~/lib/token-usage"

/** How often a dirty usage tally is recomputed and flushed as one coalesced
 *  frame — collapses a per-request storm into at most one delta per tick. */
const USAGE_FLUSH_MS = 1000

/** Keepalive cadence for connected SSE clients. */
const HEARTBEAT_MS = 15_000

let hub: ControlHub<ControlSnapshot> | null = null
let teardown: Array<() => void> = []

export function getControlHub(): ControlHub<ControlSnapshot> {
  if (hub) return hub
  const created = new ControlHub<ControlSnapshot>({
    buildSnapshot: buildControlSnapshot,
    heartbeatMs: HEARTBEAT_MS,
  })

  teardown.push(
    settingsEventBus.subscribe("auth.changed", (payload) => {
      created.emit("auth", payload)
    }),
  )

  // Coalesce usage: recorded events only mark the tally dirty; the timer
  // recomputes the day summary and flushes one frame, and only when there was
  // activity (no idle DB queries).
  let usageDirty = false
  teardown.push(
    onTokenUsageRecorded(() => {
      usageDirty = true
    }),
  )
  const timer = setInterval(() => {
    if (!usageDirty) return
    usageDirty = false
    void getTokenUsageSummary("day").then(
      (summary) => {
        created.recordUsage(summary)
        created.flushUsage()
      },
      () => {
        // Best-effort ticker; the client's GET /control/usage is authoritative.
      },
    )
  }, USAGE_FLUSH_MS)
  // Don't keep the process alive for the ticker alone.
  timer.unref()
  teardown.push(() => {
    clearInterval(timer)
  })

  hub = created
  return created
}

/** Tear down producer subscriptions + the flush timer. For tests and a clean
 *  sidecar restart. */
export function stopControlHub(): void {
  for (const stop of teardown) stop()
  teardown = []
  hub?.dispose()
  hub = null
}
