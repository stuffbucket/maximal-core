import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { getConfig, writeConfig } from "~/lib/config/config"
import { setModels, state } from "~/lib/runtime-state/state"
import { publicApp } from "~/server"

/**
 * `decideAuth`'s shell-key arm (`src/lib/auth/request-auth.ts`), the first and
 * highest-priority rule in the documented decision order
 * (`docs/spec/wire/auth-transport-wire-prd.md` -> _The decision_; ADR-0021).
 *
 * A request whose key equals `state.shellApiKey` (`MAXIMAL_SHELL_KEY`, injected
 * by the desktop shell at sidecar spawn) is allowed **regardless of the enforce
 * flag** and without appearing in any configured allow list. It is the one
 * credential that outranks "Block unknown connections", so it is also the one
 * comparison where a widened match is a total authentication bypass rather than
 * a scoped one.
 *
 * Nothing exercised it. The mutation sweep recorded in
 * `docs/dev/testing-strategy.md` §6 found every mutant in `isShellKey` alive,
 * because no test ever set `state.shellApiKey` — with it `undefined`, the
 * function returns `false` for every input and every rewrite of it returns
 * `false` too. `tests/token-route-loopback.test.ts` does set it, but asserts a
 * 404 that a rejected request would also produce, so it observes nothing here
 * either.
 *
 * These drive the real `publicApp` — the real `applyCommonMiddleware` stack and
 * the real `createAuthMiddleware` with no injected `isEnforcing` or
 * `getApiKeys`, so the resolvers that run in production are the ones under test.
 */

/** Matches API_KEY_VALUE_PATTERN so `writeConfig` accepts it. */
const CONFIGURED_KEY = "configured-key-shell-arm"
/** Deliberately NOT in the config: the shell key's whole point is that it needn't be. */
const SHELL_KEY = "shell-key-shell-arm"
/** Neither the shell key nor a configured one — an attacker's guess. */
const FOREIGN_KEY = "foreign-key-shell-arm"

const SEEDED_MODEL_ID = "seeded-model-shell-arm"

const prior = {
  config: getConfig(),
  githubToken: state.githubToken,
  models: state.models,
  shellApiKey: state.shellApiKey,
}

beforeAll(() => {
  // Enforcement ON, or the shell key proves nothing: with `enforce` false the
  // middleware allows every request anyway and the 200s below would be vacuous.
  writeConfig({
    ...prior.config,
    auth: { ...prior.config.auth, enforce: true, apiKeys: [CONFIGURED_KEY] },
  })
  // `/v1/*` also sits behind `requireGithubAuth`, and the handler needs a
  // primed catalog or it reaches for the network.
  state.githubToken = "gh-token-for-shell-arm"
  setModels({
    object: "list",
    data: [{ id: SEEDED_MODEL_ID }],
  } as unknown as ModelsResponse)
})

afterEach(() => {
  state.shellApiKey = prior.shellApiKey
})

afterAll(() => {
  writeConfig(prior.config)
  state.githubToken = prior.githubToken
  state.models = prior.models
  state.shellApiKey = prior.shellApiKey
})

describe("MAXIMAL_SHELL_KEY outranks the enforce flag (real server)", () => {
  test("the exact shell key is accepted though it is in no allow list", async () => {
    // The request: `GET /v1/models` with `x-api-key: <MAXIMAL_SHELL_KEY>` while
    // `auth.enforce` is true and the key list holds only CONFIGURED_KEY. This is
    // the desktop shell's webview talking to its own sidecar after the user has
    // turned on "Block unknown connections".
    // Deleting or short-circuiting the shell arm locks that shell out of its own
    // backend with a 401 and no way to recover from the UI.
    state.shellApiKey = SHELL_KEY

    const res = await publicApp.request("/v1/models", {
      headers: { "x-api-key": SHELL_KEY },
    })

    expect(res.status).toBe(200)
    // The seeded id proves the real handler ran rather than some middleware
    // happening to 200.
    expect(await res.text()).toContain(SEEDED_MODEL_ID)
  })

  test("a key that is not the shell key is still rejected", async () => {
    // The request: the same `GET /v1/models`, `x-api-key: <anything else>`, with
    // a shell key configured. The value is entirely attacker-chosen.
    // This is the bypass direction. `requestApiKey === state.shellApiKey`
    // flipped to `!==`, or the conjunction relaxed to `||`, makes every key that
    // is *not* the shell key satisfy the shell arm — i.e. any request bearing
    // any credential is allowed, enforce flag and allow list ignored. The test
    // above cannot see that: it passes harder under the mutation.
    state.shellApiKey = SHELL_KEY

    const res = await publicApp.request("/v1/models", {
      headers: { "x-api-key": FOREIGN_KEY },
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe("authentication_error")
  })

  test("with no shell key set, the same value is rejected", async () => {
    // Vacuity guard for the first test: proves its 200 is attributable to
    // `state.shellApiKey` and not to SHELL_KEY passing for some other reason
    // (enforcement silently off, `/v1/models` unauthenticated, a stale config).
    // Same request, byte for byte; only the runtime state differs.
    state.shellApiKey = undefined

    const res = await publicApp.request("/v1/models", {
      headers: { "x-api-key": SHELL_KEY },
    })

    expect(res.status).toBe(401)
  })
})
