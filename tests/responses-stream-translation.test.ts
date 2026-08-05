import { describe, expect, test } from "bun:test"

import type { AnthropicStreamEventData } from "~/lib/models/anthropic-types"
import type { ResponseOutputItemAddedEvent } from "~/services/copilot/create-responses"

import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"

const createFunctionCallAddedEvent = (): ResponseOutputItemAddedEvent => ({
  type: "response.output_item.added",
  sequence_number: 1,
  output_index: 1,
  item: {
    id: "item-1",
    type: "function_call",
    call_id: "call-1",
    name: "TodoWrite",
    arguments: "",
    status: "in_progress",
  },
})

describe("translateResponsesStreamEvent tool calls", () => {
  test("streams function call arguments across deltas", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 2,
          delta: '{"todos":',
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 3,
          delta: "[]}",
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 4,
          arguments: '{"todos":[]}',
        },
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "TodoWrite",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"todos":',
    })
    expect(deltas[1].delta).toEqual({
      type: "input_json_delta",
      partial_json: "[]}",
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("emits full arguments when only done payload is present", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments:
            '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
        },
        state,
      ),
    ].flat()

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json:
        '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("emits no argument delta for an all-empty function call", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments: "",
        },
        state,
      ),
    ].flat()

    // A tool_use block is still opened, with empty input — same shape as the
    // Chat Completions streaming path.
    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "TodoWrite",
        input: {},
      })
    }

    // But NO input_json_delta is ever emitted for an all-empty call: the
    // output_item.added guard skips the empty initial arguments, and the
    // function_call_arguments.done guard treats the empty string as falsy.
    const deltas = events.filter(
      (event) => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(0)

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })
})

/**
 * `response.created` as the Responses API actually sends it: `usage` is null.
 * Usage only appears on `response.completed`, which is the whole reason
 * `message_start` needs a local estimate.
 */
const createdEvent = (): Parameters<typeof translateResponsesStreamEvent>[0] =>
  ({
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp-1",
      model: "gpt-5.6-sol",
      output: [],
      usage: null,
    },
  }) as unknown as Parameters<typeof translateResponsesStreamEvent>[0]

const usageFromMessageStart = (
  events: Array<AnthropicStreamEventData>,
): { input_tokens: number; cache_read_input_tokens: number } | undefined => {
  const start = events.find((e) => e.type === "message_start")
  return (
    start as unknown as
      | {
          message: {
            usage: { input_tokens: number; cache_read_input_tokens: number }
          }
        }
      | undefined
  )?.message.usage
}

describe("message_start usage on the Responses flow", () => {
  // Regression. The Responses API sends `usage: null` on `response.created`, so
  // this frame used to report `input_tokens: 0` unconditionally. A client stamps
  // that zero onto every record it flushes before the terminal `message_delta`,
  // which made ~30% of Claude Code's assistant rows for a Responses-flow model
  // report zero context and pegged its meter at 0%.
  test("reports the local estimate when upstream has no usage yet", () => {
    const state = createResponsesStreamState(1234)
    const events = translateResponsesStreamEvent(createdEvent(), state)

    expect(usageFromMessageStart(events)?.input_tokens).toBe(1234)
  })

  test("without an estimate it still emits a well-formed frame", () => {
    // Falls back to the old zero rather than inventing a number — a wrong count
    // would be worse than a missing one.
    const state = createResponsesStreamState()
    const events = translateResponsesStreamEvent(createdEvent(), state)

    expect(usageFromMessageStart(events)?.input_tokens).toBe(0)
  })

  test("real upstream usage always wins over the estimate", () => {
    // If a future upstream does populate `response.created`, the estimate must
    // not shadow it — the estimate exists only to fill a gap.
    const state = createResponsesStreamState(9999)
    const withUsage = {
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp-1",
        model: "gpt-5.6-sol",
        output: [],
        usage: {
          input_tokens: 500,
          input_tokens_details: { cached_tokens: 120 },
        },
      },
    } as unknown as Parameters<typeof translateResponsesStreamEvent>[0]

    const usage = usageFromMessageStart(
      translateResponsesStreamEvent(withUsage, state),
    )
    // input minus cached, matching the non-streaming mapper.
    expect(usage?.input_tokens).toBe(380)
    expect(usage?.cache_read_input_tokens).toBe(120)
  })
})
