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

/**
 * The `headers` option is a published, credential-shaped affordance on an
 * exported SDK (`@stuffbucket/maximal-core/client`), and it is the "record built
 * elsewhere and spread into fetch" shape that `eslint.config.js`'s
 * `credential-attachment-single-mechanism` guard documents as structurally
 * invisible to it — the guard only lints this repo's `src/**` anyway, never a
 * consumer's call site. ADR-0001 records why the answer is "no credential here"
 * rather than "route it through sendRequest()".
 *
 * These assert the RUNTIME half of the contract. The type rejects literal
 * credential spellings, but a `Record<string, string>` assembled elsewhere has
 * `keyof` `string` and matches no literal key, so the type lets it through by
 * construction — every case below therefore uses that shape deliberately, which
 * is the only one that proves anything the compiler did not already prove.
 */
/** Built as a plain record so the compile-time half cannot mask the runtime
 *  half — this is what a consumer's `authHeaders` variable looks like. */
function asHeaders(name: string, value: string): Record<string, string> {
  return { [name]: value }
}

describe("ControlClient credential headers", () => {
  test.each([
    "x-api-key",
    "X-Api-Key",
    "X-API-KEY",
    "authorization",
    "Authorization",
    "AUTHORIZATION",
    "api-key",
    "proxy-authorization",
    "cookie",
    // Surrounding whitespace is not a header name — it must not smuggle one past
    // the check.
    " x-api-key ",
  ])("construction throws on %p", (name) => {
    expect(
      () =>
        new ControlClient({
          baseUrl: "http://127.0.0.1:1",
          headers: asHeaders(name, "secret"),
        }),
    ).toThrow(TypeError)
  })

  test("the thrown message names the header and does not echo its value", () => {
    let caught: unknown
    try {
      new ControlClient({
        baseUrl: "http://127.0.0.1:1",
        headers: asHeaders("X-Api-Key", "super-secret-value"),
      })
    } catch (error) {
      caught = error
    }
    const message = (caught as Error).message
    expect(message).toContain("X-Api-Key")
    // A thrown message reaches logs and bug reports; the secret must not.
    expect(message).not.toContain("super-secret-value")
  })

  test("non-credential headers are sent on both the RPC and read paths", async () => {
    const sent: Array<Record<string, string>> = []
    const client = new ControlClient({
      baseUrl: "http://127.0.0.1:1",
      headers: { "x-trace-id": "trace-1" },
      fetch: (_input, init) => {
        sent.push({ ...(init?.headers as Record<string, string>) })
        return Promise.resolve(Response.json({ result: null }))
      },
    })

    await client.call("server/discover")
    await client.getAuth()
    await client.quit()

    expect(sent).toHaveLength(3)
    for (const headers of sent) {
      expect(headers["x-trace-id"]).toBe("trace-1")
    }
  })

  test("mutating the caller's record after construction changes nothing", async () => {
    const caller: Record<string, string> = { "x-trace-id": "trace-1" }
    const sent: Array<Record<string, string>> = []
    const client = new ControlClient({
      baseUrl: "http://127.0.0.1:1",
      headers: caller,
      fetch: (_input, init) => {
        sent.push({ ...(init?.headers as Record<string, string>) })
        return Promise.resolve(Response.json({ result: null }))
      },
    })

    // The constructor validated `caller`, but the caller still holds it. Copying
    // is what makes that check hold for the client's whole life instead of only
    // for the instant of construction.
    caller["x-api-key"] = "added-later"
    await client.call("server/discover")

    expect(sent[0]).not.toHaveProperty("x-api-key")
  })
})

/**
 * The receiver the default fetch is invoked with.
 *
 * `ControlClient` stores the injectable fetch on a field and calls it as
 * `this.fetchImpl(...)`. An UNBOUND `fetch` therefore receives the client
 * instance. Node and Bun do not care; a browser or Electron renderer does —
 * `window.fetch` demands `window` and throws `TypeError: Illegal invocation`
 * for anything else. So every renderer-side consumer failed on its first call,
 * on the DEFAULT path (`options.fetch` omitted), which made it the common case
 * rather than an edge (maximal-core#104, found against v0.5.0).
 *
 * WHY THIS TEST EXISTS IN THIS SHAPE. The receiver rule is browser-only, so no
 * suite running under Bun can observe the failure directly — the whole reason
 * it shipped. Instead of a realm, this asserts the property the browser rule
 * depends on: the stored implementation must NOT be invoked with the client as
 * its receiver. That fails on a bare `fetch` and passes on a bound one, with no
 * browser involved.
 */

/**
 * Swap `globalThis.fetch` and hand back its restore.
 *
 * Capture and restore live in one synchronous closure on purpose. Writing
 * `globalThis.fetch = original` in a `finally` after an `await` is a genuine
 * hazard, not a lint quibble — `require-atomic-updates` flags it because the
 * global may have been reassigned by anything that ran during the await, and
 * the restore would then clobber it. Bun runs test files concurrently.
 */
function swapGlobalFetch(stub: typeof fetch): () => void {
  const original = globalThis.fetch
  globalThis.fetch = stub
  return () => {
    globalThis.fetch = original
  }
}

describe("ControlClient — the default fetch's receiver", () => {
  test("is not the client instance, so a browser realm cannot reject it", async () => {
    const seen: Array<unknown> = []
    const restore = swapGlobalFetch(function (this: unknown) {
      seen.push(this)
      return Promise.resolve(new Response("{}", { status: 200 }))
    } as unknown as typeof fetch)
    try {
      const client = new ControlClient({ baseUrl: "http://127.0.0.1:1" })
      await client.call("server/discover", {}).catch(() => undefined)
      expect(seen.length).toBeGreaterThan(0)
      for (const receiver of seen) {
        expect(receiver).not.toBe(client)
      }
    } finally {
      restore()
    }
  })

  // The caller already owns an injected fetch's binding, and re-binding
  // someone else's function would change what an arrow capturing `this`
  // resolves to. So it is passed through untouched.
  test("an injected fetch is passed through, not re-bound", async () => {
    const carrier = {
      calls: 0,
      fetchImpl(this: { calls: number }) {
        this.calls += 1
        return Promise.resolve(new Response("{}", { status: 200 }))
      },
    }
    const bound = carrier.fetchImpl.bind(carrier) as unknown as typeof fetch
    const client = new ControlClient({
      baseUrl: "http://127.0.0.1:1",
      fetch: bound,
    })
    await client.call("server/discover", {}).catch(() => undefined)
    expect(carrier.calls).toBeGreaterThan(0)
  })
})
