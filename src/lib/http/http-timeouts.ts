/**
 * Request timeouts for the GitHub / Copilot auth + discovery fetches.
 *
 * Production runs on Bun, whose `fetch` has NO default timeout. None of these
 * calls used to set one, so a half-open connection (network drop, captive
 * portal, stalled TLS) could hang the operation forever — the token-refresh
 * self-loop, cold-boot bootstrap, a device-code poll, or a request awaiting a
 * lazy mint. Each fetch now passes `AbortSignal.timeout(...)`; on timeout it
 * throws, landing in the caller's EXISTING retry/degrade/continue branch. This
 * is a bounded guard, not a behavior change.
 */

/** Copilot token mint + the refresh self-loop (`signed-in → signed-in`). The
 *  bearer lives ~30 min, refreshed ~25 min in — a 30s ceiling on one attempt
 *  leaves ample room to retry before expiry. */
export const COPILOT_TOKEN_TIMEOUT_MS = 30_000

/** GitHub API reads bounded onto the cold-boot / sign-in critical path:
 *  `/user`, `/copilot_internal/user`, and the device-code request. */
export const GITHUB_API_TIMEOUT_MS = 15_000

/** One device-code poll attempt. The overall flow is also bounded by the
 *  device code's own expiry (see pollAccessToken's deadline check). */
export const DEVICE_POLL_TIMEOUT_MS = 15_000

/**
 * The update manifest fetch (`src/lib/update/update-check.ts`).
 *
 * Deliberately tighter than {@link GITHUB_API_TIMEOUT_MS}, which it used to
 * borrow. Two reasons, and the second is why maximal-core#7 specifies 2s:
 *
 *   - It is not a GitHub API call. It is a ~1 KB static object on a Fastly-
 *     backed CDN, so 15s only ever buys a hung socket more time to hang.
 *   - The same fetch now feeds the minimum-supported-version floor. Nothing on
 *     the request path awaits it (the gate reads the cache synchronously), but
 *     a short ceiling keeps a stalled refresh from occupying the single-flight
 *     slot — and therefore delaying the floor becoming known — for a quarter of
 *     a minute.
 *
 * The cost is that a very slow link may never resolve an update check; that is
 * acceptable for a best-effort, 6h-cached, fail-open mechanism.
 */
export const UPDATE_MANIFEST_TIMEOUT_MS = 2_000
