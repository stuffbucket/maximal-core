// src/lib/live/contract.ts
import { z } from "zod";
var CONTROL_PROTOCOL_VERSION = 2;
var PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
var SUPPORTED_PROTOCOL_VERSION = String(CONTROL_PROTOCOL_VERSION);
var CONTROL_TOPICS = [
  "snapshot",
  "auth",
  "accounts",
  "apps",
  "models",
  "clients",
  "usage",
  "config",
  "boot"
];
function methodForTopic(topic) {
  return `control/${topic}`;
}
var frameEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional()
});
function serializeFrame(frame) {
  const payload = {
    jsonrpc: "2.0",
    method: methodForTopic(frame.topic),
    params: frame.data
  };
  return `data: ${JSON.stringify(payload)}

`;
}

export {
  CONTROL_PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  SUPPORTED_PROTOCOL_VERSION,
  CONTROL_TOPICS,
  methodForTopic,
  frameEnvelopeSchema,
  serializeFrame
};
