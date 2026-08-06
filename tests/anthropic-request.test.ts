import { afterEach, beforeEach, describe, test, expect } from "bun:test"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { COMPACT_REQUEST } from "../src/lib/models/compact"
import { state } from "../src/lib/runtime-state/state"
import {
  normalizeToolSchema,
  translateToOpenAI,
} from "../src/routes/messages/non-stream-translation"
import { getCompactType } from "../src/routes/messages/preprocess"

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

// Zod schema for the entire chat completion request payload.
// This is derived from the openapi.documented.yml specification.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
})

/**
 * Validates if a request payload conforms to the OpenAI Chat Completion v1 shape using Zod.
 * @param payload The request payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

function getTextParts(
  content: string | Array<{ type: string; text?: string }> | null | undefined,
): Array<string> {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? [content] : []
  }

  return content.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  )
}

describe("Anthropic to OpenAI translation logic", () => {
  test("should translate minimal Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should translate comprehensive Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: "user-123" },
      tools: [
        {
          name: "getWeather",
          description: "Gets weather info",
          input_schema: { location: { type: "string" } },
        },
      ],
      tool_choice: { type: "auto" },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // The schema check above is a floor, not the assertion. `tools` is
    // `z.array(z.any())`, `tool_choice` is `string | object`, and `messages`
    // only has to be non-empty — so it stayed green with every tool mapped to
    // `undefined`, `tool_choice` reduced to `""`, and the system prompt dropped
    // entirely. Mutation testing found all three. Pin the whole payload
    // instead: this is the wire body sent upstream, and its field values are
    // the entire contract of this function.
    expect(openAIPayload).toEqual({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      max_tokens: 150,
      stop: undefined,
      stream: false,
      temperature: 0.7,
      top_p: 1,
      user: "user-123",
      tools: [
        {
          type: "function",
          function: {
            name: "getWeather",
            description: "Gets weather info",
            parameters: { location: { type: "string" } },
          },
        },
      ],
      tool_choice: "auto",
      thinking_budget: undefined,
    })
  })
})

describe("Anthropic to OpenAI translation — system prompt and tool_choice", () => {
  test("system prompt as an array of text blocks joins with a blank line", () => {
    // The `else` arm of handleSystemPrompt had no fixture at all: every other
    // test passes `system` as a string. The join separator is a wire-shape
    // decision (two newlines, not one, not none), so pin it.
    const openAIPayload = translateToOpenAI({
      model: "gpt-4o",
      system: [
        { type: "text", text: "First instruction." },
        { type: "text", text: "Second instruction." },
      ],
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 10,
    })
    expect(openAIPayload.messages[0]).toEqual({
      role: "system",
      content: "First instruction.\n\nSecond instruction.",
    })
  })

  test.each<
    [
      AnthropicMessagesPayload["tool_choice"],
      ChatCompletionsPayload["tool_choice"],
    ]
  >([
    [{ type: "auto" }, "auto"],
    [{ type: "any" }, "required"],
    [{ type: "none" }, "none"],
    [
      { type: "tool", name: "getWeather" },
      { type: "function", function: { name: "getWeather" } },
    ],
    // A `tool` choice with no name cannot be expressed on the OpenAI side.
    [{ type: "tool" }, undefined],
    [undefined, undefined],
  ])("tool_choice %o maps to %o", (input, expected) => {
    const openAIPayload = translateToOpenAI({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 10,
      tool_choice: input,
    })
    expect(openAIPayload.tool_choice).toEqual(expected)
  })

  test("tools are omitted entirely when the request declares none", () => {
    const openAIPayload = translateToOpenAI({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 10,
    })
    expect(openAIPayload.tools).toBeUndefined()
  })
})

describe("Anthropic to OpenAI translation — messages and thinking blocks", () => {
  test("should handle missing fields gracefully", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle invalid types in Anthropic payload", () => {
    const anthropicPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    // @ts-expect-error intended to be invalid
    const openAIPayload = translateToOpenAI(anthropicPayload)
    // Should fail validation
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(false)
  })

  test("should handle thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this simple math problem...",
              signature: "abc123",
            },
            { type: "text", text: "2+2 equals 4." },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is combined with text content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.reasoning_text).toContain(
      "Let me think about this simple math problem...",
    )
    expect(getTextParts(assistantMessage?.content)).toContain("2+2 equals 4.")
  })

  test("should handle thinking blocks with tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I need to call the weather API to get current weather information.",
              signature: "def456",
            },
            { type: "text", text: "I'll check the weather for you." },
            {
              type: "tool_use",
              id: "call_123",
              name: "get_weather",
              input: { location: "New York" },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is included in the message content
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.reasoning_text).toContain(
      "I need to call the weather API",
    )
    expect(getTextParts(assistantMessage?.content)).toContain(
      "I'll check the weather for you.",
    )
    expect(assistantMessage?.tool_calls).toHaveLength(1)
    expect(assistantMessage?.tool_calls?.[0].function.name).toBe("get_weather")
  })

  test("should map tool_reference tool results into chat tool messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_123",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "tool_123",
        content: [
          {
            type: "text",
            text: "Tool AskUserQuestion loaded",
          },
        ],
      },
    ])
  })
})

/**
 * `normalizeToolSchema` is exported, pure, and had **zero** tests — every one of
 * its mutants survived, including emptying the whole function body. It is also
 * shared: `responses-translation.ts` calls it on the Responses path too. Its
 * whole job is to stop OpenAI rejecting an `object` schema with no `properties`,
 * so getting it wrong is a 400 from upstream on every tool-carrying request.
 */
describe("normalizeToolSchema", () => {
  test("adds an empty properties object to an object schema that lacks one", () => {
    expect(normalizeToolSchema({ type: "object" })).toEqual({
      type: "object",
      properties: {},
    })
  })

  test("leaves an object schema that already has properties untouched", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } }
    expect(normalizeToolSchema(schema)).toBe(schema)
  })

  test("leaves a non-object schema untouched even without properties", () => {
    // Both halves of the `&&` matter: widening it to `||` would inject
    // `properties: {}` into an array/string schema, which is not valid there.
    const arraySchema = { type: "array", items: { type: "string" } }
    expect(normalizeToolSchema(arraySchema)).toBe(arraySchema)
    const stringSchema = { type: "string" }
    expect(normalizeToolSchema(stringSchema)).toBe(stringSchema)
  })

  test("preserves the rest of the schema when adding properties", () => {
    expect(
      normalizeToolSchema({ type: "object", required: ["a"], extra: 1 }),
    ).toEqual({ type: "object", required: ["a"], extra: 1, properties: {} })
  })
})

/**
 * The `thinking_budget` clamp had zero coverage: no test both set
 * `payload.thinking` and put a matching entry in `state.models`, so the whole of
 * `getThinkingBudget` was unobservable — `Math.min`↔`Math.max`,
 * `maxOutputTokens - 1`↔`+ 1`, and the `> 0` boundary all survived. A wrong
 * clamp here is the silently-wrong-transform case: the request still succeeds,
 * it just reasons for the wrong number of tokens.
 *
 * `state.models` is process-global (testing-strategy.md §5.6), so it is reset in
 * BOTH `beforeEach` and `afterEach`.
 */
const modelWithBudgets = (
  maxThinkingBudget: number,
  maxOutputTokens: number,
  minThinkingBudget: number,
) => ({
  capabilities: {
    family: "claude-sonnet-4.6",
    limits: { max_output_tokens: maxOutputTokens },
    object: "model_capabilities" as const,
    supports: {
      max_thinking_budget: maxThinkingBudget,
      min_thinking_budget: minThinkingBudget,
    },
    tokenizer: "o200k_base",
    type: "chat" as const,
  },
  id: "claude-sonnet-4-6",
  model_picker_enabled: true,
  name: "Sonnet",
  object: "model" as const,
  preview: false,
  vendor: "Anthropic",
  version: "claude-sonnet-4.6",
  supported_endpoints: ["/v1/messages"],
})

const budgetFor = (requested: number | undefined) =>
  translateToOpenAI({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 100,
    thinking: {
      type: "enabled",
      ...(requested === undefined ? {} : { budget_tokens: requested }),
    },
  }).thinking_budget

describe("thinking budget clamp", () => {
  const originalModels = state.models

  beforeEach(() => {
    state.models = undefined
  })
  afterEach(() => {
    state.models = originalModels
  })

  test("a requested budget under both ceilings passes through", () => {
    state.models = {
      data: [modelWithBudgets(20_000, 32_000, 1024)],
      object: "list",
    }
    expect(budgetFor(5000)).toBe(5000)
  })

  test("the ceiling is the LOWER of maxThinkingBudget and maxOutputTokens - 1", () => {
    // maxOutputTokens - 1 = 7999 is the binding constraint, not the 20000
    // thinking budget. `Math.min` → `Math.max` would give 20000, and
    // `maxOutputTokens - 1` → `+ 1` would give 8001.
    state.models = {
      data: [modelWithBudgets(20_000, 8000, 1024)],
      object: "list",
    }
    expect(budgetFor(50_000)).toBe(7999)
  })

  test("maxThinkingBudget binds when it is the lower of the two", () => {
    state.models = {
      data: [modelWithBudgets(6000, 32_000, 1024)],
      object: "list",
    }
    expect(budgetFor(50_000)).toBe(6000)
  })

  test("a requested budget below the floor is raised to minThinkingBudget", () => {
    // `Math.max(budgetTokens, minThinkingBudget)` → `Math.min` would give 10.
    state.models = {
      data: [modelWithBudgets(20_000, 32_000, 2048)],
      object: "list",
    }
    expect(budgetFor(10)).toBe(2048)
  })

  test("an absent budget_tokens defaults to the ceiling", () => {
    // The `??=` default. Mutated to `&&=` the field stays undefined and
    // Math.min(undefined, …) is NaN.
    state.models = {
      data: [modelWithBudgets(9000, 32_000, 1024)],
      object: "list",
    }
    expect(budgetFor(undefined)).toBe(9000)
  })

  test("a model with no thinking budget at all yields no thinking_budget", () => {
    // maxThinkingBudget resolves to 0, so the `> 0` gate must reject. Both
    // `>= 0` and `true` would emit a budget here.
    state.models = { data: [modelWithBudgets(0, 32_000, 1024)], object: "list" }
    expect(budgetFor(5000)).toBeUndefined()
  })

  test("no thinking_budget when the model is not in the catalog", () => {
    state.models = { data: [], object: "list" }
    expect(budgetFor(5000)).toBeUndefined()
  })
})

describe("compact request detection", () => {
  test("detects current compact summary prompts in string content", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content: `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.\n\n7. Pending Tasks:\n   - [Task 1]\n\n8. Current Work:\n   [Current work]`,
        },
      ],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(COMPACT_REQUEST)
  })

  test("detects compact prompts in user text blocks while ignoring system reminders", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>\nThe user opened a file.\n</system-reminder>",
            },
            {
              type: "text",
              text: `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.\n\n7. Pending Tasks:\n   - [Task 1]\n\n8. Current Work:\n   [Current work]`,
            },
          ],
        },
      ],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(COMPACT_REQUEST)
  })

  test("does not treat ordinary user quotes as compact prompts", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      messages: [
        {
          role: "user",
          content:
            'Please explain this prompt: "Your task is to create a detailed summary of the conversation so far"',
        },
      ],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(0)
  })

  test("keeps legacy system prompt compact detection", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet",
      system:
        "You are a helpful AI assistant tasked with summarizing conversations for future continuation.",
      messages: [{ role: "user", content: "continue" }],
      max_tokens: 1024,
    }

    expect(getCompactType(anthropicPayload)).toBe(COMPACT_REQUEST)
  })
})

describe("OpenAI Chat Completion v1 Request Payload Validation with Zod", () => {
  test("should return true for a minimal valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test("should return true for a comprehensive valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather like in Boston?" },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
      n: 1,
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test('should return false if the "model" field is missing', () => {
    const invalidPayload = {
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" field is missing', () => {
    const invalidPayload = {
      model: "gpt-4o",
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" array is empty', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "model" is not a string', () => {
    const invalidPayload = {
      model: 12345,
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "messages" is not an array', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: { role: "user", content: "Hello!" },
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing a "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing "content"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user" }],
    }
    // Note: Zod considers 'undefined' as missing, so this will fail as expected.
    const result = chatCompletionRequestSchema.safeParse(invalidPayload)
    expect(result.success).toBe(false)
  })

  test('should return false if a message has an invalid "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "customer", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false if an optional field has an incorrect type", () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for a completely empty object", () => {
    const invalidPayload = {}
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for null or non-object payloads", () => {
    expect(isValidChatCompletionRequest(null)).toBe(false)
    expect(isValidChatCompletionRequest(undefined)).toBe(false)
    expect(isValidChatCompletionRequest("a string")).toBe(false)
    expect(isValidChatCompletionRequest(123)).toBe(false)
  })
})
