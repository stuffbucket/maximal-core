/**
 * Producer-side error mapping for the control RPC surface.
 *
 * This module imports the engine (`forwardError` reaches the auth controller and
 * runtime state), so it is the **impure half** of the JSON-RPC layer and must
 * never be imported by a consumer. The pure half — codes, discriminants, and the
 * `data` shape a client switches on — lives in `codes.ts` (maximal-core#4).
 */
import type { Context } from "hono"

import type { ControlErrorData, ControlErrorReason } from "~/lib/jsonrpc/codes"
import type { JsonRpcErrorObject } from "~/lib/jsonrpc/message"

import { forwardError } from "~/lib/errors/error"
import {
  codeForReason,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
} from "~/lib/jsonrpc/codes"

/** Thrown by a method whose params are unusable. Distinct from an upstream
 *  failure: the caller sent something wrong, so `-32602` is the honest code and
 *  there is nothing to retry. */
export class RpcParamsError extends Error {}

export function jsonRpcError(
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorObject {
  return data === undefined ? { code, message } : { code, message, data }
}

/** Build an error object whose numeric code and string discriminant agree by
 *  construction — they are derived from one input, not written twice. */
export function controlError(
  reason: ControlErrorReason,
  message: string,
  extra: Omit<ControlErrorData, "reason" | "retryable"> & {
    retryable?: boolean
  } = {},
): JsonRpcErrorObject {
  const { retryable, ...rest } = extra
  const data: ControlErrorData = {
    reason,
    // Only a re-mintable auth blip is worth re-issuing unprompted; everything
    // else needs a human or a different request.
    retryable: retryable ?? reason === "auth_retry",
    ...rest,
  }
  return jsonRpcError(codeForReason(reason), message, data)
}

/** Maps the `type` discriminator `forwardError` already emits onto our reason. */
function reasonForErrorType(type: unknown, status: number): ControlErrorReason {
  if (type === "auth_fatal") return "auth_fatal"
  if (type === "server_error" && status === 503) return "auth_retry"
  return "upstream_error"
}

/**
 * Translate a thrown error into a JSON-RPC error object by delegating to
 * `forwardError` and reshaping its output.
 *
 * The indirection is deliberate. `forwardError` is not a formatter — its
 * `CopilotAuthFatalError` branch re-mints a stale Copilot bearer via
 * `rearmCopilotAuth()` and, only if that genuinely fails, degrades the session
 * non-destructively via `markAuthDegraded()`. Reimplementing the mapping here
 * would fork that recovery logic, and the copies would drift the first time the
 * auth state machine changes. So we run the real thing and reshape its output.
 * Any `c.header()` it sets (the 429 `retry-after` / `x-*` passthrough) lands on
 * the RPC response, which is where a client would look for it anyway.
 */
export async function toJsonRpcError(
  c: Context,
  error: unknown,
): Promise<JsonRpcErrorObject> {
  if (error instanceof RpcParamsError) {
    return jsonRpcError(JSON_RPC_INVALID_PARAMS, error.message, {
      reason: "internal",
      retryable: false,
    } satisfies ControlErrorData)
  }

  const response = await forwardError(c, error)
  const status = response.status

  let message = "Internal error"
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; type?: unknown; remediation_url?: unknown }
    }
    if (typeof body.error?.message === "string") message = body.error.message
    const remediationUrl = body.error?.remediation_url
    return controlError(reasonForErrorType(body.error?.type, status), message, {
      ...(typeof remediationUrl === "string" ? { remediationUrl } : {}),
    })
  } catch {
    // forwardError always emits JSON, so this is unreachable in practice — but a
    // codec that throws while reporting an error is the worst failure mode there
    // is, so degrade to a well-formed internal error rather than propagating.
    return jsonRpcError(JSON_RPC_INTERNAL_ERROR, message, {
      reason: "internal",
      retryable: false,
    } satisfies ControlErrorData)
  }
}
