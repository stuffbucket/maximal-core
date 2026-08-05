import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"

import {
  subagentMarkerPrefix,
  subagentMarkerSchema,
  type SubagentMarker,
} from "~/lib/runtime-state/subagent"

export const parseSubagentMarkerFromFirstUser = (
  payload: AnthropicMessagesPayload,
): SubagentMarker | null => {
  const firstUserMessage = payload.messages.find(
    (msg) => msg.role === "user" && Array.isArray(msg.content),
  )
  if (!firstUserMessage || !Array.isArray(firstUserMessage.content)) {
    return null
  }

  for (const block of firstUserMessage.content) {
    if (block.type !== "text") {
      continue
    }

    const marker = parseSubagentMarkerFromSystemReminder(block.text)
    if (marker) {
      return marker
    }
  }

  return null
}

const parseSubagentMarkerFromSystemReminder = (
  text: string,
): SubagentMarker | null => {
  const startTag = "<system-reminder>"
  const endTag = "</system-reminder>"
  let searchFrom = 0

  while (true) {
    const reminderStart = text.indexOf(startTag, searchFrom)
    if (reminderStart === -1) {
      break
    }

    const contentStart = reminderStart + startTag.length
    const reminderEnd = text.indexOf(endTag, contentStart)
    if (reminderEnd === -1) {
      break
    }

    const reminderContent = text.slice(contentStart, reminderEnd)
    const markerIndex = reminderContent.indexOf(subagentMarkerPrefix)
    if (markerIndex === -1) {
      searchFrom = reminderEnd + endTag.length
      continue
    }

    const markerJson = reminderContent
      .slice(markerIndex + subagentMarkerPrefix.length)
      .trim()

    // Parsed against the shared schema, not cast: the marker comes from another
    // program, and the presence check this replaced was truthiness rather than
    // type — see `subagentMarkerSchema`.
    const parsed = subagentMarkerSchema.safeParse(safeJsonParse(markerJson))
    if (!parsed.success) {
      searchFrom = reminderEnd + endTag.length
      continue
    }

    return parsed.data
  }

  return null
}

/** `JSON.parse` that yields `undefined` instead of throwing, so a reminder
 *  carrying a truncated marker just falls through to the next one. */
const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
