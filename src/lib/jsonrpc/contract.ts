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
export {
  codeForReason,
  CONTROL_AUTH_FATAL,
  CONTROL_AUTH_RETRY,
  CONTROL_ERROR_REASONS,
  CONTROL_UNSUPPORTED_VERSION,
  CONTROL_UPSTREAM_ERROR,
  type ControlErrorData,
  type ControlErrorReason,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from "~/lib/jsonrpc/codes"
export {
  errorResponse,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  jsonRpcNotificationSchema,
  type JsonRpcRequest,
  jsonRpcRequestSchema,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  notification,
  type ParsedMessage,
  successResponse,
} from "~/lib/jsonrpc/message"
