// src/lib/jsonrpc/codes.ts
var JSON_RPC_PARSE_ERROR = -32700;
var JSON_RPC_INVALID_REQUEST = -32600;
var JSON_RPC_METHOD_NOT_FOUND = -32601;
var JSON_RPC_INVALID_PARAMS = -32602;
var JSON_RPC_INTERNAL_ERROR = -32603;
var CONTROL_UPSTREAM_ERROR = 1001;
var CONTROL_AUTH_FATAL = 1002;
var CONTROL_AUTH_RETRY = 1003;
var CONTROL_UNSUPPORTED_VERSION = 1004;
var CONTROL_ERROR_REASONS = [
  "upstream_error",
  "auth_fatal",
  "auth_retry",
  "unsupported_version",
  "internal"
];
function codeForReason(reason) {
  switch (reason) {
    case "upstream_error": {
      return CONTROL_UPSTREAM_ERROR;
    }
    case "auth_fatal": {
      return CONTROL_AUTH_FATAL;
    }
    case "auth_retry": {
      return CONTROL_AUTH_RETRY;
    }
    case "unsupported_version": {
      return CONTROL_UNSUPPORTED_VERSION;
    }
    case "internal": {
      return JSON_RPC_INTERNAL_ERROR;
    }
    default: {
      const unreachable = reason;
      return unreachable;
    }
  }
}

// src/lib/jsonrpc/message.ts
import { z } from "zod";
var idSchema = z.union([z.string(), z.number().int()]);
var jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  method: z.string().min(1),
  params: z.unknown().optional()
});
var jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional()
});
function successResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function errorResponse(id, error) {
  return id === void 0 ? { jsonrpc: "2.0", error } : { jsonrpc: "2.0", id, error };
}
function notification(method, params) {
  return params === void 0 ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}
export {
  CONTROL_AUTH_FATAL,
  CONTROL_AUTH_RETRY,
  CONTROL_ERROR_REASONS,
  CONTROL_UNSUPPORTED_VERSION,
  CONTROL_UPSTREAM_ERROR,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  codeForReason,
  errorResponse,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  notification,
  successResponse
};
