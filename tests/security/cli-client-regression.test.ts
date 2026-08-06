import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createOriginGuardMiddleware } from "~/lib/auth/origin-guard"

/**
 * CLI/plugin non-regression (ADR-0021 §6.6).
 *
 * Claude Code, opencode, and SDK clients are non-browser callers that send NO
 * `Origin` and hit `/v1/*` (+ the `api claude-code` key mint) with
 * `Authorization: Bearer <key>`. The Origin gate must let a missing-Origin
 * request through.
 *
 * This checks the middleware in isolation. The complementary property — that no
 * proxy route on the public listener falls under a guarded prefix in the first
 * place — is asserted against the real route table in `origin-guard.test.ts`.
 */

/** Mounts the Origin guard in front of a `/v1` route (a no-Origin surface). */
function mountWithGuard() {
  const app = new Hono()
  // The guard is mounted globally in server.ts; a no-Origin request must pass
  // straight through on non-guarded paths.
  app.use("*", createOriginGuardMiddleware({ boundPort: () => 4141 }))
  app.post("/v1/messages", (c) => c.json({ ok: true }))
  return app
}

describe("no-Origin Bearer client on /v1/* still succeeds", () => {
  test("a Bearer request with no Origin header reaches /v1/messages", async () => {
    const res = await mountWithGuard().request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer sk-test" }, // NOTE: no `origin` header
    })
    expect(res.status).toBe(200)
  })
})
