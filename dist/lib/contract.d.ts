import { z } from 'zod';

/**
 * Wire contract for the control feed.
 *
 * **Version 2 is a break.** Version 1 was a bespoke `{id, event, data}` SSE
 * envelope with `Last-Event-ID` + epoch resume. Per ADR-0023 the control plane
 * is stateless JSON-RPC 2.0: the feed now carries JSON-RPC *notifications*, and
 * a dropped connection reconnects fresh rather than replaying a ring. MCP
 * removed resumable streams in spec 2026-07-28 for the same reason — session
 * state on the server is what made it not a plain HTTP workload.
 */
declare const CONTROL_PROTOCOL_VERSION = 2;
/** Header a client mirrors its `protocolVersion` into (maximal-core#8). Named in
 *  the MCP style because ADR-0023 aligns on the stateless *shape*; it is our
 *  version, not MCP's.
 *
 *  It lives here, beside the version it carries, rather than in the route that
 *  reads it: the shipped `ControlClient` has to stamp the same name the server
 *  checks, and `~/routes/control/rpc` drags Hono and the whole engine in — which
 *  the published `dist/lib` bundles must not. */
declare const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
/** The single supported wire version, in the string form the header carries. A
 *  client discovers this via `server/discover` and pins to it; a mismatch is
 *  reported legibly rather than crashing (#8). */
declare const SUPPORTED_PROTOCOL_VERSION: string;
/** Every topic the control feed can carry. `snapshot` is the connect frame;
 *  `usage`/`boot` are transient signals. */
declare const CONTROL_TOPICS: readonly ["snapshot", "auth", "accounts", "apps", "models", "clients", "usage", "config", "boot"];
type ControlTopic = (typeof CONTROL_TOPICS)[number];
/** JSON-RPC method name a topic is published under. Namespacing keeps the feed
 *  in the same vocabulary as the request methods, so one client dispatch table
 *  handles both. */
declare function methodForTopic(topic: ControlTopic): string;
/** A frame as it lives inside the hub before serialization. There is no cursor:
 *  nothing is ringed, nothing is replayed. */
interface ControlFrame {
    topic: ControlTopic;
    data: unknown;
}
/**
 * Schema a consumer validates each decoded feed frame against.
 *
 * A feed frame is a JSON-RPC notification — no `id`, because the server never
 * expects a reply to it and a client that tries to correlate one has misread the
 * push/close contract.
 */
declare const frameEnvelopeSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
type FrameEnvelope = z.infer<typeof frameEnvelopeSchema>;
/** Payload of the `snapshot` notification: the protocol version a client can
 *  refuse on, and the full current state. No epoch — there is nothing to resume
 *  against. */
interface SnapshotPayload<Snapshot = unknown> {
    protocolVersion: number;
    snapshot: Snapshot;
}
/**
 * Render a frame as an SSE block carrying a JSON-RPC notification.
 *
 * No `id:` line — emitting one would advertise a resumability this transport
 * does not have, and a client would set `Last-Event-ID` on reconnect expecting a
 * replay that never comes.
 */
declare function serializeFrame(frame: ControlFrame): string;

export { CONTROL_PROTOCOL_VERSION, CONTROL_TOPICS, type ControlFrame, type ControlTopic, type FrameEnvelope, PROTOCOL_VERSION_HEADER, SUPPORTED_PROTOCOL_VERSION, type SnapshotPayload, frameEnvelopeSchema, methodForTopic, serializeFrame };
