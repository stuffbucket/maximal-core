import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { getConfig, writeConfig } from "~/lib/config/config"
import { setModels, state } from "~/lib/runtime-state/state"
import {
  __resetUpdateCheckDepsForTests,
  __setUpdateCheckDepsForTests,
} from "~/lib/update/update-check"
import { publicApp } from "~/server"

/**
 * CLI/plugin non-regression (ADR-0021 §6.6).
 *
 * Claude Code, opencode, and SDK clients are non-browser callers that send NO
 * `Origin` and hit `/v1/*` with `Authorization: Bearer <key>`. The Origin gate
 * must let a missing-Origin request through, and the auth middleware behind it
 * must accept the Bearer key.
 *
 * This drives the real `publicApp` — the whole `applyCommonMiddleware` stack,
 * the real route table. The version it replaced built its own Hono app and
 * mounted only the Origin guard, so its `Bearer` header was inert and no change
 * to `src/server.ts` or `request-auth.ts` could fail it, while ADR-0021 credited
 * it with the end-to-end claim.
 */

/** Matches API_KEY_VALUE_PATTERN so `writeConfig` accepts it. */
const KEY = "cli-regression-key-0021"

/** Seeded through `setModels` so the catalog is both non-empty and freshly
 *  stamped: the handler's on-demand prime and `staleRefreshMiddleware`'s
 *  never-primed prime both decline, so no request here touches the network. */
const SEEDED_MODEL_ID = "seeded-model-0021"

const prior = {
  config: getConfig(),
  githubToken: state.githubToken,
  models: state.models,
}

beforeAll(() => {
  // Enforcement ON, or the credential is decorative: the middleware allows every
  // request when `auth.enforce` is false and only uses the key for attribution.
  writeConfig({
    ...prior.config,
    auth: { ...prior.config.auth, enforce: true, apiKeys: [KEY] },
  })
  // `/v1/*` also sits behind `requireGithubAuth`, which 401s when the proxy has
  // no upstream token of its own.
  state.githubToken = "gh-token-for-cli-regression"
  setModels({
    object: "list",
    data: [{ id: SEEDED_MODEL_ID }],
  } as unknown as ModelsResponse)
})

afterAll(() => {
  writeConfig(prior.config)
  state.githubToken = prior.githubToken
  state.models = prior.models
})

// `/v1/*` also passes through `requireSupportedBuild` (maximal-core#7), whose
// synchronous cache read kicks a fire-and-forget manifest refresh when the
// cache is cold — the real fetch would hit the public CDN. Pin the seam the
// update-check suite owns so this file stays offline, exactly as
// tests/live/control-route.test.ts does. An unknown floor fails open, so the
// gate is transparent here.
beforeEach(() => {
  __resetUpdateCheckDepsForTests()
  __setUpdateCheckDepsForTests({
    fetch: () => Promise.reject(new Error("offline (cli-client-regression)")),
  })
})
afterEach(() => {
  __resetUpdateCheckDepsForTests()
})

describe("no-Origin Bearer client on /v1/* still succeeds (real server)", () => {
  test("a Bearer request with no Origin reaches the real /v1/models handler", async () => {
    const res = await publicApp.request("/v1/models", {
      headers: { authorization: `Bearer ${KEY}` }, // NOTE: no `origin` header
    })

    expect(res.status).toBe(200)
    // The seeded id proves the real handler ran, not that some middleware
    // happened to 200. A 403 `csrf_error` here means the Origin guard grew to
    // cover `/v1`; a 401 means auth rejected the Bearer key.
    expect(await res.text()).toContain(SEEDED_MODEL_ID)
  })

  test("the same request without a credential 401s — auth is really in the stack", async () => {
    // Guards the test above against vacuity. If `createAuthMiddleware` were
    // unmounted, dropped from the `/v1` path, or its enforcement inverted, the
    // 200 above would still pass while asserting nothing about credentials.
    const res = await publicApp.request("/v1/models")

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe("authentication_error")
  })

  test("on a guarded path the Origin guard 403s ahead of auth, credential or not", async () => {
    // Pins the mount ORDER that `server.ts` calls out: the guard runs before
    // auth so a cross-origin browser request is refused regardless of any key.
    // Swap the two `app.use` calls and this returns 401 instead.
    const res = await publicApp.request("/_internal/shutdown", {
      method: "POST",
      headers: { origin: "https://evil.example" }, // no credential
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe("csrf_error")
  })

  test("a missing Origin passes the guard even on a guarded path", async () => {
    // The §6.6 invariant at its widest: `Origin` is a Forbidden header, so its
    // absence means a non-browser caller and the guard must not fire. Same path
    // as above, no `Origin` — whatever refuses this, it is not the CSRF gate.
    // Flip `isAllowedOrigin`'s `origin === null` arm and this returns 403.
    const res = await publicApp.request("/_internal/shutdown", {
      method: "POST",
    })

    const body = (await res.json().catch(() => ({}))) as {
      error?: { type?: string }
    }
    expect(body.error?.type).not.toBe("csrf_error")
    expect(res.status).not.toBe(403)
  })
})
