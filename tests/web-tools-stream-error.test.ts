/**
 * Mid-stream resilience for the **web-tools** `/v1/messages` flow.
 *
 * `tests/streaming-error-resilience.test.ts` covers `emitStreamError`, "the
 * helper all three flows call in their catch blocks". There is a fourth flow:
 * a request carrying Anthropic's server-side web tools
 * (`web_search_20250305` / `web_fetch_20250910`) is routed to
 * `handleWithWebToolsAgent`, which runs a MULTI-TURN agent loop with the
 * upstream call INSIDE `streamSSE`.
 *
 * That placement is what makes it different from its siblings. In
 * `api-flows.ts` the upstream call happens *before* `streamSSE`, so an HTTP
 * failure propagates to the route's `forwardError` and the client gets a real
 * status code. Here the call is inside the stream callback, where Hono's
 * `streamSSE` — invoked with no `onError` argument — `console.error`s the throw
 * and closes the response. The client has already been handed `200 OK` with
 * `content-type: text/event-stream`, so it sees an SSE body that simply stops:
 * no `message_delta`, no `message_stop`, no `error` event.
 *
 * Both cases below are ordinary Copilot behaviour, not exotic input: a 429/500
 * on a turn, or a connection reset mid-stream. The agent loop makes one
 * separately-billed upstream call per turn, so a request that runs a search has
 * several chances to hit one.
 */

import { describe, expect, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { WebToolPolicy } from "~/routes/messages/web-tools/rewriter"
import type { UpstreamCall } from "~/routes/messages/web-tools/stream"

import { handleWithWebToolsAgent } from "~/routes/messages/web-tools/flow"

const payload: AnthropicMessagesPayload = {
  model: "claude-3-5-sonnet",
  max_tokens: 1024,
  stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
}

const searchPolicy: WebToolPolicy = {
  declarations: [{ type: "web_search_20250305", name: "web_search" }],
  hasSearch: true,
  hasFetch: false,
}

const options = {
  requestId: "req_web_tools_error",
  logger: consola.create({ level: 0 }),
}

/** One SSE `event:` name per frame, in wire order. */
function eventNames(body: string): Array<string> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice("event: ".length))
}

/** Drive the real flow behind a real Hono route and read the whole SSE body. */
async function runFlow(upstreamCall: UpstreamCall): Promise<Response> {
  const app = new Hono()
  app.post("/", (c) =>
    handleWithWebToolsAgent({
      c,
      payload: structuredClone(payload),
      options,
      policy: searchPolicy,
      upstreamCall,
    }),
  )
  return app.request("/", { method: "POST" })
}

/** An upstream that rejects, as `createChatCompletions` does on a non-2xx. */
const rejectingUpstream =
  (message: string): UpstreamCall =>
  () =>
    Promise.reject(new Error(message))

/** An upstream whose SSE iterator throws part-way, as a reset connection does. */
const resettingUpstream = (
  frames: Array<{ data?: string }>,
  message: string,
): UpstreamCall =>
  (() =>
    Promise.resolve({
      // eslint-disable-next-line @typescript-eslint/require-await
      [Symbol.asyncIterator]: async function* () {
        for (const frame of frames) yield frame
        throw new Error(message)
      },
    })) as unknown as UpstreamCall

const textDelta = (text: string) => ({
  data: JSON.stringify({
    id: "msg_1",
    object: "chat.completion.chunk",
    created: 0,
    model: "x",
    choices: [{ index: 0, delta: { role: "assistant", content: text } }],
  }),
})

describe("web-tools streaming flow — mid-stream failure", () => {
  test("emits an error event when the first upstream turn is rejected", async () => {
    const res = await runFlow(rejectingUpstream("HTTP 500 upstream"))
    const body = await res.text()

    // The client was already committed to a 200 SSE response, so the failure
    // can only be reported in-band.
    expect(res.status).toBe(200)
    expect(eventNames(body)).toContain("error")
    expect(body).toContain("HTTP 500 upstream")
  })

  test("emits an error event when the stream resets after content", async () => {
    const res = await runFlow(
      resettingUpstream([textDelta("partial answer")], "socket hang up"),
    )
    const body = await res.text()
    const names = eventNames(body)

    // Content was delivered, then the connection died. The client must be told
    // rather than left waiting for a message_stop that will never arrive.
    expect(names).toContain("content_block_delta")
    expect(names).toContain("error")
    expect(body).toContain("socket hang up")
  })
})
