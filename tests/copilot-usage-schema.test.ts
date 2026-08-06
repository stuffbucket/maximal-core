import { afterEach, describe, expect, test } from "bun:test"

import { preflightCopilotError } from "~/lib/auth/copilot-preflight"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

/**
 * Regression guard for the Copilot-usage boundary. `/copilot_internal/user` is an
 * undocumented internal endpoint whose payload varies by account type, and GitHub
 * has already retired a quota key (#311). The validated boundary MUST stay lenient
 * — a valid-but-lean response (missing `quota_snapshots`, a null snapshots map, a
 * snapshot missing `chat`/`completions`, or absent metadata fields) must parse,
 * not throw, or it breaks the very usage view the validation protects.
 */
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function respondWith(body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch
}

const QUOTA = {
  entitlement: 300,
  overage_count: 0,
  overage_permitted: false,
  percent_remaining: 62,
  quota_id: "premium",
  quota_remaining: 186,
  remaining: 186,
  unlimited: false,
}

describe("getCopilotUsage boundary tolerates valid-but-lean responses", () => {
  test("a response with no quota_snapshots does not throw", async () => {
    respondWith({ login: "octocat", copilot_plan: "individual" })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots).toBeUndefined()
  })

  test("quota_snapshots: null does not throw", async () => {
    respondWith({ quota_snapshots: null })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots).toBeNull()
  })

  test("a snapshot missing chat/completions parses; unknown keys pass through", async () => {
    respondWith({
      quota_snapshots: {
        premium_interactions: QUOTA,
        some_future_quota: { unlimited: true },
      },
    })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots?.completions).toBeUndefined()
    expect(usage.quota_snapshots?.premium_interactions?.remaining).toBe(186)
  })

  test("omitting the previously-required metadata fields does not throw", async () => {
    respondWith({ login: "u", quota_snapshots: {} })
    const usage = await getCopilotUsage("tok")
    expect(usage).toBeDefined()
  })

  // The leniency above stopped at the snapshot's own fields: every one of the
  // eight was required, so a NAMED snapshot missing any of them threw where the
  // same shape under an unknown key (covered above) passed. GitHub varies this
  // payload per plan — `unlimited: true` accounts have no numeric entitlement to
  // report — so the inner object needs the same treatment as the outer one.
  test("a named snapshot missing fields parses", async () => {
    respondWith({ quota_snapshots: { chat: { unlimited: true } } })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots?.chat?.unlimited).toBe(true)
    expect(usage.quota_snapshots?.chat?.entitlement).toBeUndefined()
  })

  test("a partially-populated snapshot keeps the fields it did send", async () => {
    respondWith({
      quota_snapshots: { completions: { remaining: 12, unlimited: false } },
    })
    const usage = await getCopilotUsage("tok")
    expect(usage.quota_snapshots?.completions?.remaining).toBe(12)
  })
})

/**
 * The schema's strictness was not confined to the usage view: `/copilot_internal/user`
 * is also the entitlement probe both account-adopt paths run before switching to a
 * token. A `ZodError` is not an `HTTPError`, so it fell to the catch-all branch and
 * told an ENTITLED user to "check your connection" — for an account that had just
 * answered 200.
 */
describe("preflightCopilotError on a lean-but-entitled response", () => {
  test("accepts the account rather than blaming the network", async () => {
    respondWith({
      login: "octocat",
      copilot_plan: "business",
      quota_snapshots: { chat: { unlimited: true } },
    })
    expect(await preflightCopilotError("tok", "octocat")).toBeNull()
  })
})
