import { z } from "zod"

/** Bumped when the wire envelope changes shape. Sent on the snapshot frame so a
 *  consumer can refuse a stream it doesn't understand. */
export const CONTROL_PROTOCOL_VERSION = 1

/** Every topic the control stream can carry. State topics mirror a GET
 *  resource; `snapshot` is the connect/re-sync frame; `usage`/`boot` are the
 *  edge-only signals. */
export const CONTROL_TOPICS = [
  "snapshot",
  "auth",
  "accounts",
  "apps",
  "models",
  "clients",
  "usage",
  "config",
  "boot",
] as const

export type ControlTopic = (typeof CONTROL_TOPICS)[number]

/** A frame as it lives inside the hub before serialization. `cursor` is present
 *  only on ringable, resumable state upserts; edge-only frames (transient
 *  signals, coalesced usage) carry none, so they never advance a client's
 *  Last-Event-ID and are never replayed. */
export interface ControlFrame {
  topic: ControlTopic
  data: unknown
  cursor?: number
}

/** Schema a consumer validates each decoded SSE frame against — the contract
 *  the UI and any third-party embedder share (replaces the deleted
 *  feed-types.ts). Resource-specific `data` schemas layer on top per topic. */
export const frameEnvelopeSchema = z.object({
  id: z.number().int().nonnegative().optional(),
  event: z.enum(CONTROL_TOPICS),
  data: z.unknown(),
})
export type FrameEnvelope = z.infer<typeof frameEnvelopeSchema>

/** Payload of the `snapshot` frame: the epoch a client must echo to resume, the
 *  protocol version, and the full current state. */
export interface SnapshotPayload<Snapshot = unknown> {
  protocolVersion: number
  epoch: string
  snapshot: Snapshot
}

/** Render a frame as an SSE block. `id:` is emitted only for cursored frames, so
 *  edge-only frames leave a client's Last-Event-ID untouched. */
export function serializeFrame(frame: ControlFrame): string {
  const idLine = frame.cursor === undefined ? "" : `id: ${frame.cursor}\n`
  return `${idLine}event: ${frame.topic}\ndata: ${JSON.stringify(frame.data)}\n\n`
}
