import { afterEach, describe, expect, test } from "bun:test"

import { getRefreshDeadlineMs, getRefreshPollDelayMs } from "~/lib/auth/token"
import { CopilotAuthFatalError, HTTPError } from "~/lib/errors/error"
import { getCopilotToken } from "~/services/github/get-copilot-token"

describe("getCopilotToken", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const stubFetch = (response: Response) => {
    globalThis.fetch = (() =>
      Promise.resolve(response)) as unknown as typeof fetch
  }

  /** Mint against a 200 carrying `body`. */
  const mintWithBody = async (body: Record<string, unknown>) => {
    stubFetch(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    return getCopilotToken()
  }

  test("200 OK returns parsed JSON body", async () => {
    const payload = {
      expires_at: 1_700_000_000,
      refresh_in: 1500,
      token: "tok_abc",
    }
    stubFetch(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const result = await getCopilotToken()
    expect(result).toEqual(payload)
  })

  test("401 throws a friendly auth-fatal message, not the raw upstream body", async () => {
    // Raw gRPC-style body that we must NOT surface verbatim to the user.
    const body = "unauthorized: AuthenticateToken authentication failed"
    stubFetch(new Response(body, { status: 401 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CopilotAuthFatalError)
      const e = err as CopilotAuthFatalError
      expect(e.status).toBe(401)
      expect(e.message).not.toContain("AuthenticateToken")
      expect(e.message).toContain("expired or revoked")
      expect(e.message).toContain("gh auth login")
    }
  })

  test("401 still propagates the remediation URL from the upstream body", async () => {
    const body = JSON.stringify({
      message: "unauthorized: AuthenticateToken authentication failed",
      documentation_url: "https://github.com/settings/copilot",
    })
    stubFetch(new Response(body, { status: 401 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CopilotAuthFatalError)
      const e = err as CopilotAuthFatalError
      expect(e.message).not.toContain("AuthenticateToken")
      expect(e.remediationUrl).toBe("https://github.com/settings/copilot")
    }
  })

  test("403 throws a friendly no-access message and propagates the URL", async () => {
    const body =
      "Please accept the updated Copilot terms at https://github.com/site/terms"
    stubFetch(new Response(body, { status: 403 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(CopilotAuthFatalError)
      const e = err as CopilotAuthFatalError
      expect(e.status).toBe(403)
      expect(e.message).not.toContain("Copilot terms")
      expect(e.message).toContain("doesn't have access to GitHub Copilot")
      expect(e.remediationUrl).toBe("https://github.com/site/terms")
    }
  })

  test("500 throws HTTPError, not CopilotAuthFatalError", async () => {
    stubFetch(new Response("upstream boom", { status: 500 }))

    try {
      await getCopilotToken()
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError)
      expect(err).not.toBeInstanceOf(CopilotAuthFatalError)
      expect((err as HTTPError).response.status).toBe(500)
    }
  })

  test("network error (fetch rejects) propagates", async () => {
    const boom = new Error("ECONNREFUSED")
    globalThis.fetch = (() => Promise.reject(boom)) as unknown as typeof fetch

    let caught: unknown
    try {
      await getCopilotToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
  })

  /**
   * `/copilot_internal/v2/token` is an undocumented internal endpoint, and its
   * `refresh_in` drives the ONLY throttle on the background refresh loop:
   *
   *   getRefreshDeadlineMs(refresh_in) → refreshAtMs
   *   getRefreshPollDelayMs(refreshAtMs) → nextDelayMs
   *   if (nextDelayMs > 0) await delay(nextDelayMs)   // else: mint again NOW
   *
   * Every one of those guards is a `Math.max`/`Math.min` comparison, and NaN
   * loses every comparison it takes part in — `Math.max(NaN, MIN_REFRESH_DELAY_MS)`
   * is NaN, and `NaN > 0` is false. So a non-numeric `refresh_in` doesn't slow
   * the loop down, it removes the sleep altogether, and since each successful
   * mint recomputes the deadline from the same bad field it never self-corrects.
   *
   * This is the identical defect `get-device-code.ts` documents and coerces
   * against ("made `sleep(NaN)` spin"); the mint sibling still used a bare
   * `as GetCopilotTokenResponse` cast, so nothing checked the field was a number.
   */
  describe("refresh_in is coerced to a finite number", () => {
    // A 200 whose body simply doesn't carry the field — a field rename or drop
    // on an endpoint with no published contract.
    test("absent refresh_in does not reach the loop as NaN", async () => {
      const result = await mintWithBody({
        expires_at: 1_700_000_000,
        token: "tok_abc",
      })
      expect(Number.isFinite(result.refresh_in)).toBe(true)
    })

    // A 200 whose refresh_in is a string ("1500s", "unlimited") — the shape an
    // interception proxy or a serialization change produces.
    test("non-numeric refresh_in does not reach the loop as NaN", async () => {
      const result = await mintWithBody({
        expires_at: 1_700_000_000,
        refresh_in: "1500s",
        token: "tok_abc",
      })
      expect(Number.isFinite(result.refresh_in)).toBe(true)
    })

    // The consequence, spelled out against the real helpers: the loop must
    // still sleep between mints. A false here is an unthrottled request storm
    // against GitHub's token endpoint for as long as the process runs.
    test("the refresh loop still throttles after such a mint", async () => {
      const result = await mintWithBody({
        expires_at: 1_700_000_000,
        token: "tok_abc",
      })

      const nowMs = 1_000
      const refreshAtMs = getRefreshDeadlineMs(result.refresh_in, nowMs)
      const nextDelayMs = getRefreshPollDelayMs(refreshAtMs, nowMs)

      expect(nextDelayMs).toBeGreaterThan(0)
    })

    test("a well-formed refresh_in is passed through untouched", async () => {
      const result = await mintWithBody({
        expires_at: 1_700_000_000,
        refresh_in: 1500,
        token: "tok_abc",
      })
      expect(result.refresh_in).toBe(1500)
    })
  })

  /**
   * `token` fed `setCopilotToken` straight from the cast. A 200 without it set
   * the live bearer to `undefined`, and every subsequent upstream call sent
   * `Authorization: Bearer undefined` — a 401 storm that reads as "your GitHub
   * account was rejected" rather than "the mint response was malformed".
   */
  test("a 200 with no token fails the mint instead of arming an undefined bearer", async () => {
    stubFetch(
      new Response(JSON.stringify({ expires_at: 1, refresh_in: 1500 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    let caught: unknown
    try {
      await getCopilotToken()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
  })
})
