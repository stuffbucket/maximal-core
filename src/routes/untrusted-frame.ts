/**
 * Readers for an SSE frame that has been `JSON.parse`d and then *cast* into a
 * wire type — the `casts-keep: trusted Copilot SSE chunk` sites.
 *
 * The cast is a claim about a shape nobody in this process produced. Upstream
 * is Copilot, whose frames follow OpenAI's evolving shapes; a truncated frame,
 * a proxy that folds two events together, or a field that moved in a model
 * rollout all arrive here as an object the cast says is well-formed and the
 * runtime says is not. Reading such a frame with `frame.response.usage` turns
 * that into a `TypeError` mid-stream, which is either an aborted response or —
 * on a loop with no `try` around it — a stream that dead-ends with no error
 * event at all.
 *
 * These readers are deliberately *not* a schema. maximal does not own this wire
 * format, so a schema here would be a second definition of someone else's shape
 * that drifts every time upstream adds a field, and rejecting an unrecognised
 * frame is worse for a proxy than passing it through. What is actually needed
 * is total reads: never throw, and yield `undefined` for anything absent, which
 * is exactly what every `normalize*Usage` already treats as "no usage".
 *
 * Measured on this machine (Bun 1.3.11, 200k iterations, representative text
 * delta frame): `JSON.parse` + cast 451 ns/frame, `JSON.parse` + these guards
 * 426 ns/frame (within run-to-run noise), `JSON.parse` + a `zod` `safeParse` of
 * an equivalent loose schema 907 ns/frame — 2x, and an extra object allocation
 * per frame across every concurrent stream.
 */

/** `value` as a plain record, or `undefined` when it is not an object. */
export const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ?
    (value as Record<string, unknown>)
  : undefined

/**
 * A `usage` object as it appears on an *unvalidated* frame: every field
 * optional, in every spelling the three upstream shapes use, because nothing
 * has checked that any of them arrived.
 *
 * Deliberately assignable to all three of `normalizeOpenAIUsage`,
 * `normalizeResponsesUsage` and `normalizeAnthropicUsage` — each of those
 * already optional-chains every access and treats `undefined` as "no usage",
 * so handing them a partially-present object is safe by construction.
 */
export interface FrameUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  total_tokens?: number
}

/**
 * The `usage` object nested one level under `frame[key]` — `response.usage` on
 * a terminal Responses event, `message.usage` on an Anthropic `message_start`.
 *
 * Total: a frame that is not an object, has no `frame[key]`, or whose
 * `frame[key]` is a string/array/null yields `undefined` rather than throwing.
 * The object returned is the *same reference* that lives inside the frame, so a
 * caller that adjusts it in place still affects what gets re-serialised.
 */
export const readNestedUsage = (
  frame: unknown,
  key: string,
): FrameUsage | undefined =>
  asRecord(asRecord(frame)?.[key])?.usage as FrameUsage | undefined

/** The top-level `usage` object on a frame, read without trusting its type. */
export const readUsage = (frame: unknown): FrameUsage | undefined =>
  asRecord(frame)?.usage as FrameUsage | undefined
