import { afterEach, describe, expect, test } from "bun:test"

import type { ControlSnapshot } from "~/lib/live/resources"

import { frameEnvelopeSchema, type FrameEnvelope } from "~/lib/live/contract"
import { ControlHub } from "~/lib/live/hub"
import { stopControlHub } from "~/lib/live/service"
import { createControlRoutes } from "~/routes/control/route"

afterEach(() => {
  // Safety: tear down the wired singleton if any test reached the default hub.
  stopControlHub()
})

function makeApp(
  opts: { ip?: string; hub?: ControlHub<ControlSnapshot> } = {},
): ReturnType<typeof createControlRoutes> {
  return createControlRoutes({
    getRequestIp: () => opts.ip ?? "127.0.0.1",
    hub: opts.hub,
  })
}

describe("control route — loopback gate", () => {
  test("a non-loopback caller gets 404 on every path", async () => {
    const app = makeApp({ ip: "203.0.113.7" })
    expect((await app.request("/auth")).status).toBe(404)
    expect((await app.request("/events")).status).toBe(404)
    expect(
      (await app.request("/accounts/switch", { method: "POST" })).status,
    ).toBe(404)
  })
})

describe("control route — reads", () => {
  test("GET /auth returns the auth status", async () => {
    const res = await makeApp().request("/auth")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    expect(typeof body.state).toBe("string")
  })

  test("GET /clients returns an empty roster with a total", async () => {
    const res = await makeApp().request("/clients")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ clients: [], total: 0 })
  })

  test("GET /models returns a (possibly empty) catalog with a count", async () => {
    const res = await makeApp().request("/models")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; models: Array<unknown> }
    expect(body.count).toBe(body.models.length)
  })

  test("GET /config and /usage are 200", async () => {
    const app = makeApp()
    expect((await app.request("/config")).status).toBe(200)
    expect((await app.request("/usage")).status).toBe(200)
  })
})

describe("control route — shell signals", () => {
  test("POST /quit is 409 with no supervising shell", async () => {
    const res = await makeApp().request("/quit", { method: "POST" })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      ok: false,
      reason: "no_supervising_shell",
    })
  })

  test("POST /upgrade is 409 with no supervising shell", async () => {
    const res = await makeApp().request("/upgrade", { method: "POST" })
    expect(res.status).toBe(409)
  })
})

describe("control route — actions", () => {
  test("POST /accounts/switch without a key is 400", async () => {
    const hub = new ControlHub<ControlSnapshot>({
      buildSnapshot: () =>
        Promise.resolve({ marker: "x" } as unknown as ControlSnapshot),
    })
    const res = await makeApp({ hub }).request("/accounts/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(400)
    hub.dispose()
  })
})

describe("control route — SSE event stream", () => {
  test("GET /events opens an event-stream and sends the snapshot frame first", async () => {
    const hub = new ControlHub<ControlSnapshot>({
      buildSnapshot: () =>
        Promise.resolve({ marker: "snap-ok" } as unknown as ControlSnapshot),
    })
    const res = await makeApp({ hub }).request("/events")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    if (!res.body) throw new Error("expected a streaming body")

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const { value } = await reader.read()
    await reader.cancel()
    hub.dispose()
    const block = new TextDecoder().decode(value).trim()

    expect(block).toContain("id: 0")
    expect(block).toContain("event: snapshot")
    expect(block).toContain("snap-ok")

    const dataLine =
      block.split("\n").find((line) => line.startsWith("data:")) ?? ""
    const env: FrameEnvelope = frameEnvelopeSchema.parse({
      id: 0,
      event: "snapshot",
      data: JSON.parse(dataLine.slice("data:".length).trim()) as unknown,
    })
    expect(env.event).toBe("snapshot")
  })
})

describe("control route — auth flow", () => {
  test("POST /auth/cancel with no active flow returns the current status", async () => {
    const res = await makeApp().request("/auth/cancel", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    expect(typeof body.state).toBe("string")
  })

  test("POST /auth/sign-out is ok with no session", async () => {
    const res = await makeApp().request("/auth/sign-out", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("POST /auth/rearm returns an outcome + status with no credential", async () => {
    const res = await makeApp().request("/auth/rearm", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      outcome: unknown
      status: { state: string }
    }
    expect(body.outcome).toBeDefined()
    expect(typeof body.status.state).toBe("string")
  })

  test("GET /update-status is 200", async () => {
    expect((await makeApp().request("/update-status")).status).toBe(200)
  })
})

describe("control route — settings endpoints", () => {
  test("api-keys create → list → delete round-trips", async () => {
    const app = makeApp()
    const created = await app.request("/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "test-key", key: "testkey123" }),
    })
    expect(created.status).toBe(201)
    const entry = (await created.json()) as { id: string; key: string }
    expect(entry.key).toBe("testkey123")

    const list = (await (await app.request("/api-keys")).json()) as {
      entries: Array<{ id: string }>
    }
    expect(list.entries.some((e) => e.id === entry.id)).toBe(true)

    const del = await app.request(`/api-keys/${entry.id}`, { method: "DELETE" })
    expect(del.status).toBe(204)
  })

  test("GET /diagnostics returns version + token presence", async () => {
    const res = await makeApp().request("/diagnostics")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: string
      tokens: { github_token_present: boolean }
    }
    expect(typeof body.version).toBe("string")
    expect(typeof body.tokens.github_token_present).toBe("boolean")
  })
})
