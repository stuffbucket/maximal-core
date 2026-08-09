/**
 * Downstream consumer of `@stuffbucket/maximal-core/control-contract`.
 *
 * Models what the Electron renderer does: build a JSON-RPC request, discriminate
 * the response, and branch on `error.data.reason` — never on an HTTP status
 * (ADR-0023). The point of the fixture is that the CLIENT-SIDE decision
 * procedure compiles, not merely that the module imports.
 *
 * `zod` is `external` in the library build, so this file also proves a consumer
 * with its own zod can consume the exported schemas without a duplicate-instance
 * type mismatch.
 */
import type {
  AuthStatus,
  ControlErrorData,
  ControlErrorReason,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  ParsedMessage,
} from "@stuffbucket/maximal-core/control-contract"

import {
  codeForReason,
  CONTROL_AUTH_FATAL,
  CONTROL_AUTH_RETRY,
  CONTROL_ERROR_REASONS,
  CONTROL_UNSUPPORTED_VERSION,
  CONTROL_UPSTREAM_ERROR,
  errorResponse,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  notification,
  successResponse,
} from "@stuffbucket/maximal-core/control-contract"

import { expectAssignable } from "./assert.js"

// --- reserved-range codes stay pinned to their spec values -----------------
// These are wire constants. A consumer may hard-compare them, so a changed
// value is a breaking change even though nothing structural moved.
expectAssignable<-32_700>(JSON_RPC_PARSE_ERROR)
expectAssignable<-32_600>(JSON_RPC_INVALID_REQUEST)
expectAssignable<-32_601>(JSON_RPC_METHOD_NOT_FOUND)
expectAssignable<-32_602>(JSON_RPC_INVALID_PARAMS)
expectAssignable<-32_603>(JSON_RPC_INTERNAL_ERROR)
expectAssignable<1001>(CONTROL_UPSTREAM_ERROR)
expectAssignable<1002>(CONTROL_AUTH_FATAL)
expectAssignable<1003>(CONTROL_AUTH_RETRY)
expectAssignable<1004>(CONTROL_UNSUPPORTED_VERSION)

// --- the discriminant -------------------------------------------------------
// The reason list must stay a readonly tuple of literals: a consumer renders it
// (settings copy, telemetry buckets) and iterates it exhaustively.
expectAssignable<ReadonlyArray<ControlErrorReason>>(CONTROL_ERROR_REASONS)
expectAssignable<number>(codeForReason("auth_fatal"))
// @ts-expect-error "nope" is not a ControlErrorReason — the discriminant is a
// closed set, and a typo'd branch must not compile.
expectAssignable<number>(codeForReason("nope"))

/**
 * Exhaustive handling of every reason.
 *
 * The `never` sink is the assertion: ADDING a reason to the published union is a
 * breaking change for any consumer with a total switch, and this is what turns
 * that into a compile error at the point it happens instead of a runtime
 * fall-through months later.
 */
export function retryPolicy(reason: ControlErrorReason): "retry" | "stop" {
  switch (reason) {
    case "auth_retry": {
      return "retry"
    }
    case "upstream_error": {
      return "retry"
    }
    case "auth_fatal": {
      return "stop"
    }
    case "unsupported_version": {
      return "stop"
    }
    case "internal": {
      return "stop"
    }
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

// --- auth state -------------------------------------------------------------

/**
 * Exhaustive handling of every `auth/status` state.
 *
 * `auth/status` answers with the ADR-0006 union, so a renderer discriminates on
 * `state` exactly the way it discriminates on `reason` above. Same `never` sink,
 * same reason: adding a state to the published union is a breaking change for
 * any consumer with a total switch, and this makes that a compile error here
 * rather than a blank panel in the shell.
 */
export function authHeadline(status: AuthStatus): string {
  switch (status.state) {
    case "unauthenticated": {
      return "Signed out"
    }
    case "device_code_issued": {
      return `Enter ${status.user_code}`
    }
    case "polling": {
      return `Waiting for ${status.user_code}`
    }
    case "authenticated": {
      return `Connected as ${status.account_login}`
    }
    case "error": {
      return status.error
    }
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

// @ts-expect-error `user_code` lives on the device-code variants only — reading
// it off the union without narrowing must not compile, or a renderer prints
// `undefined` in the authenticated state.
export const unnarrowedAuth = (s: AuthStatus): string => s.user_code

// --- error data -------------------------------------------------------------
const fullErrorData: ControlErrorData = {
  reason: "auth_fatal",
  retryable: false,
  requestId: "req-1",
  remediationUrl: "https://example.invalid/tos",
}
expectAssignable<ControlErrorReason>(fullErrorData.reason)
expectAssignable<boolean>(fullErrorData.retryable)
expectAssignable<string | undefined>(fullErrorData.requestId)
expectAssignable<string | undefined>(fullErrorData.remediationUrl)

// The minimum a consumer can rely on being present.
export const minimalErrorData: ControlErrorData = {
  reason: "internal",
  retryable: true,
}

// @ts-expect-error `retryable` is the client's whole retry decision procedure —
// it must stay required, or a consumer silently treats `undefined` as "don't".
export const missingRetryable: ControlErrorData = { reason: "internal" }

// --- response discrimination ------------------------------------------------
export function readResponse(response: JsonRpcResponse): unknown {
  // `"error" in response` is the documented client-side narrowing.
  if ("error" in response) {
    const failure: JsonRpcErrorResponse = response
    const error: JsonRpcErrorObject = failure.error
    expectAssignable<number>(error.code)
    expectAssignable<string>(error.message)
    // `data` is `unknown` on the envelope; a client casts it to the contract's
    // payload after checking the code. Keeping it `unknown` is deliberate.
    expectAssignable<unknown>(error.data)
    // An error response may have no id (parse / invalid-envelope errors).
    expectAssignable<string | number | undefined>(failure.id)
    return undefined
  }
  const ok: JsonRpcSuccessResponse = response
  // A success response always has an id — this is what lets a client correlate.
  expectAssignable<string | number>(ok.id)
  return ok.result
}

// @ts-expect-error the union is only readable after narrowing; `result` must not
// be reachable on a bare JsonRpcResponse, or a client reads `undefined` off an
// error response.
export const unnarrowed = (r: JsonRpcResponse): unknown => r.result

// --- builders ---------------------------------------------------------------
expectAssignable<JsonRpcSuccessResponse>(successResponse(1, { ok: true }))
expectAssignable<JsonRpcSuccessResponse>(successResponse("id-1", null))
expectAssignable<JsonRpcErrorResponse>(
  errorResponse(1, {
    code: codeForReason("upstream_error"),
    message: "upstream failed",
    data: minimalErrorData,
  }),
)
// The id is optional on the error builder precisely because a parse error has no
// readable id.
expectAssignable<JsonRpcErrorResponse>(
  errorResponse(undefined, { code: JSON_RPC_PARSE_ERROR, message: "bad json" }),
)
expectAssignable<JsonRpcNotification>(notification("server/status"))
expectAssignable<JsonRpcNotification>(notification("server/status", { a: 1 }))

// --- schemas ----------------------------------------------------------------
// zod is external to the library build, so the schema's inferred type must line
// up with the exported interface using the CONSUMER's zod. If the build ever
// bundled its own copy, these would fail with "two different types with this
// name exist".
const parsedRequest = jsonRpcRequestSchema.parse({
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
})
expectAssignable<JsonRpcRequest>(parsedRequest)
expectAssignable<"2.0">(parsedRequest.jsonrpc)
expectAssignable<string | number>(parsedRequest.id)
expectAssignable<string>(parsedRequest.method)
expectAssignable<unknown>(parsedRequest.params)

const parsedNotification = jsonRpcNotificationSchema.parse({
  jsonrpc: "2.0",
  method: "server/status",
})
expectAssignable<JsonRpcNotification>(parsedNotification)

// `safeParse` is how a client handles a frame off the wire; the success branch
// must narrow to the exported type without a cast.
const attempt = jsonRpcRequestSchema.safeParse({})
if (attempt.success) {
  expectAssignable<JsonRpcRequest>(attempt.data)
}

// --- parsed-message discrimination -----------------------------------------
// A host embedding the contract switches on `kind` to decide "202, no body"
// versus "respond".
export function route(parsed: ParsedMessage): string {
  if (parsed.kind === "notification") {
    expectAssignable<JsonRpcNotification>(parsed.message)
    return "accepted"
  }
  expectAssignable<JsonRpcRequest>(parsed.message)
  return "respond"
}
