import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ControlSnapshot } from "~/lib/live/resources"

import { ControlClient } from "~/lib/live/client"
import { ControlHub } from "~/lib/live/hub"
import { createControlRoutes } from "~/routes/control/route"

// Mount the control routes under /control on a real ephemeral server, so the
// fetch-based client exercises the actual HTTP + SSE path end to end.
function serve(hub: ControlHub<ControlSnapshot>): {
  baseUrl: string
  stop: () => void
} {
  const app = new Hono()
  app.route(
    "/control",
    createControlRoutes({ getRequestIp: () => "127.0.0.1", hub }),
  )
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

function snapshotHub(
  snapshot: Record<string, unknown>,
): ControlHub<ControlSnapshot> {
  return new ControlHub<ControlSnapshot>({
    buildSnapshot: () =>
      Promise.resolve(snapshot as unknown as ControlSnapshot),
  })
}

const teardowns: Array<() => void> = []
afterEach(() => {
  for (const t of teardowns.splice(0)) t()
})

/** Resolve once a state satisfying `pred` is observed. */
function waitForState(
  client: ControlClient,
  pred: (s: ReturnType<ControlClient["getState"]>) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const off = client.onState((s) => {
      if (pred(s)) {
        off()
        resolve()
      }
    })
  })
}

describe("ControlClient", () => {
  test("connect seeds per-topic state from the snapshot frame", async () => {
    const hub = snapshotHub({ auth: { state: "authenticated" } })
    const { baseUrl, stop } = serve(hub)
    const client = new ControlClient({ baseUrl })
    teardowns.push(() => {
      client.close()
      hub.dispose()
      stop()
    })

    const seeded = waitForState(client, (s) => s.auth !== undefined)
    void client.connect()
    await seeded

    expect(client.getState().auth).toEqual({ state: "authenticated" })
  })

  test("a live delta overwrites the topic state", async () => {
    const hub = snapshotHub({ auth: { state: "unauthenticated" } })
    const { baseUrl, stop } = serve(hub)
    const client = new ControlClient({ baseUrl })
    teardowns.push(() => {
      client.close()
      hub.dispose()
      stop()
    })

    void client.connect()
    await waitForState(client, (s) => s.auth !== undefined)

    const updated = waitForState(
      client,
      (s) =>
        (s.accounts as { active_key?: string } | undefined)?.active_key
        === "alice@github.com",
    )
    hub.emit("accounts", { accounts: [], active_key: "alice@github.com" })
    await updated

    expect(
      (client.getState().accounts as { active_key?: string }).active_key,
    ).toBe("alice@github.com")
  })

  test("read + action helpers hit the endpoints", async () => {
    const hub = snapshotHub({})
    const { baseUrl, stop } = serve(hub)
    const client = new ControlClient({ baseUrl })
    teardowns.push(() => {
      hub.dispose()
      stop()
    })

    expect(await client.getAuth()).toHaveProperty("state")
    // No supervising shell in the test process → quit reports 409's body.
    expect(await client.quit()).toEqual({
      ok: false,
      reason: "no_supervising_shell",
    })
  })
})
