/**
 * Boundary tolerance for the SSE frames the proxy casts rather than parses.
 *
 * Seven `casts-keep:` sites take `JSON.parse(frame)` straight from an upstream
 * Copilot SSE stream and assert it into a wire type. Their justification used
 * to read "trusted Copilot SSE chunk; translator tolerates missing fields".
 * The first half is a posture; the second half is a *testable property*, and
 * when it was finally tested it was false — every translator threw on a frame
 * that was `null`, an array, or simply missing the sub-object its own `type`
 * discriminant implied. On the three loops that sit inside a `try` that meant
 * an aborted response; on the `/responses` passthrough, which has no `try`, it
 * meant a stream that dead-ended with no error event at all.
 *
 * This file is what the justifications now cite. It is not a schema — it is the
 * evidence that the reads behind each cast are total. Every case below is a
 * shape a truncated frame, a folded event, or an upstream field rename can
 * actually produce; the assertion in each is the same one the justification
 * makes: *this does not throw, and the translator's state survives it*.
 */

import { describe, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
} from "~/lib/models/anthropic-types"
import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"
import type { ResponseStreamEvent } from "~/services/copilot/create-responses"

import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { translateChunkToAnthropicEvents } from "~/routes/messages/stream-translation"
import { parseSubagentMarkerFromFirstUser } from "~/routes/messages/subagent-marker"
import {
  createStreamIdTracker,
  fixStreamIds,
} from "~/routes/responses/stream-id-sync"
import { asRecord, readNestedUsage, readUsage } from "~/routes/untrusted-frame"

const freshChatState = (): AnthropicStreamState => ({
  messageStartSent: false,
  contentBlockIndex: 0,
  contentBlockOpen: false,
  toolCalls: {},
  thinkingBlockOpen: false,
})

/** Every one of these threw before this change. */
const malformedChatChunks: Array<[string, unknown]> = [
  ["null body", null],
  ["array body", [1, 2]],
  ["string body", "hello"],
  ["number body", 42],
  ["empty object", {}],
  ["no choices key", { id: "a", model: "m" }],
  ["choices null", { choices: null }],
  ["choices is a string", { choices: "xx" }],
  ["choices entry null", { choices: [null] }],
  ["choice without delta", { choices: [{ finish_reason: "stop" }] }],
  ["delta null", { choices: [{ delta: null }] }],
  ["tool_calls entry null", { choices: [{ delta: { tool_calls: [null] } }] }],
  ["tool_calls is a string", { choices: [{ delta: { tool_calls: "x" } }] }],
  ["usage is a string", { choices: [{ delta: {} }], usage: "lots" }],
  ["usage is an array", { choices: [{ delta: {} }], usage: [1] }],
  ["finish_reason is a number", { choices: [{ delta: {}, finish_reason: 7 }] }],
  [
    "deeply wrong",
    { choices: [{ delta: { content: 5, tool_calls: [{ index: "z" }] } }] },
  ],
]

describe("translateChunkToAnthropicEvents boundary tolerance", () => {
  test.each(malformedChatChunks)(
    "%s yields events without throwing",
    (_label, chunk) => {
      const state = freshChatState()
      expect(() =>
        translateChunkToAnthropicEvents(chunk as ChatCompletionChunk, state),
      ).not.toThrow()
      // State stays coherent: no half-open block, no negative index.
      expect(state.contentBlockIndex).toBeGreaterThanOrEqual(0)
    },
  )

  test("an unusable frame emits nothing and leaves the stream untouched", () => {
    const state = freshChatState()
    const events = translateChunkToAnthropicEvents(
      null as unknown as ChatCompletionChunk,
      state,
    )
    expect(events).toEqual([])
    expect(state).toEqual(freshChatState())
  })

  test("a following well-formed chunk still translates normally", () => {
    const state = freshChatState()
    translateChunkToAnthropicEvents({} as ChatCompletionChunk, state)
    const events = translateChunkToAnthropicEvents(
      {
        id: "c1",
        model: "m",
        choices: [{ delta: { content: "hi" } }],
      } as ChatCompletionChunk,
      state,
    )
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
    ])
  })

  test("a choice with no delta still emits message_start", () => {
    // The plausible truncation: upstream sends the finish frame with no delta.
    const events = translateChunkToAnthropicEvents(
      {
        id: "c1",
        model: "m",
        choices: [{ finish_reason: "stop" }],
      } as unknown as ChatCompletionChunk,
      freshChatState(),
    )
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ])
  })
})

/** Each carries a `type` whose handler dereferences a body that is not there. */
const malformedResponsesEvents: Array<[string, unknown]> = [
  ["null body", null],
  ["array body", []],
  ["string body", "hello"],
  ["empty object", {}],
  ["unknown type", { type: "response.whatever" }],
  ["created without response", { type: "response.created" }],
  ["created with response null", { type: "response.created", response: null }],
  [
    "output_item.added without item",
    { type: "response.output_item.added", output_index: 0 },
  ],
  [
    "output_item.added with item null",
    { type: "response.output_item.added", output_index: 0, item: null },
  ],
  [
    "output_item.done without item",
    { type: "response.output_item.done", output_index: 0 },
  ],
  ["completed without response", { type: "response.completed" }],
  [
    "completed with a string response",
    { type: "response.completed", response: "done" },
  ],
  ["incomplete without response", { type: "response.incomplete" }],
  ["failed without response", { type: "response.failed" }],
  ["error without message", { type: "error" }],
  [
    "output_text.delta without indices",
    { type: "response.output_text.delta", delta: "hi" },
  ],
  [
    "function_call_arguments.delta without indices",
    { type: "response.function_call_arguments.delta", delta: "{" },
  ],
]

describe("translateResponsesStreamEvent boundary tolerance", () => {
  test.each(malformedResponsesEvents)(
    "%s yields events without throwing",
    (_label, rawEvent) => {
      const state = createResponsesStreamState(10)
      expect(() =>
        translateResponsesStreamEvent(rawEvent as ResponseStreamEvent, state),
      ).not.toThrow()
      expect(state.nextContentBlockIndex).toBeGreaterThanOrEqual(0)
    },
  )

  test("a terminal frame with no response body still terminates the stream", () => {
    // Regression: this used to throw inside the caller's `try`, which turned an
    // already-finished turn into a generic upstream error. It is still an error
    // — but a defined, terminal one, and `messageCompleted` is set so the caller
    // does not additionally report "stream ended without completion".
    const state = createResponsesStreamState(10)
    const events = translateResponsesStreamEvent(
      { type: "response.completed" } as unknown as ResponseStreamEvent,
      state,
    )
    expect(events.at(-1)?.type).toBe("error")
    expect(state.messageCompleted).toBe(true)
  })

  test("response.failed with no response body reports the generic reason", () => {
    const state = createResponsesStreamState(10)
    const events = translateResponsesStreamEvent(
      { type: "response.failed" } as unknown as ResponseStreamEvent,
      state,
    )
    expect(JSON.stringify(events)).toContain("unknown error")
    expect(state.messageCompleted).toBe(true)
  })

  test("a malformed frame does not consume a content block index", () => {
    const state = createResponsesStreamState(10)
    translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
      } as unknown as ResponseStreamEvent,
      state,
    )
    expect(state.nextContentBlockIndex).toBe(0)
    expect(state.openBlocks.size).toBe(0)
  })
})

describe("fixStreamIds boundary tolerance", () => {
  /**
   * The defect this covers: `fixStreamIds` runs on the native `/responses`
   * passthrough inside a `streamSSE` callback with no `try` around it, and its
   * `JSON.parse` was unguarded — while the sibling usage reader in the same
   * loop explicitly skips `data === "[DONE]"`. Any non-JSON frame therefore
   * threw where nothing could catch it.
   */
  test("passes the [DONE] sentinel through instead of throwing on it", () => {
    const tracker = createStreamIdTracker()
    expect(fixStreamIds("[DONE]", undefined, tracker)).toBe("[DONE]")
  })

  test("passes any non-JSON frame through byte-for-byte", () => {
    const tracker = createStreamIdTracker()
    expect(
      fixStreamIds("{truncated", "response.output_item.added", tracker),
    ).toBe("{truncated")
  })

  test("passes an output-item frame with no item through unchanged", () => {
    // The event name comes from the SSE `event:` field, not the body, so an
    // `added`/`done` name can arrive over a body that has no `item` at all.
    // Nothing checked that narrowing before.
    const tracker = createStreamIdTracker()
    for (const event of [
      "response.output_item.added",
      "response.output_item.done",
    ]) {
      expect(fixStreamIds('{"output_index":0}', event, tracker)).toBe(
        '{"output_index":0}',
      )
      expect(
        fixStreamIds('{"output_index":0,"item":null}', event, tracker),
      ).toBe('{"output_index":0,"item":null}')
    }
  })

  test("passes a non-object body through on the default branch", () => {
    const tracker = createStreamIdTracker()
    expect(fixStreamIds("null", "response.output_text.delta", tracker)).toBe(
      "null",
    )
    expect(fixStreamIds('"hi"', undefined, tracker)).toBe('"hi"')
  })

  test("still synchronises ids across a well-formed added/done pair", () => {
    const tracker = createStreamIdTracker()
    fixStreamIds(
      '{"output_index":0,"item":{"id":"first"}}',
      "response.output_item.added",
      tracker,
    )
    const done = fixStreamIds(
      '{"output_index":0,"item":{"id":"second"}}',
      "response.output_item.done",
      tracker,
    )
    expect(JSON.parse(done)).toEqual({
      output_index: 0,
      item: { id: "first" },
    })
  })

  test("mints an id for an added item that has none, and reuses it on done", () => {
    const tracker = createStreamIdTracker()
    const added = JSON.parse(
      fixStreamIds(
        '{"output_index":2,"item":{}}',
        "response.output_item.added",
        tracker,
      ),
    ) as { item: { id: string } }
    expect(added.item.id).toMatch(/^oi_2_.{16}$/u)
    const done = JSON.parse(
      fixStreamIds(
        '{"output_index":2,"item":{"id":"other"}}',
        "response.output_item.done",
        tracker,
      ),
    ) as { item: { id: string } }
    expect(done.item.id).toBe(added.item.id)
  })
})

describe("untrusted-frame readers", () => {
  test("asRecord rejects every non-object", () => {
    for (const value of [null, undefined, 1, "s", true]) {
      expect(asRecord(value)).toBeUndefined()
    }
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1])).toEqual([1] as unknown as Record<string, unknown>)
  })

  test("readNestedUsage is total over every wrong shape", () => {
    expect(readNestedUsage(null, "response")).toBeUndefined()
    expect(readNestedUsage("x", "response")).toBeUndefined()
    expect(readNestedUsage({}, "response")).toBeUndefined()
    expect(readNestedUsage({ response: null }, "response")).toBeUndefined()
    expect(readNestedUsage({ response: "done" }, "response")).toBeUndefined()
    expect(
      readNestedUsage({ response: { usage: { input_tokens: 4 } } }, "response"),
    ).toEqual({ input_tokens: 4 })
  })

  test("readNestedUsage hands back the live reference, not a copy", () => {
    // `adjustInputTokens` on the provider path mutates usage in place and the
    // frame is then re-serialised, so a copy would silently drop the fix.
    const frame = { message: { usage: { input_tokens: 10 } } }
    const usage = readNestedUsage(frame, "message")
    if (usage) usage.input_tokens = 3
    expect(frame.message.usage.input_tokens).toBe(3)
  })

  test("readUsage is total over every wrong shape", () => {
    expect(readUsage(null)).toBeUndefined()
    expect(readUsage([1, 2])).toBeUndefined()
    expect(readUsage({ usage: { output_tokens: 2 } })).toEqual({
      output_tokens: 2,
    })
  })
})

/** A minimal payload whose first user message carries `text` verbatim. */
const payloadWithReminderText = (text: string): AnthropicMessagesPayload => ({
  model: "claude-sonnet-4.5",
  max_tokens: 16,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
})

const withMarker = (json: string): AnthropicMessagesPayload =>
  payloadWithReminderText(
    `<system-reminder>__SUBAGENT_MARKER__ ${json}</system-reminder>`,
  )

describe("subagent marker parsing", () => {
  test("accepts a well-formed marker", () => {
    expect(
      parseSubagentMarkerFromFirstUser(
        withMarker(
          '{"session_id":"s1","agent_id":"a1","agent_type":"general-purpose"}',
        ),
      ),
    ).toEqual({
      session_id: "s1",
      agent_id: "a1",
      agent_type: "general-purpose",
    })
  })

  test("keeps unknown fields, because the marker is not ours to close", () => {
    expect(
      parseSubagentMarkerFromFirstUser(
        withMarker(
          '{"session_id":"s1","agent_id":"a1","agent_type":"t","future":1}',
        ),
      ),
    ).toMatchObject({ future: 1 })
  })

  test("rejects numeric ids the old truthiness guard let through", () => {
    // The whole reason this became a schema: `{"session_id": 123, ...}` passed
    // `!parsed.session_id || …` and every consumer downstream then held three
    // numbers typed as `string`.
    expect(
      parseSubagentMarkerFromFirstUser(
        withMarker('{"session_id":123,"agent_id":1,"agent_type":1}'),
      ),
    ).toBeNull()
  })

  test("still rejects empty strings, missing fields and bad JSON", () => {
    for (const json of [
      '{"session_id":"","agent_id":"a","agent_type":"t"}',
      '{"session_id":"s","agent_id":"a"}',
      '{"session_id":null,"agent_id":"a","agent_type":"t"}',
      "{not json",
      "null",
      "[]",
    ]) {
      expect(parseSubagentMarkerFromFirstUser(withMarker(json))).toBeNull()
    }
  })

  test("a rejected marker does not stop a later valid one being found", () => {
    const payload = payloadWithReminderText(
      "<system-reminder>__SUBAGENT_MARKER__ {not json}</system-reminder>"
        + '<system-reminder>__SUBAGENT_MARKER__ {"session_id":"s","agent_id":"a","agent_type":"t"}</system-reminder>',
    )
    expect(parseSubagentMarkerFromFirstUser(payload)).toMatchObject({
      session_id: "s",
    })
  })
})
