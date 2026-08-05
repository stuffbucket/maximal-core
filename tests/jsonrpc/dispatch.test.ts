import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { RpcRegistry } from "~/lib/jsonrpc/dispatch"

import { HTTPError } from "~/lib/errors/error"
import {
  CONTROL_UPSTREAM_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from "~/lib/jsonrpc/codes"
import { createRpcHandler } from "~/lib/jsonrpc/dispatch"

interface RpcBody {
  jsonrpc?: string
  id?: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const REGISTRY: RpcRegistry = {
  "state/get": (params) => ({ echoed: params }),
  "app/noop": () => undefined,
  "test/throws": () => {
    throw new HTTPError(
      "upstream said no",
      new Response(JSON.stringify({ message: "upstream said no" }), {
        status: 502,
      }),
    )
  },
  "test/stream": () =>
    new Response("data: hi\n\n", {
      headers: { "content-type": "text/event-stream" },
    }),
}

function makeApp() {
  const app = new Hono()
  app.post("/rpc", createRpcHandler(REGISTRY))
  return app
}

async function post(body: unknown): Promise<{ status: number; body: RpcBody }> {
  const res = await makeApp().request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as RpcBody) : {} }
}

describe("jsonrpc dispatch — requests", () => {
  test("a well-formed request returns a result echoing the id", async () => {
    const { status, body } = await post({
      jsonrpc: "2.0",
      id: 7,
      method: "state/get",
      params: { topic: "auth" },
    })
    expect(status).toBe(200)
    expect(body.id).toBe(7)
    expect(body.result).toEqual({ echoed: { topic: "auth" } })
    expect(body.error).toBeUndefined()
  })

  test("a string id round-trips unchanged", async () => {
    const { body } = await post({
      jsonrpc: "2.0",
      id: "abc",
      method: "app/noop",
    })
    expect(body.id).toBe("abc")
    // A handler returning undefined must still produce a JSON-RPC result member —
    // omitting it would make the response neither a success nor an error.
    expect(body.result).toBeNull()
  })

  test("an unknown method is -32601 at HTTP 200, not a 404", async () => {
    const { status, body } = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "nope/missing",
    })
    expect(status).toBe(200)
    expect(body.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND)
    expect(body.id).toBe(1)
  })

  test("a streaming handler's Response passes through untouched", async () => {
    const res = await makeApp().request("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/stream" }),
    })
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    expect(await res.text()).toBe("data: hi\n\n")
  })
})

describe("jsonrpc dispatch — notifications", () => {
  test("a notification is acknowledged with 202 and an empty body", async () => {
    const res = await makeApp().request("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "app/noop" }),
    })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe("")
  })

  test("an UNKNOWN notification is still 202 — there is nowhere to report it", async () => {
    const res = await makeApp().request("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "nope/missing" }),
    })
    expect(res.status).toBe(202)
  })
})

describe("jsonrpc dispatch — malformed input", () => {
  test("unparseable JSON is -32700 at HTTP 400 with no id", async () => {
    const { status, body } = await post("{ not json")
    expect(status).toBe(400)
    expect(body.error?.code).toBe(JSON_RPC_PARSE_ERROR)
    expect(body.id).toBeUndefined()
  })

  test("a batch is rejected rather than partially served", async () => {
    const { status, body } = await post([
      { jsonrpc: "2.0", id: 1, method: "app/noop" },
    ])
    expect(status).toBe(400)
    expect(body.error?.code).toBe(JSON_RPC_INVALID_REQUEST)
  })

  test("a client-sent response is rejected as a direction error", async () => {
    const { status, body } = await post({ jsonrpc: "2.0", id: 1, result: {} })
    expect(status).toBe(400)
    expect(body.error?.code).toBe(JSON_RPC_INVALID_REQUEST)
    expect(body.error?.message).toContain("must not send")
  })

  test("a wrong jsonrpc version is invalid, and the id is echoed back", async () => {
    const { status, body } = await post({
      jsonrpc: "1.0",
      id: 42,
      method: "app/noop",
    })
    expect(status).toBe(400)
    expect(body.error?.code).toBe(JSON_RPC_INVALID_REQUEST)
    expect(body.id).toBe(42)
  })
})

describe("jsonrpc dispatch — thrown errors", () => {
  test("an HTTPError maps to an app code outside the JSON-RPC reserved range", async () => {
    const { status, body } = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "test/throws",
    })
    expect(status).toBe(200)
    expect(body.id).toBe(3)
    expect(body.error?.code).toBe(CONTROL_UPSTREAM_ERROR)
    // -32768..-32000 is reserved by JSON-RPC, and -32020..-32099 within it is
    // reserved for the MCP spec. We must never emit into either.
    expect(body.error?.code).toBeGreaterThan(-32000)
    // Clients discriminate on the string reason, never the HTTP status (ADR-0023).
    const data = body.error?.data as { reason?: string; retryable?: boolean }
    expect(data.reason).toBe("upstream_error")
    expect(data.retryable).toBe(false)
  })
})
