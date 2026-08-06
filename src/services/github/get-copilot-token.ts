import consola from "consola"
import { z } from "zod"

import { getCopilotTokenUrl, githubHeaders } from "~/lib/config/api-config"
import { parseCopilotErrorBody } from "~/lib/errors/copilot-error-parser"
import { CopilotAuthFatalError, HTTPError } from "~/lib/errors/error"
import { COPILOT_TOKEN_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequest } from "~/lib/http/send-request"
import { state } from "~/lib/runtime-state/state"

/**
 * Observed production cadence of `/copilot_internal/v2/token` (~25 min against
 * a ~30 min token), and the value `EARLY_REFRESH_BUFFER_MS` in `token.ts` is
 * tuned around. Used only when the response doesn't carry a usable number.
 */
const DEFAULT_REFRESH_IN_SECONDS = 1500

/**
 * The Copilot token mint response, validated at the boundary.
 *
 * `refresh_in` is load-bearing: it is the ONLY throttle on the background
 * refresh loop. That loop's guards are `Math.max` / `Math.min` comparisons and
 * a `nextDelayMs > 0` test — and NaN loses every one of them, so a non-numeric
 * `refresh_in` does not slow the loop down, it deletes the sleep. Each mint
 * recomputes the deadline from the same field, so it never self-corrects: the
 * result is an unthrottled mint loop against GitHub for the life of the
 * process. This is the same defect `get-device-code.ts` documents and coerces
 * against; a bare `as` cast left this sibling — the one driving a long-lived
 * loop — unchecked. Coerced with `.catch()` so any non-finite input (missing,
 * null, NaN, wrong type) becomes a usable number.
 *
 * `token` is required and NOT defaulted: without it the mint has failed, and
 * failing loudly here beats arming the live bearer with `undefined` and turning
 * every subsequent upstream call into a 401 that reads like a rejected account.
 *
 * Everything else is passed through — `.loose()` on both levels, because this
 * endpoint is undocumented and adding a field must never break a mint.
 */
const CopilotTokenResponseSchema = z
  .object({
    expires_at: z.number().catch(0),
    refresh_in: z.number().nonnegative().catch(DEFAULT_REFRESH_IN_SECONDS),
    token: z.string(),
    // The authoritative completion host for THIS token. GitHub can migrate an
    // account between hosts (e.g. individual → enterprise on a plan/billing
    // change); the bearer minted here is only valid against its own
    // `endpoints.api`, and POSTing it elsewhere is rejected with 421
    // Misdirected Request. We re-read this on every mint/refresh so the host
    // self-heals — and tolerate its absence, since callers already treat a
    // missing host as "keep the current one".
    endpoints: z
      .object({ api: z.string().optional() })
      .loose()
      .optional()
      .catch(undefined),
  })
  .loose()

export const getCopilotToken = async () => {
  const response = await sendRequest(getCopilotTokenUrl(), {
    headers: githubHeaders(),
    timeoutMs: COPILOT_TOKEN_TIMEOUT_MS,
  })

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error("Failed to get Copilot token response body", errorText)

    // /copilot_internal/v2/token never returns "your model isn't allowed"
    // — every 401/403 from this endpoint means the underlying GitHub
    // identity can no longer mint a Copilot token. Apply the strict
    // (legacy) policy: any 401/403 is auth-fatal, regardless of body
    // markers. Other endpoints (completion services) use the shared
    // body-marker discriminator via isAuthFatal().
    if (response.status === 401 || response.status === 403) {
      // The raw upstream body (a gRPC string like "unauthorized:
      // AuthenticateToken authentication failed") is already logged above
      // and is unreadable in the UI. Map to a friendly, actionable message
      // by status — mirroring the wording in preflightCopilotError. The raw
      // remediationUrl still flows through to power the UI's remediation link.
      const parsed = parseCopilotErrorBody(errorText)
      const who = state.userName ?? "your account"
      const friendlyMessage =
        response.status === 401 ?
          `GitHub rejected ${who}'s token — it may be expired or revoked. Run \`gh auth login\` and try again, or sign in with a code.`
        : `${who} doesn't have access to GitHub Copilot. Pick another account with an active Copilot subscription, or sign in with a code.`
      throw new CopilotAuthFatalError(
        friendlyMessage,
        response.status,
        parsed.remediationUrl,
      )
    }

    throw new HTTPError("Failed to get Copilot token", response)
  }

  return CopilotTokenResponseSchema.parse(await response.json())
}
