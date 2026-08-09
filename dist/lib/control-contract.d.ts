import { AuthStatus as AuthStatus$1 } from './settings-types.js';
import { z } from 'zod';

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
declare const JSON_RPC_PARSE_ERROR = -32700;
declare const JSON_RPC_INVALID_REQUEST = -32600;
declare const JSON_RPC_METHOD_NOT_FOUND = -32601;
declare const JSON_RPC_INVALID_PARAMS = -32602;
declare const JSON_RPC_INTERNAL_ERROR = -32603;
/**
 * Application codes, deliberately positive.
 *
 * JSON-RPC reserves `-32768..-32000`; within it MCP reserves `-32020..-32099`
 * exclusively for its own spec, and `-32000..-32019` is legacy nobody should
 * allocate into. We are MCP-*aligned*, not MCP-*implementing* (ADR-0023), so
 * emitting a code from that range would be a claim a real MCP client could act
 * on. Positive codes can never collide with either.
 */
declare const CONTROL_UPSTREAM_ERROR = 1001;
declare const CONTROL_AUTH_FATAL = 1002;
declare const CONTROL_AUTH_RETRY = 1003;
declare const CONTROL_UNSUPPORTED_VERSION = 1004;
/**
 * The string discriminant carried in `error.data.reason`. This — not the numeric
 * code and never the HTTP status — is what a client switches on.
 */
declare const CONTROL_ERROR_REASONS: readonly ["upstream_error", "auth_fatal", "auth_retry", "unsupported_version", "internal"];
type ControlErrorReason = (typeof CONTROL_ERROR_REASONS)[number];
/**
 * `data` payload on every control error object.
 *
 * `retryable` is the client's whole decision procedure for whether to re-issue:
 * a transient auth re-mint says yes, a fatal credential rejection says no. It is
 * stated explicitly rather than inferred from the code so adding a code later
 * cannot silently change retry behaviour.
 */
interface ControlErrorData {
    reason: ControlErrorReason;
    retryable: boolean;
    /** Correlates a failure with a server-side log line, when one exists. */
    requestId?: string;
    /** Where a user can go to fix an auth-fatal condition (updated TOS, licence). */
    remediationUrl?: string;
}
/** Numeric code paired with each discriminant, so the two can never disagree. */
declare function codeForReason(reason: ControlErrorReason): number;

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

/** A request expects a response; the `id` is what distinguishes it from a
 *  notification. `params` is optional per spec — a method taking no arguments
 *  omits it entirely rather than sending `{}`. */
declare const jsonRpcRequestSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
/** A notification is a request with no `id`; the receiver MUST NOT respond. We
 *  use `.strict()`-adjacent handling in `parseMessage` rather than here so a
 *  present-but-undefined `id` is still treated as a request. */
declare const jsonRpcNotificationSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}
interface JsonRpcSuccessResponse {
    jsonrpc: "2.0";
    id: string | number;
    result: unknown;
}
interface JsonRpcErrorResponse {
    jsonrpc: "2.0";
    /** Absent when the id could not be read (parse / invalid-envelope errors). */
    id?: string | number;
    error: JsonRpcErrorObject;
}
type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
/** What `parseMessage` produces. `kind` discriminates so the HTTP binding can
 *  decide between "202 with no body" (notification) and "respond" (request)
 *  without re-inspecting the envelope. */
type ParsedMessage = {
    kind: "request";
    message: JsonRpcRequest;
} | {
    kind: "notification";
    message: JsonRpcNotification;
};
declare function successResponse(id: string | number, result: unknown): JsonRpcSuccessResponse;
declare function errorResponse(id: string | number | undefined, error: JsonRpcErrorObject): JsonRpcErrorResponse;
/** Serialize a notification for the `subscriptions/listen` stream. Notifications
 *  never carry an id — a client that tries to correlate one is misreading the
 *  push/close contract. */
declare function notification(method: string, params?: unknown): JsonRpcNotification;

/**
 * Pure control-plane contract (maximal-core#4) — the consumer entry point.
 *
 * This barrel is what the Electron client imports. Its only runtime dependency
 * is zod: no fs, no process, no framework, no engine. Importing it must never
 * pull a code path that triggers a sidecar compile, which is the acceptance
 * criterion in #4 and the reason the impure halves (`errors.ts` reaches the auth
 * controller, `dispatch.ts` needs Hono) are deliberately not re-exported here.
 *
 * Published as `@stuffbucket/maximal-core/control-contract`.
 */

/**
 * The `auth/status` result — ADR-0006's discriminated union, re-exported so a
 * consumer takes the method's result type from the same barrel as the envelope
 * instead of re-declaring it.
 *
 * Aliased through a type-only import rather than written
 * `export type { AuthStatus } from "…"`, and both halves of that are
 * load-bearing:
 *
 * - TYPE-ONLY, because `settings-types.ts` is a module of zod SCHEMAS. A value
 *   re-export would pull every one of them into
 *   `dist/lib/control-contract.js`; under `verbatimModuleSyntax` this form is
 *   erased from the emit entirely, which is what keeps zod the barrel's only
 *   runtime dependency. `downstream/check.ts` is the gate that proves it.
 * - ALIASED, because `AuthStatus` in `settings-types` is a schema const AND the
 *   type inferred from it. Re-exporting the name forwards BOTH meanings into
 *   the bundled `.d.ts`, so `import { AuthStatus }` would typecheck as a VALUE
 *   against a barrel whose JS exports no such thing — a compile-clean runtime
 *   crash. A local type alias publishes the type meaning only.
 */
type AuthStatus = AuthStatus$1;

export { type AuthStatus, CONTROL_AUTH_FATAL, CONTROL_AUTH_RETRY, CONTROL_ERROR_REASONS, CONTROL_UNSUPPORTED_VERSION, CONTROL_UPSTREAM_ERROR, type ControlErrorData, type ControlErrorReason, JSON_RPC_INTERNAL_ERROR, JSON_RPC_INVALID_PARAMS, JSON_RPC_INVALID_REQUEST, JSON_RPC_METHOD_NOT_FOUND, JSON_RPC_PARSE_ERROR, type JsonRpcErrorObject, type JsonRpcErrorResponse, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcSuccessResponse, type ParsedMessage, codeForReason, errorResponse, jsonRpcNotificationSchema, jsonRpcRequestSchema, notification, successResponse };
