/**
 * Typed value space for the auth/account domain (boundary D1).
 *
 * These types close the value space so invalid auth/account values are
 * unrepresentable rather than caught at runtime:
 *   - `AccountType` is a closed enum, not a free string interpolated into a
 *     hostname (a typo like "enterpise" can no longer silently produce
 *     `https://api.enterpise.githubcopilot.com`).
 *   - `CopilotHost` is a branded, validated https origin — the only way to
 *     obtain one is through `toCopilotHost`/`hostForAccountType`, so a raw
 *     unvalidated string can't reach the completion-host slot.
 *
 * Forward note: `AccountType` already gates the host fallback (see
 * `hostForAccountType`) and `CopilotHost` brands `state.copilotApiUrl`. A
 * later phase folds them into the `signed-in` variant of the auth-controller's
 * `AuthState` union (`plan: AccountType`, `host: CopilotHost`); they live here
 * so that phase shares this source of truth rather than redefining them.
 */
import { z } from "zod"

export const ACCOUNT_TYPES = ["individual", "business", "enterprise"] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const accountTypeSchema = z.enum(ACCOUNT_TYPES)

/** Parse an external string (CLI flag, env) into an AccountType, or throw a
 *  clear message naming the valid values. Fail closed — a bad value must not
 *  fall through to a constructed-but-wrong host. */
export function parseAccountType(input: string): AccountType {
  const result = accountTypeSchema.safeParse(input)
  if (!result.success) {
    throw new Error(
      `Invalid account type "${input}". Must be one of: ${ACCOUNT_TYPES.join(", ")}.`,
    )
  }
  return result.data
}

/**
 * Health of a credential, as a closed vocabulary.
 *
 * These names are #15's `AccountHealth` (`'healthy' | 'refreshing' |
 * 'needsReauth' | 'expired' | 'unknown'`), adopted here rather than coined
 * afresh so the #9 fix does not have to be renamed when the transactional
 * multi-account work lands. #9 derives only the subset it can observe from the
 * Copilot refresh loop:
 *
 *  - `healthy`    — last mint/refresh succeeded.
 *  - `refreshing` — a refresh is failing but the bearer we hold is still within
 *                   its own lifetime. This is exactly the intermediate state #9
 *                   reports as missing: recoverable, requests keep flowing.
 *  - `expired`    — the bearer is past the expiry UPSTREAM gave us and the
 *                   refresh that should have replaced it is failing.
 *  - `unknown`    — no bearer, or one with no expiry (a `gho_` token used
 *                   directly, which has no refresh loop).
 *
 * `needsReauth` is deliberately NOT derived here. Per #15 ("offline/upstream
 * failures must never mark credentials invalid"), only an auth-fatal rejection
 * may claim a credential is bad, and that verdict already has an owner:
 * `markAuthDegraded` writing `needsReauth` onto the account record. A transport
 * failure must never be able to produce it. `expired` makes no such claim — it
 * is the credential's own stated lifetime having elapsed, which is a fact about
 * the token, not an inference from the network error.
 */
export const CREDENTIAL_HEALTH = {
  healthy: "healthy",
  refreshing: "refreshing",
  needsReauth: "needsReauth",
  expired: "expired",
  unknown: "unknown",
} as const

export type CredentialHealth =
  (typeof CREDENTIAL_HEALTH)[keyof typeof CREDENTIAL_HEALTH]

/** The subset of {@link CREDENTIAL_HEALTH} the Copilot refresh loop can
 *  observe on its own — everything except `needsReauth`, which only an
 *  auth-fatal rejection may set (see the note above). */
export type CopilotTokenHealth = Exclude<CredentialHealth, "needsReauth">

declare const copilotHostBrand: unique symbol
/** A validated https Copilot API origin (scheme + host, no path/trailing
 *  slash). Construct only via `toCopilotHost` or `hostForAccountType`. */
export type CopilotHost = string & { readonly [copilotHostBrand]: true }

/** Validate + normalize a URL into a CopilotHost, or `null` if it isn't a
 *  well-formed https URL. Normalizes to the origin so trailing slashes /
 *  stray paths can't produce two "different" hosts for the same server. */
export function toCopilotHost(url: string): CopilotHost | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  return parsed.origin as CopilotHost
}

/**
 * The default completion host for an account type, used only before
 * discovery (`/copilot_internal/v2/token`'s `endpoints.api`) populates the
 * authoritative host. `individual` is served from the apex host —
 * `api.individual.githubcopilot.com` returns 421 Misdirected, so the apex is
 * correct there; business/enterprise get a subdomain. Built from the closed
 * enum, so the result is always a valid host.
 */
export function hostForAccountType(accountType: AccountType): CopilotHost {
  const url =
    accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`
  return url as CopilotHost
}
