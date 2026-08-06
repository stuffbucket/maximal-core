/**
 * A single unparseable SSE frame must not end the whole response.
 *
 * Seven readers in this codebase take `JSON.parse` on an upstream frame. Five
 * guard it and skip the frame (`parseChatCompletionChunk`,
 * `parseResponsesStreamEvent`, `parseProviderStreamEvent`,
 * `parseAnthropicStreamEvent`, `fixStreamIds` — the last documents the rule:
 * "Not JSON at all … Passthrough means passthrough"). Two did not: the
 * `JSON.parse` in `handleWithChatCompletions`'s loop and the one in
 * `readResponsesFrame` sat bare inside the flow-level `try`, so one bad frame
 * was caught as "upstream stream failed mid-flight" and terminated the message.
 *
 * The asymmetry that makes this a bug rather than a policy choice is INSIDE
 * each of those two readers. Both are already total over a malformed *body* —
 * `tests/stream-boundary-tolerance.test.ts` proves the translators survive
 * `null`, `"hello"`, `42`, `[1,2]`, and `readResponsesFrame`'s very next line
 * is `if (!asRecord(event)) return null`, i.e. skip. So `data: "hello"` (valid
 * JSON, useless content) was skipped and the stream continued, while
 * `data: hello` (same useless content, invalid JSON) killed it. Identical
 * garbage, opposite outcomes, decided by nothing the client can control.
 *
 * Each test below sends the SAME stream twice — once with the junk frame as
 * valid JSON, once as invalid JSON — and asserts the two agree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/runtime-state/state"
import { messageRoutes } from "~/routes/messages/route"

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  models: state.models,
  manualApprove: state.manualApprove,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  lastRequestTimestamp: state.lastRequestTimestamp,
}

function resetState(): void {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = {
    object: "list",
    data: [
      { id: "chat-model", supported_endpoints: ["/chat/completions"] },
      { id: "responses-model", supported_endpoints: ["/responses"] },
    ],
  } as typeof state.models
}

beforeEach(resetState)

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
  state.models = originalState.models
  state.manualApprove = originalState.manualApprove
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.rateLimitWait = originalState.rateLimitWait
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  state.lastUpstreamRejection = undefined
})

function installSseFetch(body: string): void {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    )) as unknown as typeof fetch
}

async function streamMessages(model: string): Promise<string> {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
  return await res.text()
}

/** `junk` is spliced in as the body of one `data:` frame in the middle of an
 *  otherwise-good stream. */
const chatStream = (junk: string): string =>
  [
    `data: {"id":"1","model":"chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"before-"}}]}`,
    `data: ${junk}`,
    `data: {"id":"1","model":"chat-model","choices":[{"index":0,"delta":{"content":"AFTER"}}]}`,
    `data: {"id":"1","model":"chat-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    ``,
  ].join("\n\n")

const responsesStream = (junk: string): string =>
  [
    `event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}`,
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"before-"}`,
    `event: response.output_text.delta\ndata: ${junk}`,
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"AFTER"}`,
    `event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`,
    ``,
  ].join("\n\n")

// Valid JSON with no usable content — already skipped by both readers.
const JUNK_AS_JSON = `"a keep-alive"`
// The same uselessness, not valid JSON.
const JUNK_AS_GARBAGE = `a keep-alive`

describe("chat-completions flow survives one unparseable frame", () => {
  test("valid-JSON junk and invalid-JSON junk behave the same", async () => {
    installSseFetch(chatStream(JUNK_AS_JSON))
    const tolerated = await streamMessages("chat-model")

    installSseFetch(chatStream(JUNK_AS_GARBAGE))
    const malformed = await streamMessages("chat-model")

    // The frame AFTER the junk still reaches the client.
    expect(tolerated).toContain("AFTER")
    expect(malformed).toContain("AFTER")
    // And neither turns a junk frame into a terminal error event.
    expect(tolerated).not.toContain("Upstream stream ended unexpectedly")
    expect(malformed).not.toContain("Upstream stream ended unexpectedly")
    expect(malformed).toContain("message_stop")
  })
})

describe("responses flow survives one unparseable frame", () => {
  test("valid-JSON junk and invalid-JSON junk behave the same", async () => {
    installSseFetch(responsesStream(JUNK_AS_JSON))
    const tolerated = await streamMessages("responses-model")

    installSseFetch(responsesStream(JUNK_AS_GARBAGE))
    const malformed = await streamMessages("responses-model")

    expect(tolerated).toContain("AFTER")
    expect(malformed).toContain("AFTER")
    expect(tolerated).not.toContain("Upstream stream ended unexpectedly")
    expect(malformed).not.toContain("Upstream stream ended unexpectedly")
  })
})
