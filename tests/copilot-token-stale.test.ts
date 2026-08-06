/**
 * maximal-core#9 — a Copilot token refresh that keeps failing must not stay
 * indistinguishable from a healthy one.
 *
 * Three separable defects, one per describe block:
 *
 *   A. The failure is not surfaced. A non-auth-fatal refresh failure (the
 *      incident's `{ code, path, errno: 0 }` local-read error, a 5xx, a schema
 *      miss) logged and retried forever, recording nothing a status surface
 *      could read.
 *   B. The token is never marked unhealthy. `expires_at` comes back on every
 *      mint and was parsed and discarded, so the proxy could not tell a live
 *      bearer from a dead one — there was no state between "healthy" and
 *      "every request 403s".
 *   C. Requests keep being proxied with the dead credential. Upstream answers
 *      `403 authentication_failed`, which is (deliberately) not auth-fatal by
 *      our body-marker policy, so it forwards verbatim and clients tell the
 *      user to re-login — the one remedy that cannot help.
 *
 * Plus the boundary that keeps C from becoming an outage of its own: neither
 * an expired bearer alone nor a failing refresh alone may fail a request.
 *
 * Driven through the DI seam (`__setTokenDepsForTests`), never `mock.module` —
 * see AGENTS.md and docs/dev/testing-strategy.md §5.
 */

import type { Context } from "hono"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { CREDENTIAL_HEALTH } from "~/lib/auth/auth-types"
import { DiagnosticsResponse } from "~/lib/config/settings-types"
import {
  CopilotTokenStaleError,
  forwardError,
  HTTPError,
} from "~/lib/errors/error"
import {
  clearTokenTrio,
  copilotRefreshHealth,
  copilotTokenHealth,
  setCopilotToken,
  state,
} from "~/lib/runtime-state/state"
import { createControlRoutes } from "~/routes/control/route"
import { requireCopilotToken } from "~/services/copilot/upstream-request"

// Bypass Bun's module-mock registry for ~/lib/auth/token: auth-controller.test.ts
// installs a process-wide mock.module for it, and the afterAll restore is not
// reliable across sibling files in one `bun test` process. The `?nomock` suffix
// forces a distinct registry key resolving to the same source file — same
// reasoning (and same comment) as tests/token-auth-fatal.test.ts.
const tokenSpec = "../src/lib/auth/token.ts?nomock=copilot-token-stale"
const tokenMod = (await import(tokenSpec)) as typeof import("~/lib/auth/token")
const {
  __resetTokenDepsForTests,
  __setTokenDepsForTests,
  resolveCopilotExpiryMs,
  setupCopilotToken,
  stopCopilotRefreshLoop,
} = tokenMod

// A type alias, not an interface: the DI seam's parameter carries the `.loose()`
// schema's index signature, and only an alias gets an implicit one.
type TokenResult = {
  token: string
  refresh_in: number
  expires_at: number
}

const harness = {
  queue: [] as Array<() => Promise<TokenResult>>,
  fallback: (): Promise<TokenResult> =>
    Promise.resolve({
      token: "copilot_default",
      refresh_in: 1800,
      expires_at: Date.now() / 1000 + 1800,
    }),
}

/** A mint whose bearer expires `ttlMs` from now and whose refresh is due in
 *  `refreshInSeconds` — small values drive the loop within a test's lifetime. */
const mint = (
  token: string,
  refreshInSeconds: number,
  ttlMs: number,
): TokenResult => ({
  token,
  refresh_in: refreshInSeconds,
  expires_at: (Date.now() + ttlMs) / 1000,
})

// Both directions, per AGENTS.md: module-level singletons reset only on the way
// in leak to the next file; reset only on the way out inherit from the previous.
const reset = (): void => {
  stopCopilotRefreshLoop()
  harness.queue = []
  clearTokenTrio()
  state.copilotApiUrl = undefined
  __setTokenDepsForTests({
    getCopilotToken: () => {
      const next = harness.queue.shift()
      return next ? next() : harness.fallback()
    },
    // Never let a test reach the real degrade path (it writes accounts.json).
    markAuthDegraded: () => Promise.resolve(),
  })
}

beforeEach(reset)
afterEach(() => {
  reset()
  __resetTokenDepsForTests()
})

/** The refresh loop wakes on a ~1s tick for `refresh_in: 1`; 1500ms clears one
 *  attempt with margin. */
const oneRefreshTick = () => new Promise((r) => setTimeout(r, 1500))

// --- A. the refresh failure is observable ----------------------------------

describe("#9 A — a failing refresh is recorded, not just logged", () => {
  test("a non-auth-fatal refresh failure lands in the refresh-health counters", async () => {
    harness.queue = [
      () => Promise.resolve(mint("copilot_init", 1, 60_000)),
      () =>
        Promise.reject(
          new HTTPError("mint 502", new Response(null, { status: 502 })),
        ),
    ]

    await setupCopilotToken()
    expect(copilotRefreshHealth().consecutiveFailures).toBe(0)

    await oneRefreshTick()
    stopCopilotRefreshLoop()

    const health = copilotRefreshHealth()
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(1)
    expect(health.lastFailureAtMs).not.toBeNull()
    expect(health.lastFailureReason).not.toBeNull()
  })

  test("a successful refresh clears the failure streak", async () => {
    harness.queue = [
      () => Promise.resolve(mint("copilot_init", 1, 60_000)),
      () =>
        Promise.reject(
          new HTTPError("mint 502", new Response(null, { status: 502 })),
        ),
    ]

    await setupCopilotToken()
    await oneRefreshTick()
    stopCopilotRefreshLoop()
    expect(copilotRefreshHealth().consecutiveFailures).toBeGreaterThanOrEqual(1)

    setCopilotToken("copilot_fresh", Date.now() + 60_000)

    expect(copilotRefreshHealth().consecutiveFailures).toBe(0)
    expect(copilotRefreshHealth().lastSuccessAtMs).not.toBeNull()
  })
})

// --- B. the bearer is marked unhealthy once it is provably dead -------------

describe("#9 B — an expired bearer under a failing refresh is known dead", () => {
  test("the mint's expires_at is retained and drives the known-expired verdict", async () => {
    // Bearer dies in 800ms; the refresh due at ~1s fails. By the assertion the
    // proxy holds a credential upstream has already stopped accepting.
    harness.queue = [
      () => Promise.resolve(mint("copilot_init", 1, 800)),
      () =>
        Promise.reject(
          new HTTPError("mint 502", new Response(null, { status: 502 })),
        ),
    ]

    await setupCopilotToken()
    expect(state.copilotTokenExpiresAtMs).toBeDefined()
    expect(copilotTokenHealth()).not.toBe(CREDENTIAL_HEALTH.expired)

    await oneRefreshTick()
    stopCopilotRefreshLoop()

    expect(copilotTokenHealth()).toBe(CREDENTIAL_HEALTH.expired)
  })
})

// --- C. a known-dead credential is not put on the wire ----------------------

describe("#9 C — a known-dead bearer is not proxied", () => {
  test("requireCopilotToken throws CopilotTokenStaleError instead of returning it", async () => {
    harness.queue = [
      () => Promise.resolve(mint("copilot_init", 1, 800)),
      () =>
        Promise.reject(
          new HTTPError("mint 502", new Response(null, { status: 502 })),
        ),
    ]

    await setupCopilotToken()
    expect(requireCopilotToken()).toBe("copilot_init")

    await oneRefreshTick()
    stopCopilotRefreshLoop()

    expect(() => requireCopilotToken()).toThrow(CopilotTokenStaleError)
  })
})

// --- D. the failing-closed boundary ----------------------------------------
// Failing closed too eagerly would turn a recoverable blip into an outage, so
// each half of the conjunction is pinned on its own.

describe("#9 D — neither half of the verdict fails a request alone", () => {
  test("an expired bearer with a healthy refresh is still served", () => {
    setCopilotToken("copilot_live", Date.now() - 1000)

    expect(copilotTokenHealth()).toBe(CREDENTIAL_HEALTH.healthy)
    expect(requireCopilotToken()).toBe("copilot_live")
  })

  test("a failing refresh with an unexpired bearer is 'refreshing', and still served", async () => {
    harness.queue = [
      () => Promise.resolve(mint("copilot_init", 1, 600_000)),
      () =>
        Promise.reject(
          new HTTPError("mint 502", new Response(null, { status: 502 })),
        ),
    ]

    await setupCopilotToken()
    await oneRefreshTick()
    stopCopilotRefreshLoop()

    expect(copilotRefreshHealth().consecutiveFailures).toBeGreaterThanOrEqual(1)
    expect(copilotTokenHealth()).toBe(CREDENTIAL_HEALTH.refreshing)
    expect(requireCopilotToken()).toBe("copilot_init")
  })

  test("a gho_ bearer, which never expires and has no refresh loop, is never stale", async () => {
    state.githubToken = "gho_direct"

    await setupCopilotToken()

    expect(state.copilotTokenExpiresAtMs).toBeUndefined()
    expect(copilotTokenHealth()).not.toBe(CREDENTIAL_HEALTH.expired)
    expect(requireCopilotToken()).toBe("gho_direct")
  })
})

// --- E. expiry resolution is skew-tolerant ----------------------------------
describe("resolveCopilotExpiryMs", () => {
  const now = 1_700_000_000_000

  test("trusts a plausible absolute expires_at", () => {
    expect(resolveCopilotExpiryMs((now + 1_800_000) / 1000, 1500, now)).toBe(
      now + 1_800_000,
    )
  })

  test("falls back to refresh_in when expires_at is missing (schema default 0)", () => {
    expect(resolveCopilotExpiryMs(0, 1500, now)).toBe(now + 1_800_000)
  })

  test("falls back when a skewed clock puts expires_at in the past", () => {
    expect(resolveCopilotExpiryMs((now - 3_600_000) / 1000, 1500, now)).toBe(
      now + 1_800_000,
    )
  })

  test("falls back when expires_at implies an implausible lifetime", () => {
    const aWeekOut = (now + 7 * 24 * 60 * 60 * 1000) / 1000
    expect(resolveCopilotExpiryMs(aWeekOut, 1500, now)).toBe(now + 1_800_000)
  })
})

// --- F. what the client and the shell actually see --------------------------

describe("#9 — the stale verdict is legible to a client and to the shell", () => {
  test("forwardError answers 503 with a non-auth type, not a 401/403", async () => {
    const captured: { body: unknown; status: number } = {
      body: undefined,
      status: 0,
    }
    const ctx = {
      json(body: unknown, status?: number): Response {
        captured.body = body
        captured.status = status ?? 200
        return new Response(JSON.stringify(body), { status: status ?? 200 })
      },
      header(): void {
        /* unused on this branch */
      },
    }

    // casts-keep: forwardError needs only `json`/`header` off the Hono context;
    // constructing a real one would add a router for no extra coverage.
    await forwardError(
      ctx as unknown as Context,
      new CopilotTokenStaleError("dns-failure"),
    )

    expect(captured.status).toBe(503)
    const body = captured.body as { error: { message: string; type: string } }
    expect(body.error.type).toBe("upstream_credential_stale")
    // The whole point: the message must not send the user to a re-login.
    expect(body.error.message).toContain("dns-failure")
    expect(body.error.message).toContain("will not help")
  })

  test("GET /control/diagnostics reports the failing refresh", async () => {
    harness.queue = [
      () => Promise.resolve(mint("copilot_init", 1, 800)),
      () =>
        Promise.reject(
          new HTTPError("mint 502", new Response(null, { status: 502 })),
        ),
    ]

    await setupCopilotToken()
    await oneRefreshTick()
    stopCopilotRefreshLoop()

    const app = createControlRoutes({
      getRequestIp: () => "127.0.0.1",
      listClients: () => [],
    })
    const res = await app.request("/diagnostics")
    expect(res.status).toBe(200)

    const body = DiagnosticsResponse.parse(await res.json())
    expect(body.copilot_refresh?.health).toBe(CREDENTIAL_HEALTH.expired)
    expect(body.copilot_refresh?.consecutive_failures).toBeGreaterThanOrEqual(1)
    expect(body.copilot_refresh?.token_expires_at).not.toBeNull()
    expect(body.copilot_refresh?.last_failure_reason).not.toBeNull()
  })
})
