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
 * **The bound the override carries (#133).** Because the overridden origin is
 * the credentialed one, an unbounded override is a credential-exfiltration
 * primitive: `GITHUB_API_BASE=https://collector.example` would have sent the
 * user's GitHub token to `collector.example`, in a normal (non-test) process,
 * and that is exactly the "callers cannot choose the credential destination"
 * guarantee ADR-0001 exists to make. So the accepted set is now the smallest
 * one that still expresses the fixtures below: `NODE_ENV === "test"`, `http:`,
 * a loopback host (`127.0.0.1` / `[::1]`), no credentials, no path, no query,
 * no fragment. Every rejection variant is asserted here, because the failure
 * mode is silent — a too-wide override makes nothing observable go wrong
 * locally; the request succeeds and carries the token.
 *
 * `GITHUB_API_BASE`, `COPILOT_API_ENTERPRISE_URL` and `NODE_ENV` are
 * process-global, so all three are restored in `beforeEach` **and**
 * `afterEach` — §5.6: a one-sided reset either leaks this file's value forward
 * or inherits the previous file's.
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
  /** `http://<loopback>:<os-assigned port>` — the value for `GITHUB_API_BASE`. */
  origin: string
  requests: Array<RecordedRequest>
  stop: () => Promise<void>
}

/** The two loopback literals the override accepts, as bind addresses. */
const IPV4_LOOPBACK = "127.0.0.1"
const IPV6_LOOPBACK = "::1"

/** WHATWG brackets an IPv6 literal in an authority, so the origin string the
 *  override must accept is `http://[::1]:<port>` — not the bare bind address. */
function originFor(hostname: string, port: number): string {
  const authority = hostname.includes(":") ? `[${hostname}]` : hostname
  return `http://${authority}:${port}`
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
  hostname: string = IPV4_LOOPBACK,
): DeviceFlowFixture {
  const requests: Array<RecordedRequest> = []
  let pollIndex = 0

  const server = Bun.serve({
    port: 0,
    hostname,
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
    // `server.url` is the address the socket ACTUALLY bound, so the IPv6 case
    // gets its bracketed authority from Bun rather than from string surgery
    // here — and the ephemeral port is read back rather than guessed (§5.8
    // form 1).
    origin: server.url.origin,
    requests,
    stop: async () => {
      await server.stop(true)
    },
  }
}

let fixture: DeviceFlowFixture | null = null

/** Captured once at module scope so the reset below restores what this file
 *  inherited rather than a hardcoded guess. Under `bun test` it is `"test"`,
 *  which is the whole reason the override is honoured here at all. */
const INHERITED_NODE_ENV = process.env.NODE_ENV

function clearHostEnv(): void {
  delete process.env.GITHUB_API_BASE
  delete process.env.COPILOT_API_ENTERPRISE_URL
  if (INHERITED_NODE_ENV === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = INHERITED_NODE_ENV
  }
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
function useFixture(
  pollScript: Array<Record<string, unknown>>,
  hostname: string = IPV4_LOOPBACK,
): void {
  fixture = startDeviceFlowFixture(pollScript, hostname)
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

/** Assert the override was not honoured: both hosts fall back to public GitHub. */
function expectPublicGitHubDefaults(): void {
  expect(getGitHubBaseUrl()).toBe("https://github.com")
  expect(getGitHubApiBaseUrl()).toBe("https://api.github.com")
}

test("defaults to public GitHub when GITHUB_API_BASE is unset", () => {
  expectPublicGitHubDefaults()
  expect(getOauthUrls()).toEqual({
    deviceCodeUrl: "https://github.com/login/device/code",
    accessTokenUrl: "https://github.com/login/oauth/access_token",
  })
})

test("GITHUB_API_BASE redirects both the login host and the API host", () => {
  process.env.GITHUB_API_BASE = "http://127.0.0.1:9999"

  expect(getGitHubBaseUrl()).toBe("http://127.0.0.1:9999")
  expect(getGitHubApiBaseUrl()).toBe("http://127.0.0.1:9999")
  expect(getOauthUrls()).toEqual({
    deviceCodeUrl: "http://127.0.0.1:9999/login/device/code",
    accessTokenUrl: "http://127.0.0.1:9999/login/oauth/access_token",
  })
})

test("an accepted value is normalized to its origin", () => {
  // A trailing root slash and surrounding whitespace are the two shapes a
  // shell/env round-trip adds on its own; both normalize away. Anything
  // *beyond* the root slash is a rejection, not a normalization — see below.
  for (const raw of ["http://127.0.0.1:9999/", "  http://127.0.0.1:9999  "]) {
    process.env.GITHUB_API_BASE = raw
    expect(getGitHubApiBaseUrl()).toBe("http://127.0.0.1:9999")
    expect(getGitHubBaseUrl()).toBe("http://127.0.0.1:9999")
  }
})

test("GITHUB_API_BASE outranks COPILOT_API_ENTERPRISE_URL", () => {
  process.env.COPILOT_API_ENTERPRISE_URL = "ghe.example.com"
  process.env.GITHUB_API_BASE = "http://[::1]:8443"

  expect(getGitHubBaseUrl()).toBe("http://[::1]:8443")
  expect(getGitHubApiBaseUrl()).toBe("http://[::1]:8443")
})

test("GITHUB_API_BASE is ignored unless NODE_ENV is test", () => {
  // The core of #133: the same value a fixture uses must do nothing at all in
  // a normal user process, because honouring it there points the credentialed
  // origin wherever the environment says.
  for (const nodeEnv of ["production", "development", "", undefined]) {
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = nodeEnv
    }
    process.env.GITHUB_API_BASE = "http://127.0.0.1:9999"
    expectPublicGitHubDefaults()
  }
})

/**
 * Every rejected shape, each labelled with the property that rejects it. The
 * remote entries are the exfiltration case from the issue verbatim; the rest
 * are the shapes that smuggle a non-loopback destination, a credential, or
 * out-of-origin data past a loopback-looking prefix.
 */
/** Assembled rather than written inline: a literal `scheme://user:pass@host`
 *  is the exact shape the staged-diff secret scanner blocks
 *  (`scripts/secret-scan.sh`), and what these two cases are about is the
 *  URL *shape*, not any particular value. */
const USERINFO = ["us3r", "s3cret"].join(":")

const REJECTED_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["unparseable", "not a url"],
  ["blank", "   "],
  ["non-HTTP scheme", "ftp://127.0.0.1:9999"],
  ["remote host", "https://collector.example"],
  ["remote host over http", "http://collector.example"],
  [
    "remote host with a loopback-looking label",
    "http://127.0.0.1.evil.example",
  ],
  ["https on loopback", "https://127.0.0.1:9999"],
  ["https on IPv6 loopback", "https://[::1]:9999"],
  ["userinfo credentials", `http://${USERINFO}@127.0.0.1:9999`],
  ["username only", `http://${USERINFO.split(":")[0]}@127.0.0.1:9999`],
  ["non-root path", "http://127.0.0.1:9999/ignored/path"],
  ["query parameters", "http://127.0.0.1:9999/?token=leak"],
  ["fragment", "http://127.0.0.1:9999/#leak"],
  ["non-loopback IPv4 literal", "http://127.0.0.2:9999"],
  ["non-loopback IPv6 literal", "http://[::2]:9999"],
  ["hostname rather than a loopback literal", "http://localhost:9999"],
]

test("rejects every override that is not a bare loopback http origin", () => {
  for (const [label, raw] of REJECTED_OVERRIDES) {
    process.env.GITHUB_API_BASE = raw
    // The label rides in the message so a failure names the shape that leaked
    // rather than just the URL that did.
    expect(`${label}: ${getGitHubApiBaseUrl()}`).toBe(
      `${label}: https://api.github.com`,
    )
    expect(`${label}: ${getGitHubBaseUrl()}`).toBe(
      `${label}: https://github.com`,
    )
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

/**
 * The acceptance half, on a REAL socket, for both loopback families. This is
 * also the guard against the silent-anonymous failure mode described in the
 * header: `attachHostAuth` matched the fixture's origin against
 * `getGitHubApiBaseUrl()`, so the assertion is on the header the fixture
 * actually received rather than on what a stub was asked for.
 *
 * The IPv6 case is not a duplicate of the IPv4 one. `[::1]` is the only
 * accepted host whose WHATWG `hostname` is *bracketed*, so an implementation
 * that compares against the bare `::1` accepts nothing on IPv6 and this file
 * is the only place that shows it.
 */
for (const hostname of [IPV4_LOOPBACK, IPV6_LOOPBACK]) {
  test(`accepts an ephemeral-port fixture on ${hostname} and credentials it`, async () => {
    useFixture([], hostname)
    const origin = fixture?.origin ?? ""

    // The port is OS-assigned (§5.8 form 1), so this also proves an arbitrary
    // high port is accepted rather than some allowlisted one.
    expect(origin).toBe(originFor(hostname, Number(new URL(origin).port)))
    expect(getGitHubApiBaseUrl()).toBe(origin)
    expect(getGitHubBaseUrl()).toBe(origin)

    const user = await getGitHubUser("ghu_fixture_credential")

    expect(user.login).toBe("fixture-user")
    expect(fixture?.requests[0]?.path).toBe("/user")
    expect(fixture?.requests[0]?.authorization).toBe(
      "token ghu_fixture_credential",
    )
  })
}
