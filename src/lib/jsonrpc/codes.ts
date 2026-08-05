/**
 * Pure control-contract codes and error-data shapes (maximal-core#4).
 *
 * This module is deliberately **dependency-free**: no engine imports, no fs, no
 * process, no framework. A consumer (the Electron client renderer) must be able
 * to import it and typecheck without triggering `bun build --compile` on the
 * sidecar. Anything that needs the engine belongs in `errors.ts`, which is the
 * producer-side mapping and is never imported by a consumer.
 *
 * Per ADR-0023, clients discriminate on the JSON-RPC error object — the string
 * discriminant in `data.reason` — and **never** on an HTTP status.
 */

/** Standard JSON-RPC 2.0 codes. The only reserved-range codes we emit. */
export const JSON_RPC_PARSE_ERROR = -32700
export const JSON_RPC_INVALID_REQUEST = -32600
export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INVALID_PARAMS = -32602
export const JSON_RPC_INTERNAL_ERROR = -32603

/**
 * Application codes, deliberately positive.
 *
 * JSON-RPC reserves `-32768..-32000`; within it MCP reserves `-32020..-32099`
 * exclusively for its own spec, and `-32000..-32019` is legacy nobody should
 * allocate into. We are MCP-*aligned*, not MCP-*implementing* (ADR-0023), so
 * emitting a code from that range would be a claim a real MCP client could act
 * on. Positive codes can never collide with either.
 */
export const CONTROL_UPSTREAM_ERROR = 1001
export const CONTROL_AUTH_FATAL = 1002
export const CONTROL_AUTH_RETRY = 1003
export const CONTROL_UNSUPPORTED_VERSION = 1004

/**
 * The string discriminant carried in `error.data.reason`. This — not the numeric
 * code and never the HTTP status — is what a client switches on.
 */
export const CONTROL_ERROR_REASONS = [
  "upstream_error",
  "auth_fatal",
  "auth_retry",
  "unsupported_version",
  "internal",
] as const

export type ControlErrorReason = (typeof CONTROL_ERROR_REASONS)[number]

/**
 * `data` payload on every control error object.
 *
 * `retryable` is the client's whole decision procedure for whether to re-issue:
 * a transient auth re-mint says yes, a fatal credential rejection says no. It is
 * stated explicitly rather than inferred from the code so adding a code later
 * cannot silently change retry behaviour.
 */
export interface ControlErrorData {
  reason: ControlErrorReason
  retryable: boolean
  /** Correlates a failure with a server-side log line, when one exists. */
  requestId?: string
  /** Where a user can go to fix an auth-fatal condition (updated TOS, licence). */
  remediationUrl?: string
}

/** Numeric code paired with each discriminant, so the two can never disagree. */
export function codeForReason(reason: ControlErrorReason): number {
  switch (reason) {
    case "upstream_error": {
      return CONTROL_UPSTREAM_ERROR
    }
    case "auth_fatal": {
      return CONTROL_AUTH_FATAL
    }
    case "auth_retry": {
      return CONTROL_AUTH_RETRY
    }
    case "unsupported_version": {
      return CONTROL_UNSUPPORTED_VERSION
    }
    case "internal": {
      return JSON_RPC_INTERNAL_ERROR
    }
    default: {
      // Exhaustiveness anchor (maximal-core#4): adding a reason without adding
      // its code fails to compile here rather than silently returning undefined
      // at runtime.
      const unreachable: never = reason
      return unreachable
    }
  }
}
