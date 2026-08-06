/**
 * `setupGitHubToken`'s `HTTPError` branch exists to log what GitHub actually
 * said before rethrowing the typed error. It read the body with
 * `await error.response.json()` — inside the catch, as the argument to the log
 * call — so a non-JSON error body threw `SyntaxError` *while building the
 * diagnostic*. The log never ran and the `SyntaxError` replaced the `HTTPError`
 * on the way out, losing both the message and the status every caller
 * discriminates on.
 *
 * A non-JSON body from `github.com/login/device/code` is ordinary: a 502/503
 * from GitHub's edge is HTML, and a corporate proxy or captive portal
 * intercepting the request returns an HTML block page. `forwardError` already
 * reads this boundary the right way (`text()`, then `JSON.parse` in a `try`);
 * this pins the same behaviour here.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { setupGitHubToken } from "~/lib/auth/token"
import { HTTPError } from "~/lib/errors/error"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function respondWith(body: string, contentType: string): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, {
        status: 502,
        headers: { "content-type": contentType },
      }),
    )) as unknown as typeof fetch
}

describe("setupGitHubToken on a non-JSON device-code failure", () => {
  test("rethrows the HTTPError rather than a SyntaxError from the log line", async () => {
    respondWith(
      "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
      "text/html",
    )

    const error = await setupGitHubToken({ force: true }).then(
      () => new Error("expected setupGitHubToken to reject"),
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).message).toBe("Failed to get device code")
    expect((error as HTTPError).response.status).toBe(502)
  })

  test("an empty error body is still an HTTPError", async () => {
    respondWith("", "text/plain")

    const error = await setupGitHubToken({ force: true }).then(
      () => new Error("expected setupGitHubToken to reject"),
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(HTTPError)
  })
})
