/**
 * `GITHUB_API_BASE` — the device-code flow driven against a REAL local server.
 *
 * **Why a server and not a `globalThis.fetch` stub.** A fetch stub proves the
 * state machine (that is `tests/poll-access-token.test.ts`'s job) but it cannot
 * prove the thing this override exists for: that the *URLs the flow builds*
 * actually resolve to the configured host, and that `send-request.ts` still
 * recognises that host as the GitHub API host. A stub answers any URL, so a
 * broken override would pass. Here the only way a request can be answered is by
 * arriving at the fixture's socket. Stubbing `globalThis.fetch` is also the
 * cross-file hazard `docs/dev/testing-strategy.md` §5.1 is about, so this file
 * installs no module mock and no global stub of any kind.
 *
 * **The credential trap this file is the guard for.** `attachHostAuth`
 * (`src/lib/http/send-request.ts`) attaches the GitHub token by comparing the
 * destination's *origin* against `getGitHubApiBaseUrl()`. Had the override been
 * plumbed anywhere other than that accessor, requests to the fixture would
 * silently lose their credential and every assertion below would still pass —
 * for the wrong reason. `"attaches the GitHub credential to the overridden API
 * host"` closes that hole by asserting on the header the fixture actually
 * received.
 *
 * **Wall time.** `pollAccessToken` sleeps for real (`deviceCode.interval + 1`
 * seconds, then the RFC 8628 `slow_down` bump), and that timing is part of what
 * is under test, so this file costs a few seconds by construction. The fixture
 * returns the smallest intervals the production code will accept — `interval: 0`
 * (→ 1 s) and a `slow_down` that names a fresh interval just above it, since the
 * fallback bump is a fixed +5 s. Each test carries an explicit generous timeout.
 *
 * `GITHUB_API_BASE` and `COPILOT_API_ENTERPRISE_URL` are process-global, so
 * both are cleared in `beforeEach` **and** `afterEach` — §5.6: a one-sided reset
 * either leaks this file's value forward or inherits the previous file's.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"

import type { DeviceCodeResponse } from "~/services/github/get-device-code"

import {
  getGitHubApiBaseUrl,
  getGitHubBaseUrl,
  getOauthUrls,
} from "~/lib/config/api-config"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

/** One request as the fixture saw it, so assertions can be made about what
 *  actually crossed the socket rather than about what a stub was asked for. */
interface RecordedRequest {
  method: string
  path: string
  authorization: string | null
  body: Record<string, unknown>
}

interface DeviceFlowFixture {
  /** `http://127.0.0.1:<os-assigned port>` — the value for `GITHUB_API_BASE`. */
  origin: string
  requests: Array<RecordedRequest>
  stop: () => Promise<void>
}

/** The device-code response the fixture hands out. `interval: 0` makes the
 *  poll loop's first sleep the 1 s minimum it clamps to (`interval + 1`). */
const DEVICE_CODE_RESPONSE = {
  device_code: "fixture-device-code",
  user_code: "FIXT-URE1",
  verification_uri: "https://fixture.invalid/login/device",
  expires_in: 900,
  interval: 0,
} as const

/**
 * A local stand-in for github.com's device-flow endpoints, bound on an
 * OS-assigned port (`port: 0`, then read `server.port` back — form 1 in
 * `docs/dev/testing-strategy.md` §5.8: the socket never leaves this process, so
 * there is no window for anything else to take it).
 *
 * `pollScript` is consumed one entry per `/login/oauth/access_token` hit; the
 * last entry repeats if the loop asks again, so an over-polling regression
 * cannot turn into an out-of-range crash that masks the real failure.
 */
function startDeviceFlowFixture(
  pollScript: Array<Record<string, unknown>>,
): DeviceFlowFixture {
  const requests: Array<RecordedRequest> = []
  let pollIndex = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const { pathname } = new URL(request.url)
      let body: Record<string, unknown> = {}
      if (request.method === "POST") {
        // Narrowed rather than cast: the fixture must record what actually
        // arrived, and a cast would let a non-object body through as one.
        const parsed: unknown = await request
          .json()
          .then((value: unknown) => value)
          .catch(() => null)
        if (typeof parsed === "object" && parsed !== null) {
          body = { ...parsed }
        }
      }
      requests.push({
        method: request.method,
        path: pathname,
        authorization: request.headers.get("authorization"),
        body,
      })

      if (pathname === "/login/device/code") {
        return Response.json(DEVICE_CODE_RESPONSE)
      }
      if (pathname === "/login/oauth/access_token") {
        const entry =
          pollScript[Math.min(pollIndex, pollScript.length - 1)] ?? {}
        pollIndex++
        // GitHub reports device-flow status with HTTP 200 and an `error` field
        // in the body, not a non-2xx status. Mirror that.
        return Response.json(entry)
      }
      if (pathname === "/user") {
        return Response.json({ login: "fixture-user" })
      }
      return new Response("not found", { status: 404 })
    },
  })

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: async () => {
      await server.stop(true)
    },
  }
}

let fixture: DeviceFlowFixture | null = null

function clearHostEnv(): void {
  delete process.env.GITHUB_API_BASE
  delete process.env.COPILOT_API_ENTERPRISE_URL
}

beforeEach(clearHostEnv)

afterEach(async () => {
  clearHostEnv()
  // Detach before awaiting: an `await` between the read and the write is the
  // interleaving `require-atomic-updates` exists to catch.
  const running = fixture
  fixture = null
  await running?.stop()
})

/** Start the fixture and point the auth path at it. */
function useFixture(pollScript: Array<Record<string, unknown>>): void {
  fixture = startDeviceFlowFixture(pollScript)
  process.env.GITHUB_API_BASE = fixture.origin
}

/** The message `pollAccessToken` rejected with. Deliberately not
 *  `.rejects.toThrow`: bun:test types that chain as `void`, which trips this
 *  repo's `await-thenable` / `no-confusing-void-expression` lint. */
async function pollRejectionMessage(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  try {
    await pollAccessToken(deviceCode)
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught)
  }
  throw new Error("expected pollAccessToken to reject, but it resolved")
}

test("defaults to public GitHub when GITHUB_API_BASE is unset", () => {
  expect(getGitHubBaseUrl()).toBe("https://github.com")
  expect(getGitHubApiBaseUrl()).toBe("https://api.github.com")
  expect(getOauthUrls()).toEqual({
    deviceCodeUrl: "https://github.com/login/device/code",
    accessTokenUrl: "https://github.com/login/oauth/access_token",
  })
})

test("GITHUB_API_BASE redirects both the login host and the API host", () => {
  process.env.GITHUB_API_BASE = "http://127.0.0.1:9999/ignored/path"

  expect(getGitHubBaseUrl()).toBe("http://127.0.0.1:9999")
  expect(getGitHubApiBaseUrl()).toBe("http://127.0.0.1:9999")
  expect(getOauthUrls()).toEqual({
    deviceCodeUrl: "http://127.0.0.1:9999/login/device/code",
    accessTokenUrl: "http://127.0.0.1:9999/login/oauth/access_token",
  })
})

test("GITHUB_API_BASE outranks COPILOT_API_ENTERPRISE_URL", () => {
  process.env.COPILOT_API_ENTERPRISE_URL = "ghe.example.com"
  process.env.GITHUB_API_BASE = "https://fixture.example:8443"

  expect(getGitHubBaseUrl()).toBe("https://fixture.example:8443")
  expect(getGitHubApiBaseUrl()).toBe("https://fixture.example:8443")
})

test("an unparseable or non-HTTP GITHUB_API_BASE falls back to the defaults", () => {
  for (const bad of ["not a url", "ftp://example.com", "   "]) {
    process.env.GITHUB_API_BASE = bad
    expect(getGitHubBaseUrl()).toBe("https://github.com")
    expect(getGitHubApiBaseUrl()).toBe("https://api.github.com")
  }
})

test("device_code and user_code come from the overridden host", async () => {
  useFixture([{ access_token: "gho_unused" }])

  const deviceCode = await getDeviceCode()

  expect(deviceCode.device_code).toBe(DEVICE_CODE_RESPONSE.device_code)
  expect(deviceCode.user_code).toBe(DEVICE_CODE_RESPONSE.user_code)
  expect(fixture?.requests.map((r) => r.path)).toEqual(["/login/device/code"])
  expect(fixture?.requests[0]?.body).toHaveProperty("client_id")
  expect(fixture?.requests[0]?.body).toHaveProperty("scope", "read:user")
})

test("polls the overridden host through authorization_pending → slow_down → access_token", async () => {
  useFixture([
    { error: "authorization_pending" },
    // Naming an interval above the current one keeps the RFC-mandated bump
    // small; without it the loop falls back to a fixed +5 s.
    { error: "slow_down", interval: 1.05 },
    {
      access_token: "gho_fixture_token",
      token_type: "bearer",
      scope: "read:user",
    },
  ])

  const deviceCode = await getDeviceCode()
  const result = await pollAccessToken(deviceCode)

  expect(result.accessToken).toBe("gho_fixture_token")
  expect(result.refreshToken).toBeNull()

  const paths = fixture?.requests.map((r) => r.path) ?? []
  expect(paths).toEqual([
    "/login/device/code",
    "/login/oauth/access_token",
    "/login/oauth/access_token",
    "/login/oauth/access_token",
  ])
  // Every poll must carry the fixture's own device_code, i.e. the whole flow
  // stayed on the overridden host rather than half of it reaching github.com.
  for (const recorded of fixture?.requests.slice(1) ?? []) {
    expect(recorded.body).toMatchObject({
      device_code: DEVICE_CODE_RESPONSE.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  }
}, 20_000)

test("surfaces access_denied from the overridden host", async () => {
  useFixture([{ error: "access_denied" }])

  const deviceCode = await getDeviceCode()

  expect(await pollRejectionMessage(deviceCode)).toBe(
    "Authorization denied by the user.",
  )
}, 20_000)

test("surfaces expired_token from the overridden host", async () => {
  useFixture([{ error: "expired_token" }])

  const deviceCode = await getDeviceCode()

  expect(await pollRejectionMessage(deviceCode)).toBe(
    "Device code expired before authorization. Re-run setup.",
  )
}, 20_000)

test("attaches the GitHub credential to the overridden API host", async () => {
  useFixture([])

  const user = await getGitHubUser("ghu_fixture_credential")

  expect(user.login).toBe("fixture-user")
  // The guard against the silent-anonymous failure mode described in the header:
  // `attachHostAuth` matched the fixture's origin against getGitHubApiBaseUrl().
  expect(fixture?.requests[0]?.path).toBe("/user")
  expect(fixture?.requests[0]?.authorization).toBe(
    "token ghu_fixture_credential",
  )
})
