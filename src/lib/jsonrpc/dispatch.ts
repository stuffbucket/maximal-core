/**
 * HTTP binding for the JSON-RPC control surface.
 *
 * One endpoint, POST only. Each call is self-contained: no session, no cursor, no
 * resume. A method either returns a value (rendered as a JSON-RPC result) or takes
 * over the response entirely by returning a `Response` — which is how
 * `subscriptions/listen` holds an SSE stream open.
 *
 * ## HTTP status policy
 *
 * A well-formed JSON-RPC exchange answers `200` even when the method fails: the
 * transport succeeded and the failure is described by the error object. `400` is
 * reserved for input that is not valid JSON-RPC at all (unparseable body, bad
 * envelope, a batch), because there is no meaningful RPC-level answer to give.
 *
 * This differs from MCP, which mandates `404` for an unknown method and `400` for
 * its header-validation errors. We are not implementing MCP (see `message.ts`), so
 * an unknown method here is `200` + `-32601`. A future MCP adapter would remap
 * statuses at its own endpoint rather than changing this one.
 */
import type { Context } from "hono"

import type { JsonRpcErrorObject, ParsedMessage } from "~/lib/jsonrpc/message"

import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from "~/lib/jsonrpc/codes"
import { jsonRpcError, toJsonRpcError } from "~/lib/jsonrpc/errors"
import {
  errorResponse,
  jsonRpcRequestSchema,
  successResponse,
} from "~/lib/jsonrpc/message"

/**
 * A method handler. Returning a `Response` hands the whole HTTP response to the
 * handler — used by streaming methods. Anything else is rendered as the JSON-RPC
 * `result`. The return type is bare `unknown` because the dispatcher awaits it:
 * a handler may be sync or async.
 */
export type RpcHandler = (params: unknown, c: Context) => unknown

/** Indexing must be able to miss — an unknown method is the common case, not an
 *  exceptional one, so the lookup is typed as possibly-undefined rather than
 *  relying on a truthiness check the type system believes is redundant. */
export type RpcRegistry = Readonly<Record<string, RpcHandler | undefined>>

/** Discriminates a parse attempt without throwing — the caller needs the error
 *  object to render, not an exception to catch. */
type ParseOutcome =
  | { ok: true; parsed: ParsedMessage }
  | { ok: false; error: JsonRpcErrorObject; id?: string | number }

function parseEnvelope(raw: unknown): ParseOutcome {
  if (Array.isArray(raw)) {
    // JSON-RPC 2.0 permits batches; we don't. A batch has no coherent meaning
    // once a member can return a stream, and no consumer needs it.
    return {
      ok: false,
      error: jsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Batch requests are not supported",
      ),
    }
  }

  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      error: jsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Request must be a JSON object",
      ),
    }
  }

  const envelope = raw as Record<string, unknown>

  if ("result" in envelope || "error" in envelope) {
    // Responses flow server→client only. A client sending one means it has
    // misunderstood the direction of the protocol; say so explicitly rather than
    // failing on a missing `method`.
    return {
      ok: false,
      error: jsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Clients must not send JSON-RPC responses",
      ),
    }
  }

  const hasId = "id" in envelope && envelope.id !== undefined
  if (!hasId) {
    if (envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
      return {
        ok: false,
        error: jsonRpcError(
          JSON_RPC_INVALID_REQUEST,
          "Invalid JSON-RPC 2.0 notification",
        ),
      }
    }
    return {
      ok: true,
      parsed: {
        kind: "notification",
        message: {
          jsonrpc: "2.0",
          method: envelope.method,
          params: envelope.params,
        },
      },
    }
  }

  const result = jsonRpcRequestSchema.safeParse(envelope)
  if (!result.success) {
    // Echo the id back when it is usable, so a client can correlate the failure
    // with the call that caused it.
    const id =
      typeof envelope.id === "string" || typeof envelope.id === "number" ?
        envelope.id
      : undefined
    return {
      ok: false,
      error: jsonRpcError(
        JSON_RPC_INVALID_REQUEST,
        "Invalid JSON-RPC 2.0 request",
        { issues: result.error.issues.map((issue) => issue.message) },
      ),
      ...(id === undefined ? {} : { id }),
    }
  }

  return { ok: true, parsed: { kind: "request", message: result.data } }
}

/**
 * Build the POST handler for the RPC endpoint.
 *
 * `GET`/`DELETE` are rejected with `405` by the route, not here — this function
 * owns only the message layer.
 */
export function createRpcHandler(registry: RpcRegistry) {
  return async (c: Context): Promise<Response> => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json(
        errorResponse(
          undefined,
          jsonRpcError(JSON_RPC_PARSE_ERROR, "Request body is not valid JSON"),
        ),
        400,
      )
    }

    const outcome = parseEnvelope(raw)
    if (!outcome.ok) {
      return c.json(errorResponse(outcome.id, outcome.error), 400)
    }

    const { parsed } = outcome
    const handler = registry[parsed.message.method]

    if (parsed.kind === "notification") {
      // The receiver MUST NOT respond to a notification. An unknown one is not an
      // error we can report anywhere, so acknowledge and drop it — that is the
      // only behaviour consistent with "no response".
      if (handler) {
        try {
          await handler(parsed.message.params, c)
        } catch {
          // Nowhere to report it; the handler is responsible for its own logging.
        }
      }
      return c.body(null, 202)
    }

    const { id } = parsed.message

    if (!handler) {
      return c.json(
        errorResponse(
          id,
          jsonRpcError(
            JSON_RPC_METHOD_NOT_FOUND,
            `Unknown method: ${parsed.message.method}`,
          ),
        ),
      )
    }

    try {
      const result = await handler(parsed.message.params, c)
      // A streaming method has already produced the whole response.
      if (result instanceof Response) return result
      return c.json(successResponse(id, result ?? null))
    } catch (error) {
      const rpcError = await toJsonRpcError(c, error).catch(() =>
        jsonRpcError(
          JSON_RPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : "Internal error",
        ),
      )
      return c.json(errorResponse(id, rpcError))
    }
  }
}
