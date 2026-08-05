/**
 * Stream ID Synchronization for @ai-sdk/openai compatibility
 *
 * Problem: GitHub Copilot's Responses API returns different IDs for the same
 * item in 'added' vs 'done' events. This breaks @ai-sdk/openai which expects
 * consistent IDs across the stream lifecycle.
 *
 * Errors without this fix:
 * - "activeReasoningPart.summaryParts" undefined
 * - "text part not found"
 *
 * Use case: OpenCode (AI coding assistant) using Codex models (gpt-5.2-codex)
 * via @ai-sdk/openai provider requires the Responses API endpoint.
 *
 * ─── Why this file parses defensively ────────────────────────────────────────
 * This runs on the native `/responses` passthrough, inside a `streamSSE`
 * callback with **no** surrounding `try`. A throw here does not produce an
 * Anthropic `error` event; it dead-ends the stream. Two throws used to be
 * reachable from ordinary upstream output:
 *
 *   1. `JSON.parse(data)` was unguarded, while the sibling usage reader in
 *      `handler.ts` explicitly skips `data === "[DONE]"`. Any non-JSON frame —
 *      the `[DONE]` sentinel included — threw before reaching a translator.
 *   2. The event name comes from the SSE `event:` field, not from the body, so
 *      an `event: response.output_item.added` frame whose body had no `item`
 *      reached `parsed.item.id`. Nothing checked that narrowing.
 *
 * Both are now checked at runtime, and the fallback is the only correct one for
 * a passthrough: return the frame byte-for-byte and let the client see exactly
 * what upstream sent. Covered in `tests/stream-boundary-tolerance.test.ts`.
 */

interface StreamIdTracker {
  outputItems: Map<number, string>
}

/** An output-item frame whose `item` object is present — the only shape the
 *  add/done handlers may touch. Checked, not asserted. */
interface OutputItemFrame {
  item: { id?: string }
  output_index?: unknown
}

const asOutputItemFrame = (value: unknown): OutputItemFrame | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const item = (value as { item?: unknown }).item
  if (typeof item !== "object" || item === null) return undefined
  return value as OutputItemFrame
}

/** The `output_index` on a frame, only when it is usable as a Map key. */
const readOutputIndex = (frame: {
  output_index?: unknown
}): number | undefined =>
  typeof frame.output_index === "number" ? frame.output_index : undefined

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
})

export const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data) return data

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    // Not JSON at all (`[DONE]`, a keep-alive comment, a truncated frame).
    // Passthrough means passthrough.
    return data
  }

  switch (event) {
    case "response.output_item.added": {
      const frame = asOutputItemFrame(parsed)
      return frame ? handleOutputItemAdded(frame, tracker) : data
    }
    case "response.output_item.done": {
      const frame = asOutputItemFrame(parsed)
      return frame ? handleOutputItemDone(frame, tracker) : data
    }
    default: {
      if (typeof parsed !== "object" || parsed === null) return data
      return handleItemId(parsed as Record<string, unknown>, tracker)
    }
  }
}

const handleOutputItemAdded = (
  parsed: OutputItemFrame,
  tracker: StreamIdTracker,
): string => {
  if (!parsed.item.id) {
    let randomSuffix = ""
    while (randomSuffix.length < 16) {
      randomSuffix += Math.random().toString(36).slice(2)
    }
    parsed.item.id = `oi_${String(parsed.output_index)}_${randomSuffix.slice(0, 16)}`
  }

  const outputIndex = readOutputIndex(parsed)
  if (outputIndex !== undefined) {
    tracker.outputItems.set(outputIndex, parsed.item.id)
  }
  return JSON.stringify(parsed)
}

const handleOutputItemDone = (
  parsed: OutputItemFrame,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = readOutputIndex(parsed)
  const originalId =
    outputIndex === undefined ? undefined : tracker.outputItems.get(outputIndex)
  if (originalId) {
    parsed.item.id = originalId
  }
  return JSON.stringify(parsed)
}

const handleItemId = (
  parsed: Record<string, unknown>,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = readOutputIndex(parsed)
  if (outputIndex !== undefined) {
    const itemId = tracker.outputItems.get(outputIndex)
    if (itemId) {
      parsed.item_id = itemId
    }
  }
  return JSON.stringify(parsed)
}
