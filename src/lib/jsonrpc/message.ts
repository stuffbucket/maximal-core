/**
 * JSON-RPC 2.0 message layer.
 *
 * The control surface exchanges data as stateless JSON-RPC 2.0 so the engine
 * shares a message envelope with MCP and A2A, both of which bind to it. We are
 * deliberately NOT implementing MCP here: none of its per-request ceremony
 * (`_meta.io.modelcontextprotocol/*`, the mirrored `Mcp-*` headers, `resultType`,
 * MRTR) applies. Method names are namespaced MCP-style so that adapter, if it is
 * ever written, is header plumbing rather than a method redesign.
 *
 * Statelessness is the load-bearing property: every request carries what it needs,
 * and no state is inferred from a prior request on the same connection. That is
 * what let us delete the cursor/epoch/replay-ring machinery the old SSE feed
 * carried — see the ADR.
 */
import { z } from "zod"

/** JSON-RPC ids are string or number. Null is legal in the base spec for error
 *  responses, but a *request* carrying `id: null` is malformed for us — it can't
 *  be correlated, and MCP bans it outright, so we reject it rather than invent a
 *  correlation rule that a future adapter would have to unpick. */
const idSchema = z.union([z.string(), z.number().int()])

/** A request expects a response; the `id` is what distinguishes it from a
 *  notification. `params` is optional per spec — a method taking no arguments
 *  omits it entirely rather than sending `{}`. */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
})

/** A notification is a request with no `id`; the receiver MUST NOT respond. We
 *  use `.strict()`-adjacent handling in `parseMessage` rather than here so a
 *  present-but-undefined `id` is still treated as a request. */
export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0"
  id: string | number
  result: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0"
  /** Absent when the id could not be read (parse / invalid-envelope errors). */
  id?: string | number
  error: JsonRpcErrorObject
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

/** What `parseMessage` produces. `kind` discriminates so the HTTP binding can
 *  decide between "202 with no body" (notification) and "respond" (request)
 *  without re-inspecting the envelope. */
export type ParsedMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }

export function successResponse(
  id: string | number,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result }
}

export function errorResponse(
  id: string | number | undefined,
  error: JsonRpcErrorObject,
): JsonRpcErrorResponse {
  return id === undefined ?
      { jsonrpc: "2.0", error }
    : { jsonrpc: "2.0", id, error }
}

/** Serialize a notification for the `subscriptions/listen` stream. Notifications
 *  never carry an id — a client that tries to correlate one is misreading the
 *  push/close contract. */
export function notification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  return params === undefined ?
      { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params }
}
