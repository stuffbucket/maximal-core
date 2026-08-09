/**
 * The update manifest reader. One CDN object, one cache, two consumers:
 *
 *  1. **Update-available (notify-only)** — `docs/spec/phase-6-self-update.md`,
 *     Open Q#1. Resolves the latest published release version and compares it
 *     to the running `BUILD_VERSION`. Config-gated (`config.checkUpdates`,
 *     default ON) and cached so the Settings panel + the shell's periodic
 *     notification don't refetch needlessly.
 *  2. **The minimum-supported-version floor (maximal-core#7)** — the same
 *     manifest carries `min_supported_version` per channel. `checkVersionFloor`
 *     reads it *synchronously* off this cache so the proxy path can refuse a
 *     retired build without ever awaiting the network. Enforcement lives in
 *     `~/lib/update/version-gate`; this module only supplies the fact.
 *
 * Install-channel neutral: we point users at `https://mxml.sh` (the download
 * page that routes to the right artifact / package manager) rather than a raw
 * release asset, because the running build could be a brew/npm/MSI install that
 * shouldn't be clobbered by a bare binary swap.
 *
 * Best-effort throughout: any failure (offline, rate-limited, malformed body)
 * reports `update_available: false` / an unknown floor instead of throwing — a
 * missing update ping must never degrade the proxy, and neither must a missing
 * floor (#7 mandates fail-open).
 */

import {
  isUpdateCheckEnabled,
  isVersionFloorEnforced,
} from "~/lib/config/config"
import { UPDATE_MANIFEST_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { createTeeLogger } from "~/lib/platform/logger"
import { BUILD_CHANNEL, BUILD_VERSION } from "~/lib/update/build-info"

const log = createTeeLogger("update")

/** The update manifest — a small JSON document the project site publishes on
 *  every release. mxml.sh is now a GitHub Pages CUSTOM DOMAIN (Fastly-backed,
 *  GitHub's own CDN) — not the old Caddy proxy — so we fetch it straight from
 *  there: a static, CDN-cached object with NO auth and NO per-IP rate limit, so
 *  it scales to every client with the fewest hops and smallest trust surface.
 *  (The REST API caps anonymous callers at 60/h/IP — a real failure mode behind
 *  a shared corporate NAT, where it silently returns "no update".) The legacy
 *  stuffbucket.github.io/maximal/updates/manifest.json still 301-redirects here.
 *  Channel-keyed, so opting a build into a future `beta` is a server-only +
 *  client-config change. */
const MANIFEST_URL = "https://mxml.sh/updates/manifest.json"

/** Which release channel this build follows — derived from the build's
 *  `BUILD_CHANNEL` (`stable` for source/stock builds; `beta` etc. when a
 *  channel binary injects `__MAXIMAL_CHANNEL__`). The manifest is
 *  channel-keyed, so a `beta` build polls the manifest's `beta` entry while
 *  `stable` keeps reading `stable`. */
const UPDATE_CHANNEL = BUILD_CHANNEL

/** Where to send the user to update — install-channel neutral. mxml.sh serves
 *  at the root (apex) now; the older /maximal Caddy path is retired. */
export const DOWNLOAD_URL = "https://mxml.sh/"

/** Cache the parsed manifest this long. Generous on purpose: a new release is
 *  rare, so there's no value re-fetching the CDN asset more often. The shell's
 *  periodic check and the occasional Settings open both read through this, and
 *  so does the #7 version floor — a blocked build must not hammer the CDN. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** Floor for how often a *failed* fetch may be retried. Without it, the version
 *  gate's fire-and-forget refresh would re-attempt on every proxy request while
 *  the cache is stale (the failure path never writes the cache), turning an
 *  outage into a request-rate CDN poll. */
const REFRESH_RETRY_MS = 5 * 60 * 1000

export interface UpdateStatus {
  /** The running build's version. */
  current: string
  /** Latest published release version (no leading "v"), or null if unknown. */
  latest: string | null
  /** True only when `latest` is strictly newer than `current`. */
  update_available: boolean
  /** Where to get it. */
  url: string
  /** Whether update checking is enabled (`config.checkUpdates`). False means
   *  the mechanism is intentionally idle — not broken. */
  enabled: boolean
  /** ISO time of the last successful manifest fetch, or null if we've never
   *  reached it. Lets diagnostics show whether the check is actually running. */
  checked_at: string | null
  /** Short reason the most recent attempt didn't yield a usable version
   *  (network error, non-200, unparseable manifest), or null when the last
   *  attempt succeeded / checks are disabled. Diagnostic only — never thrown. */
  last_error: string | null
  /** The manifest's `min_supported_version` for this channel, or null when
   *  unknown (never fetched, fetch failed, or the manifest declares no floor).
   *  Reported even when `enabled` is false, because the floor is enforced
   *  regardless of the update-notification preference — see
   *  {@link checkVersionFloor}. */
  min_supported: string | null
}

// Dependency-injection shim for tests, mirroring token.ts / auth-recovery.ts:
// a process-wide mock.module leaks across sibling test files, so the suite
// overrides fetch + the clock via __setUpdateCheckDepsForTests instead. The
// narrowed signature (vs `typeof fetch`) is what the real `fetch` and a plain
// stub are both assignable to — `typeof fetch` carries extras like `preconnect`.
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchLike = fetch
let nowMs: () => number = Date.now
let versionImpl: string = BUILD_VERSION

/** @internal test seam */
export function __setUpdateCheckDepsForTests(o: {
  fetch?: FetchLike
  now?: () => number
  currentVersion?: string
}): void {
  if (o.fetch) fetchImpl = o.fetch
  if (o.now) nowMs = o.now
  if (o.currentVersion) versionImpl = o.currentVersion
}

/** @internal test seam */
export function __resetUpdateCheckDepsForTests(): void {
  fetchImpl = fetch
  nowMs = Date.now
  versionImpl = BUILD_VERSION
  cache = null
  lastError = null
  inFlight = null
  nextAttemptAtMs = 0
}

/** What one successful manifest read tells us. Cached instead of a built
 *  `UpdateStatus` because the two consumers want different projections of it,
 *  and because `update_available` depends on the running version, which the
 *  test seam can change between reads. */
interface ManifestFacts {
  /** Latest published release for this channel, or null if unparseable. */
  latest: string | null
  /** Oldest build this channel still serves, or null when none is declared. */
  minSupported: string | null
}

let cache: { atMs: number; facts: ManifestFacts } | null = null
/** Why the most recent *attempt* failed. Kept outside `cache` so a later
 *  failure is reported without discarding the last good facts. */
let lastError: string | null = null
/** Single-flight guard: a burst of proxy requests must produce one fetch. */
let inFlight: Promise<void> | null = null
/** Earliest clock time at which an unforced refresh may be attempted. */
let nextAttemptAtMs = 0

/**
 * Best-effort semver-precedence compare. Returns true if `a` is strictly newer
 * than `b`. Missing/garbage core segments read as 0.
 */
function parseSemver(v: unknown): [number, number, number, Array<string>] {
  const raw = typeof v === "string" ? v.replace(/^v/u, "") : ""
  const prereleaseAt = raw.indexOf("-")
  const core = prereleaseAt === -1 ? raw : raw.slice(0, prereleaseAt)
  const prerelease =
    prereleaseAt === -1 ? [] : raw.slice(prereleaseAt + 1).split(".")
  const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, prerelease]
}

export function isNewerVersion(a: string, b: string): boolean {
  const [a0, a1, a2, aPre] = parseSemver(a)
  const [b0, b1, b2, bPre] = parseSemver(b)
  if (a0 !== b0) return a0 > b0
  if (a1 !== b1) return a1 > b1
  if (a2 !== b2) return a2 > b2
  if (aPre.length === 0 || bPre.length === 0) return bPre.length > 0
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    if (i >= aPre.length) return false
    if (i >= bPre.length) return true
    const aId = aPre[i]
    const bId = bPre[i]
    const aNum = /^\d+$/u.test(aId)
    const bNum = /^\d+$/u.test(bId)
    if (aNum && bNum) {
      const diff = Number.parseInt(aId, 10) - Number.parseInt(bId, 10)
      if (diff !== 0) return diff > 0
    } else if (aNum !== bNum) {
      return !aNum
    } else if (aId !== bId) {
      return aId > bId
    }
  }
  return false
}

/**
 * Strip a local-build suffix (`-dev+<sha>`) so a dev binary compares on its
 * core version. build-sidecar.ts stamps non-release binaries as
 * `<pkg.version>-dev+<sha>`; without this, a dev build of the current release
 * (e.g. `0.4.35-dev+abc`) reads as *older* than the published `0.4.35` — since
 * semver ranks a prerelease below its release — and perpetually self-reports
 * "update available" for the version it's already running. A real prerelease
 * channel (`-beta.N`, `-rc.N`) is left intact: those genuinely precede the
 * release and should still see it as an upgrade.
 */
function normalizeCurrent(version: string): string {
  const devAt = version.indexOf("-dev+")
  return devAt === -1 ? version : version.slice(0, devAt)
}

interface UpdateManifest {
  channels?:
    | Record<
        string,
        { version?: unknown; min_supported_version?: unknown } | undefined
      >
    | undefined
}

/** Accept only a bare `x.y.z[-prerelease]`, optionally `v`-prefixed. Anything
 *  else — a URL, a range, a truncated `0.4` — is rejected rather than coerced,
 *  so a malformed or tampered manifest degrades to "unknown" instead of
 *  reporting a bogus version (or, for the floor, retiring the fleet). */
const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/u

function readChannelVersion(
  parsed: unknown,
  channel: string,
  field: "version" | "min_supported_version",
): string | null {
  const value = (parsed as UpdateManifest | null)?.channels?.[channel]?.[field]
  if (typeof value !== "string") return null
  const match = VERSION_RE.exec(value.trim())
  return match ? match[1] : null
}

/**
 * Pull a channel's facts out of the manifest JSON. Strict and best-effort:
 * every field independently degrades to null for any shape we don't recognize
 * (bad JSON, missing channel, non-version string). The download destination is
 * never read from the manifest; see `DOWNLOAD_URL`.
 */
export function parseManifest(
  body: string,
  channel: string = UPDATE_CHANNEL,
): ManifestFacts {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { latest: null, minSupported: null }
  }
  return {
    latest: readChannelVersion(parsed, channel, "version"),
    minSupported: readChannelVersion(parsed, channel, "min_supported_version"),
  }
}

/**
 * Fetch the manifest and replace the cache. Never throws; on failure the cache
 * is left ALONE (a transient blip must not erase a known-good floor) and
 * `lastError` records why.
 */
async function refreshManifest(): Promise<void> {
  try {
    const res = await fetchImpl(MANIFEST_URL, {
      headers: { "user-agent": "maximal" },
      signal: AbortSignal.timeout(UPDATE_MANIFEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      // Transient CDN/network blip, or a manifest not yet deployed.
      lastError = `manifest fetch returned HTTP ${res.status}`
      log.warn(`Update check: ${lastError}; skipping.`)
      return
    }
    const facts = parseManifest(await res.text())
    // Single-threaded module, and `ensureManifest`'s single-flight guard means
    // there is never a concurrent writer, so these post-await writes are safe.
    lastError =
      facts.latest === null ?
        "manifest had no usable version for this channel"
      : null
    cache = { atMs: nowMs(), facts }
  } catch (err) {
    lastError =
      err instanceof Error ?
        `network error: ${err.message}`
      : "update check failed"
    log.warn("Update check failed (continuing):", err)
  }
}

/**
 * Refresh the cache if it is stale, coalescing concurrent callers onto one
 * fetch. `force` bypasses both the TTL and the failure backoff. Resolves as
 * soon as there is nothing to wait for, so a caller that does not await it
 * (the version gate) never pays for the network.
 */
function ensureManifest(force: boolean): Promise<void> {
  if (inFlight) return inFlight
  const now = nowMs()
  if (!force) {
    if (cache && now - cache.atMs < CACHE_TTL_MS) return Promise.resolve()
    if (now < nextAttemptAtMs) return Promise.resolve()
  }
  nextAttemptAtMs = now + REFRESH_RETRY_MS
  const started = refreshManifest().finally(() => {
    if (inFlight === started) inFlight = null
  })
  inFlight = started
  return started
}

/**
 * Resolve whether a newer release is available. NEVER throws: any failure
 * (disabled, offline, non-200, timeout, malformed manifest) returns a coherent
 * status carrying diagnostic fields — `enabled`, `checked_at`, `last_error` —
 * and the last known `latest` if we have one, so a transient blip doesn't erase
 * a real result. `force` bypasses the cache.
 */
export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
  const current = versionImpl

  // Disabled is an intentional idle state, not a failure: report it cleanly,
  // with no stale result and no error, and WITHOUT touching the network —
  // `checkUpdates: false` means the release ping does not happen. The floor is
  // reported from whatever the cache already holds; it has its own key and its
  // own fetch trigger (`checkVersionFloor`), so with both off nothing goes out.
  if (!isUpdateCheckEnabled()) {
    return {
      current,
      latest: null,
      update_available: false,
      url: DOWNLOAD_URL,
      enabled: false,
      checked_at: cache ? new Date(cache.atMs).toISOString() : null,
      last_error: null,
      min_supported: cache?.facts.minSupported ?? null,
    }
  }

  await ensureManifest(force)

  // On a failed attempt the cache is untouched, so this keeps the last known
  // result (if any) and `lastError` surfaces why the refresh didn't land.
  const latest = cache?.facts.latest ?? null
  return {
    current,
    latest,
    update_available:
      latest !== null && isNewerVersion(latest, normalizeCurrent(current)),
    url: DOWNLOAD_URL,
    enabled: true,
    checked_at: cache ? new Date(cache.atMs).toISOString() : null,
    last_error: lastError,
    min_supported: cache?.facts.minSupported ?? null,
  }
}

/** The verdict {@link checkVersionFloor} hands the proxy-path gate. */
export interface VersionFloorVerdict {
  /** The running build, verbatim (dev suffix included) — for the message. */
  current: string
  /** The floor we compared against, or null when it is unknown. */
  minSupported: string | null
  /** True ONLY when a floor is known AND this build is strictly below it. */
  retired: boolean
}

/**
 * Is the running build below the manifest's `min_supported_version`?
 *
 * SYNCHRONOUS AND FAIL-OPEN, both load-bearing (maximal-core#7):
 *
 *  - It reads the cached fact and never awaits, so the proxy path pays no
 *    network latency and a hung CDN cannot stall a request. A stale-or-cold
 *    cache kicks a background refresh whose result lands for *later* requests.
 *  - Every unknown — never fetched, fetch failed, timed out, malformed
 *    manifest, no floor declared — returns `retired: false`. A lever that can
 *    take the proxy down when the CDN blips is worse than the vulnerability it
 *    guards against.
 *
 * Governed by its OWN config key (`enforceVersionFloor`, default ON), not by
 * `checkUpdates`. The two are different promises: `checkUpdates` is documented
 * as disabling the release ping entirely, and quietly widening it to cover a
 * security fetch would break a network opt-out somebody set deliberately. With
 * a separate key the control stays on for everyone who has not opted out, and
 * turning BOTH off is what buys zero outbound calls — the read here is the only
 * one the floor makes, and it is the same anonymous CDN GET the update check
 * makes, with no telemetry and no credential.
 *
 * Disabled reports an unknown floor rather than a stale one: with the lever off
 * there is no floor in force, so a `minSupported` a previous update check
 * happened to cache must not read as one.
 */
export function checkVersionFloor(): VersionFloorVerdict {
  const current = versionImpl
  if (!isVersionFloorEnforced()) {
    return { current, minSupported: null, retired: false }
  }
  void ensureManifest(false)
  const minSupported = cache?.facts.minSupported ?? null
  return {
    current,
    minSupported,
    retired:
      minSupported !== null
      && isNewerVersion(minSupported, normalizeCurrent(current)),
  }
}
