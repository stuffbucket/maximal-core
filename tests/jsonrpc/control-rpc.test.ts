import { afterEach, describe, expect, test } from "bun:test"

import {
  PROTOCOL_VERSION_HEADER,
  SUPPORTED_PROTOCOL_VERSION,
} from "~/lib/live/contract"
import { stopControlHub } from "~/lib/live/service"
import { createControlRoutes } from "~/routes/control/route"

afterEach(() => {
  stopControlHub()
})

interface RpcBody {
  id?: string | number
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: { reason?: string } }
}

function app(ip = "127.0.0.1"): ReturnType<typeof createControlRoutes> {
  return createControlRoutes({ getRequestIp: () => ip })
}

async function rpc(
  method: string,
  opts: { id?: string | number; params?: unknown; version?: string } = {},
): Promise<{ status: number; body: RpcBody }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  if (opts.version !== undefined) {
    headers[PROTOCOL_VERSION_HEADER] = opts.version
  }
  const res = await app().request("/rpc", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(opts.id === undefined ? {} : { id: opts.id }),
      method,
      ...(opts.params === undefined ? {} : { params: opts.params }),
    }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as RpcBody) : {} }
}

describe("control /rpc — discovery", () => {
  test("server/discover works with no prior handshake", async () => {
    const { status, body } = await rpc("server/discover", { id: 1 })
    expect(status).toBe(200)
    expect(body.result?.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSION)
    expect(body.result?.identity).toMatchObject({ name: "maximal-core" })
  })

  test("discovered capabilities list the callable methods", async () => {
    const { body } = await rpc("server/discover", { id: 1 })
    const caps = body.result?.capabilities as { methods: Array<string> }
    // The account methods are composed in at route level, not in the static
    // registry — discovery must still advertise them or a client can't find them.
    expect(caps.methods).toContain("auth/status")
    expect(caps.methods).toContain("accounts/switch")
    expect(caps.methods).toContain("health")
  })
})

describe("control /rpc — protocol version", () => {
  test("a matching pinned version is accepted", async () => {
    const { status } = await rpc("health", {
      id: 1,
      version: SUPPORTED_PROTOCOL_VERSION,
    })
    expect(status).toBe(200)
  })

  test("an unsupported pinned version fails legibly, naming both versions", async () => {
    const { status, body } = await rpc("health", { id: 1, version: "999" })
    expect(status).toBe(400)
    expect(body.error?.data?.reason).toBe("unsupported_version")
    expect(body.error?.message).toContain("999")
    expect(body.error?.message).toContain(SUPPORTED_PROTOCOL_VERSION)
  })

  test("an absent version header is allowed — discovery would be circular otherwise", async () => {
    const { status } = await rpc("health", { id: 1 })
    expect(status).toBe(200)
  })
})

describe("control /rpc — transport rules", () => {
  test("GET is 405: the session-era verbs were never part of this transport", async () => {
    expect((await app().request("/rpc")).status).toBe(405)
  })

  test("a non-loopback caller gets 404 before any JSON-RPC parsing", async () => {
    const res = await app("203.0.113.7").request("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health" }),
    })
    expect(res.status).toBe(404)
    // A remote caller must not learn the endpoint exists, so the body is not a
    // well-formed JSON-RPC error.
    expect(await res.text()).not.toContain("jsonrpc")
  })
})

describe("control /rpc — params validation", () => {
  test("accounts/switch without a key is -32602, not an upstream error", async () => {
    const { body } = await rpc("accounts/switch", { id: 1, params: {} })
    expect(body.error?.code).toBe(-32602)
    expect(body.error?.message).toContain("key")
  })
})

/** Open `subscriptions/listen` and read its first SSE block. */
async function listen(): Promise<{
  status: number
  ctype: string
  block: string
}> {
  const res = await app().request("/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "subscriptions/listen",
    }),
  })
  if (!res.body) throw new Error("expected a streaming body")
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const { value } = await reader.read()
  await reader.cancel()
  return {
    status: res.status,
    ctype: res.headers.get("content-type") ?? "",
    block: new TextDecoder().decode(value).trim(),
  }
}

describe("control /rpc — subscriptions/listen", () => {
  // The canonical push surface, and until now the only one with no unit
  // coverage: the sole SSE test in the suite pointed at `GET /events`, the
  // deprecated shim. That is exactly backwards — the surface every client is
  // told to use was the untested one.
  test("the response IS the subscription: an open stream, not a JSON result", async () => {
    const { status, ctype } = await listen()
    expect(status).toBe(200)
    expect(ctype).toContain("text/event-stream")
  })

  test("opens with a snapshot notification so a client paints real state first", async () => {
    const { block } = await listen()
    const dataLine =
      block.split("\n").find((line) => line.startsWith("data:")) ?? ""
    const frame = JSON.parse(dataLine.slice("data:".length).trim()) as {
      jsonrpc: string
      method: string
      id?: unknown
      params?: { protocolVersion?: number }
    }
    expect(frame.jsonrpc).toBe("2.0")
    expect(frame.method).toBe("control/snapshot")
    expect(frame.params?.protocolVersion).toBe(2)
    // A notification, not a response: an `id` would invite a client to
    // correlate a reply that is never coming.
    expect(frame.id).toBeUndefined()
  })

  test("carries no SSE id line — the transport advertises no resumability", async () => {
    const { block } = await listen()
    expect(block.split("\n").some((line) => line.startsWith("id:"))).toBe(false)
  })
})
