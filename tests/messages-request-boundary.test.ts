/**
 * `/v1/messages` request-boundary status correctness.
 *
 * `handleCompletion` took `await c.req.json<AnthropicMessagesPayload>()` and
 * went straight to work on it. The cast is a claim about a body the client
 * controls, so a body that isn't the claimed shape reached a property access
 * and threw — and `forwardError`'s final branch turns any non-`HTTPError` into
 * a **500** carrying the JS message. A malformed request was reported as a
 * proxy crash: `500 {"message":"null is not an object (evaluating 'delete
 * payload.diagnostics')"}`. Clients retry a 500 and don't retry a 400, so the
 * status is not cosmetic.
 *
 * The last case is the opposite problem: `{"type":"tool_result",
 * "tool_use_id":"…"}` with no `content` is SPEC-LEGAL — `content` is optional
 * on a tool_result — and it is exactly the shape the tool_result/text merge
 * exists to handle. It must be SERVED, not rejected: the merge spread
 * `[...tr.content, textBlock]` on an absent `content`, which threw
 * "Spread syntax requires ...iterable not be null or undefined" → another 500.
 */

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { messageRoutes } from "~/routes/messages/route"

const app = new Hono()
app.route("/v1/messages", messageRoutes)

const post = (body: string) =>
  app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })

const errorMessage = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: { message?: string } }
  return body.error?.message ?? ""
}

describe("/v1/messages rejects a malformed body with 400, not 500", () => {
  const badBodies: Array<[string, string]> = [
    ["a null body", "null"],
    ["an unparseable body", "{"],
    ["an empty body", ""],
    ["a JSON array", "[]"],
    ["a JSON string", '"hello"'],
    ["no messages key", JSON.stringify({ model: "m", max_tokens: 1 })],
    [
      "messages is not an array",
      JSON.stringify({ model: "m", max_tokens: 1, messages: "hi" }),
    ],
    [
      "messages is null",
      JSON.stringify({ model: "m", max_tokens: 1, messages: null }),
    ],
  ]

  test.each(badBodies)("%s → 400", async (_label, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
  })

  test("the 400 explains the request, not the interpreter", async () => {
    const message = await errorMessage(await post("null"))
    expect(message).not.toContain("is not an object")
    expect(message).not.toContain("undefined")
    expect(message.toLowerCase()).toContain("messages")
  })

  test("the error type is invalid_request_error", async () => {
    const res = await post(JSON.stringify({ model: "m" }))
    const body = (await res.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe("invalid_request_error")
  })
})

describe("/v1/messages serves a spec-legal tool_result without content", () => {
  test("does not 400 or 500 on the merge path", async () => {
    const res = await post(
      JSON.stringify({
        model: "some-unknown-model",
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1" },
              { type: "text", text: "and here is the rest" },
            ],
          },
        ],
      }),
    )

    // No upstream credential in the test process, so the request cannot
    // succeed — but it must fail at the UPSTREAM call, never on our own
    // preprocessing. A 400 would mean we rejected a legal payload; the
    // TypeError message below would mean we crashed on it.
    expect(res.status).not.toBe(400)
    const message = await errorMessage(res)
    expect(message).not.toContain("Spread syntax")
    expect(message).not.toContain("is not an object")
  })
})
