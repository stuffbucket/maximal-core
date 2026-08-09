/**
 * The proxy-enforced force-upgrade lever (maximal-core#7).
 *
 * The proxy impersonates upstream clients and there is no Dependabot on a
 * compiled binary, so retiring a vulnerable build has to be something the build
 * itself does. `min_supported_version` in the release manifest is that lever:
 * when the running build is strictly below the floor its channel declares, the
 * upstream-touching routes refuse with a legible force-upgrade error.
 *
 * WHAT THIS IS NOT. It is fail-open by mandate, so anyone who can stop the
 * process reaching `mxml.sh` — a firewall rule, a hosts entry, an offline
 * laptop — disables it, and anyone who can patch the binary was never in scope
 * anyway. It is a fleet-hygiene lever for the cooperative majority, not a
 * control that resists a local adversary. Availability of the local proxy is
 * worth more than the fraction of coverage a fail-closed design would add. For
 * the same reason there is an explicit opt-out (`config.enforceVersionFloor`,
 * default ON): a user who wants no outbound calls could already get that with a
 * firewall rule, so refusing them a config key would buy nothing but surprise.
 *
 * Where it applies: exactly the upstream-touching route set that
 * `requireGithubAuth` gates, registered immediately before it in `server.ts`.
 * Everything a blocked user needs in order to *understand and fix* the block is
 * exempt by construction — `/status`, `/`, `/setup-status`, `/_internal`, and
 * the whole control listener (`/control/*`, `/_debug/*`) are not in that set, so
 * sign-in, `update/status` and `app/upgrade` all keep working while the proxy
 * refuses traffic.
 */

import type { MiddlewareHandler } from "hono"

import { checkVersionFloor, DOWNLOAD_URL } from "~/lib/update/update-check"

/**
 * The machine-readable discriminant clients switch on. Sits in the same
 * `error.type` slot as `upstream_credential_stale` (`~/lib/errors/error`)
 * rather than a parallel vocabulary, and names subject + state the same way.
 */
export const BUILD_RETIRED_TYPE = "build_retired"

/**
 * Body for a refused request. The message follows the
 * `CopilotTokenStaleError` precedent: say what happened, then say explicitly
 * what will NOT help, so a client does not send the user down a retry or
 * re-login path that cannot possibly clear the condition.
 */
export function buildRetiredBody(
  current: string,
  minSupported: string,
): {
  error: {
    message: string
    type: string
    current_version: string
    min_supported_version: string
    upgrade_url: string
  }
} {
  return {
    error: {
      message:
        `This maximal build (${current}) has been retired: the minimum supported`
        + ` version is ${minSupported}. Proxy requests are refused until the`
        + " engine is updated — retrying, re-authenticating, or changing API"
        + ` keys will not help. Update from ${DOWNLOAD_URL} (or run`
        + " `maximal upgrade`).",
      type: BUILD_RETIRED_TYPE,
      current_version: current,
      min_supported_version: minSupported,
      upgrade_url: DOWNLOAD_URL,
    },
  }
}

/**
 * Gate for routes that forward to the GitHub Copilot upstream. Orthogonal to
 * {@link requireGithubAuth}: that one asks whether the proxy has a credential,
 * this one asks whether this build is still allowed to use it.
 *
 * 426 Upgrade Required, chosen against the alternatives:
 *
 *   - NOT 401/403. An auth-shaped status is exactly the #9 failure mode — every
 *     client tells the user to sign in again, the one remedy that cannot help.
 *   - NOT 5xx. `upstream_credential_stale` picked 503 *because* it self-heals
 *     and a retry serves; this condition never self-heals, so a retryable
 *     status would produce an infinite, useless retry loop.
 *   - 426 is terminal, is not auth-shaped, and names the remedy in the status
 *     line itself. (RFC 7231 §6.5.15 pairs 426 with an `Upgrade` header for
 *     *protocol* negotiation; there is no protocol token to offer here, so the
 *     remedy is carried in the body instead — which is what clients render.)
 */
export const requireSupportedBuild: MiddlewareHandler = async (c, next) => {
  const verdict = checkVersionFloor()
  if (!verdict.retired || verdict.minSupported === null) {
    return next()
  }
  return c.json(buildRetiredBody(verdict.current, verdict.minSupported), 426)
}
