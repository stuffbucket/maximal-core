/**
 * Harness: the live feed, against a real spawned sidecar.
 *
 * **A harness, not a test head and not a product surface.** It spawns the real
 * binary, drives the real control plane over the real socket, prints one line
 * per assertion, and exits non-zero if any fail. Run it with `bun run e2e:feed`.
 *
 * Why this exists: `subscriptions/listen` is the single load-bearing piece of
 * the v1→v2 wire break (ADR-0023) and had no coverage of any kind — not a unit
 * test, not an e2e check. It is also the first thing a host calls, because a
 * desktop shell's whole reason to hold a connection is live state. The frame
 * shape is checked here by parsing bytes rather than by using `ControlClient`,
 * so a client and server that are wrong in the same way cannot both pass.
 *
 * Not part of `bun test`: it binds a socket and spends seconds on a real
 * process.
 */
import { frameEnvelopeSchema } from "~/lib/live/contract"

import { collectFrames } from "./harness/feed"
import { createReporter, startSidecar } from "./harness/sidecar"

const CONNECT_TIMEOUT_MS = 10_000

const report = createReporter("e2e:feed — live control feed over a real sidecar")
const sidecar = await startSidecar()

try {
  // ── The connect frame ────────────────────────────────────────────────────
  // A subscription's response stream opens with a snapshot, so a host renders
  // real state on first paint instead of an empty window it later fills in.
  const opened = await collectFrames({
    baseUrl: sidecar.baseUrl,
    until: (frames) => frames.length >= 1,
    timeoutMs: CONNECT_TIMEOUT_MS,
  })

  report.check(
    "stream open",
    opened.status === 200
      && (opened.contentType?.includes("text/event-stream") ?? false),
    `${opened.status} ${opened.contentType ?? "no content-type"}`,
  )

  const first = opened.frames[0]
  report.check(
    "snapshot",
    first?.method === "control/snapshot",
    `first frame = ${first?.method ?? "none"} (a host paints from this)`,
  )

  // The version a host pins on. If this ever silently reverts to 1, a consumer
  // built against v2 would decode garbage rather than fail loudly.
  const payload = first?.params as
    | { protocolVersion?: number; snapshot?: Record<string, unknown> }
    | undefined
  report.check(
    "version",
    payload?.protocolVersion === 2,
    `protocolVersion=${payload?.protocolVersion ?? "absent"} (the v1→v2 break)`,
  )

  const topics = Object.keys(payload?.snapshot ?? {})
  report.check(
    "snapshot body",
    topics.length > 0,
    `${topics.length} topics: ${topics.join(", ") || "none"}`,
  )

  // ── The framing contract ─────────────────────────────────────────────────
  // Every frame must be a JSON-RPC *notification*. An `id` would invite a client
  // to correlate a reply that is never coming.
  const envelopes = opened.frames.map((frame) =>
    frameEnvelopeSchema.safeParse(JSON.parse(frame.block.slice(frame.block.indexOf("data:") + 5).trim())),
  )
  report.check(
    "notification",
    envelopes.every((parsed) => parsed.success),
    `${envelopes.filter((p) => p.success).length}/${envelopes.length} valid JSON-RPC notifications`,
  )

  const withId = opened.frames.filter((frame) =>
    frame.block.split("\n").some((line) => line.startsWith("id:")),
  )
  report.check(
    "no id: line",
    withId.length === 0,
    withId.length === 0 ?
      "nothing advertises a resumability this transport lacks"
    : `${withId.length} frame(s) carry an id: line`,
  )

  // ── A push actually arrives ──────────────────────────────────────────────
  // The snapshot alone would pass even if fan-out were broken, so provoke a
  // real state change once the stream is open and watch for the follow-up.
  const pushed = await collectFrames({
    baseUrl: sidecar.baseUrl,
    until: (frames) => frames.length >= 2,
    timeoutMs: CONNECT_TIMEOUT_MS,
    onOpen: async () => {
      await fetch(`${sidecar.baseUrl}/control/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          // Local-only and credential-free: it clears state and publishes,
          // so the harness needs no network and no signed-in account.
          method: "auth/signOut",
        }),
      })
    },
  })

  const after = pushed.frames.slice(1)
  report.check(
    "live push",
    after.length > 0,
    after.length > 0 ?
      `${after.map((f) => f.method).join(", ")} after a state change`
    : "no frame followed the mutation — fan-out is not reaching subscribers",
  )

  // ── Close is the unsubscribe ─────────────────────────────────────────────
  // There is no cancel method, so a leaked subscriber would only ever show up
  // as a later connection wedging. Reconnecting proves the teardown ran.
  const reconnected = await collectFrames({
    baseUrl: sidecar.baseUrl,
    until: (frames) => frames.length >= 1,
    timeoutMs: CONNECT_TIMEOUT_MS,
  })
  report.check(
    "reconnect",
    reconnected.frames[0]?.method === "control/snapshot",
    "a fresh subscription re-snapshots (close unsubscribed cleanly)",
  )

  report.check(
    "alive",
    sidecar.child.exitCode === null,
    "sidecar survived three subscriptions",
  )
} finally {
  sidecar.child.kill("SIGTERM")
}

report.finish()
