// src/lib/live/contract.ts
import { z } from "zod";
var CONTROL_PROTOCOL_VERSION = 1;
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
var frameEnvelopeSchema = z.object({
  id: z.number().int().nonnegative().optional(),
  event: z.enum(CONTROL_TOPICS),
  data: z.unknown()
});
function serializeFrame(frame) {
  const idLine = frame.cursor === void 0 ? "" : `id: ${frame.cursor}
`;
  return `${idLine}event: ${frame.topic}
data: ${JSON.stringify(frame.data)}

`;
}

export {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_TOPICS,
  frameEnvelopeSchema,
  serializeFrame
};
