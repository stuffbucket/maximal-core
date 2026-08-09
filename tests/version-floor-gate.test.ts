/**
 * The proxy-enforced `min_supported_version` force-upgrade lever
 * (maximal-core#7): `src/lib/update/version-gate.ts` plus the manifest floor it
 * reads out of `src/lib/update/update-check.ts`.
 *
 * Three properties, in descending order of how much damage getting them wrong
 * would do:
 *
 *   1. FAIL-OPEN. Cold cache, network error, timeout, non-200, malformed
 *      manifest, absent field — every one of them must let the request through.
 *      A lever that takes the proxy down when the CDN blips is worse than the
 *      vulnerability it guards against, so this is tested from every angle.
 *   2. Below the floor refuses legibly, on the proxy path, with a
 *      machine-readable discriminant.
 *   3. At or above the floor is a complete no-op.
 *
 * The update-check DI seam is pinned in every test here, so nothing in this
 * file touches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { AppConfig } from "~/lib/config/config"

import {
  getConfig,
  isUpdateCheckEnabled,
  isVersionFloorEnforced,
  writeConfig,
} from "~/lib/config/config"
import { UPDATE_MANIFEST_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import {
  __resetUpdateCheckDepsForTests,
  __setUpdateCheckDepsForTests,
  checkVersionFloor,
  DOWNLOAD_URL,
  getUpdateStatus,
  parseManifest,
} from "~/lib/update/update-check"
import { BUILD_RETIRED_TYPE } from "~/lib/update/version-gate"
import { controlApp, publicApp } from "~/server"

/** A manifest body carrying both fields on the `stable` channel. */
const manifestBody = (o: {
  version?: unknown
  min?: unknown
  channel?: string
}): string =>
  JSON.stringify({
    schema: 2,
    channels: {
      [o.channel ?? "stable"]: {
        ...(o.version === undefined ? {} : { version: o.version }),
        ...(o.min === undefined ? {} : { min_supported_version: o.min }),
      },
    },
  })

/** Let a fire-and-forget refresh settle. The pinned fetch resolves on the
 *  microtask queue, so one macrotask turn is enough. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Warm the module cache from a pinned manifest, as if the background refresh
 * had already landed, and pin the running build's version.
 */
async function warmManifest(body: string, currentVersion: string) {
  __setUpdateCheckDepsForTests({
    fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    currentVersion,
  })
  await getUpdateStatus(true)
}

beforeEach(() => {
  __resetUpdateCheckDepsForTests()
})
afterEach(() => {
  __resetUpdateCheckDepsForTests()
})

describe("parseManifest", () => {
  test("reads min_supported_version alongside version", () => {
    const facts = parseManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
    )
    expect(facts).toEqual({ latest: "0.9.0", minSupported: "0.6.1" })
  })

  test("tolerates a leading v and surrounding whitespace", () => {
    expect(
      parseManifest(manifestBody({ version: "0.9.0", min: " v0.6.1 " }))
        .minSupported,
    ).toBe("0.6.1")
  })

  test("a channel with no floor declared reads as null, not as zero", () => {
    // The overwhelmingly common case. `null` must mean "no floor", never a
    // floor of 0.0.0 (which would compare as "nothing is retired" anyway) and
    // never a parse that retires the fleet.
    expect(
      parseManifest(manifestBody({ version: "0.9.0" })).minSupported,
    ).toBeNull()
  })

  test("rejects anything that is not a bare semver", () => {
    // A tampered or malformed manifest must degrade to "unknown", because
    // "unknown" is the fail-open value.
    for (const min of [
      42,
      null,
      ">=0.6.1",
      "0.6",
      "latest",
      "https://evil.example/x",
      "",
    ]) {
      expect(
        parseManifest(manifestBody({ version: "0.9.0", min })).minSupported,
      ).toBeNull()
    }
    expect(parseManifest("<!DOCTYPE html>").minSupported).toBeNull()
    expect(parseManifest("{}").minSupported).toBeNull()
  })

  test("reads the floor from the build's own channel only", () => {
    const multi = JSON.stringify({
      channels: {
        stable: { version: "0.9.0", min_supported_version: "0.6.1" },
        beta: { version: "1.0.0-rc.1", min_supported_version: "1.0.0-rc.1" },
      },
    })
    expect(parseManifest(multi, "beta").minSupported).toBe("1.0.0-rc.1")
    expect(parseManifest(multi, "stable").minSupported).toBe("0.6.1")
    expect(parseManifest(multi, "nightly").minSupported).toBeNull()
  })
})

describe("checkVersionFloor", () => {
  test("a build below the floor is retired", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.0",
    )
    expect(checkVersionFloor()).toEqual({
      current: "0.6.0",
      minSupported: "0.6.1",
      retired: true,
    })
  })

  test("a build exactly at the floor is not retired", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.1",
    )
    expect(checkVersionFloor().retired).toBe(false)
  })

  test("a build above the floor is not retired", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.7.0",
    )
    expect(checkVersionFloor().retired).toBe(false)
  })

  test("a -dev build of the floor release is not retired", async () => {
    // build-sidecar stamps local binaries `<version>-dev+<sha>`. Semver ranks a
    // prerelease below its release, so without the same normalization the
    // update check uses, every dev build of the current release would be
    // retired by its own floor.
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.1-dev+abc12345",
    )
    expect(checkVersionFloor().retired).toBe(false)
  })

  test("a real prerelease below the floor is still retired", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.1-beta.2",
    )
    expect(checkVersionFloor().retired).toBe(true)
  })

  test("fails open when nothing has been fetched yet", () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.reject(new Error("offline")),
      currentVersion: "0.0.1",
    })
    // Cold cache: the very first proxy request of a process must not be
    // refused just because the floor is not known yet.
    expect(checkVersionFloor()).toEqual({
      current: "0.0.1",
      minSupported: null,
      retired: false,
    })
  })

  test("fails open on a network error, a timeout and a non-200", async () => {
    for (const fetchImpl of [
      () => Promise.reject(new Error("offline")),
      () =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
      () => Promise.resolve(new Response("nope", { status: 503 })),
    ]) {
      __resetUpdateCheckDepsForTests()
      __setUpdateCheckDepsForTests({
        fetch: fetchImpl,
        currentVersion: "0.0.1",
      })
      await getUpdateStatus(true)
      expect(checkVersionFloor().retired).toBe(false)
    }
  })

  test("fails open on a 200 whose body is not a usable manifest", async () => {
    await warmManifest("<html>captive portal</html>", "0.0.1")
    expect(checkVersionFloor().retired).toBe(false)
  })

  test("keeps the last known floor when a later refresh fails", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.0",
    )
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.reject(new Error("offline")),
    })
    await getUpdateStatus(true)
    // A transient blip must not un-retire a build that is genuinely below the
    // floor — that is the one direction where staleness favours the user.
    expect(checkVersionFloor().retired).toBe(true)
  })

  test("bounds the manifest fetch with a 2s abort signal", async () => {
    let signal: AbortSignal | null = null
    __setUpdateCheckDepsForTests({
      fetch: (_url, init) => {
        signal = (init?.signal as AbortSignal | undefined) ?? null
        return Promise.resolve(
          new Response(manifestBody({ version: "0.9.0" }), { status: 200 }),
        )
      },
    })
    await getUpdateStatus(true)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(UPDATE_MANIFEST_TIMEOUT_MS).toBe(2000)
  })

  test("a cold read kicks exactly one background refresh, not one per call", async () => {
    let calls = 0
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return Promise.resolve(
          new Response(manifestBody({ version: "0.9.0", min: "0.6.1" }), {
            status: 200,
          }),
        )
      },
      currentVersion: "0.6.0",
    })

    // A burst of proxy requests against a cold cache: single-flight must
    // collapse them onto one fetch, and none of them may block on it.
    expect(checkVersionFloor().retired).toBe(false)
    expect(checkVersionFloor().retired).toBe(false)
    expect(checkVersionFloor().retired).toBe(false)
    await settle()

    expect(calls).toBe(1)
    // The refreshed floor is what LATER requests see.
    expect(checkVersionFloor().retired).toBe(true)
    await settle()
    expect(calls).toBe(1) // served from cache
  })

  test("a failed refresh is not retried on every request", async () => {
    let calls = 0
    let clock = 1_000_000
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return Promise.reject(new Error("offline"))
      },
      now: () => clock,
      currentVersion: "0.6.0",
    })

    checkVersionFloor()
    await settle()
    checkVersionFloor()
    await settle()
    expect(calls).toBe(1) // backoff, not a per-request CDN poll

    clock += 5 * 60 * 1000 + 1
    checkVersionFloor()
    await settle()
    expect(calls).toBe(2)
  })
})

describe("the two network knobs are separate promises", () => {
  let original: AppConfig
  /** Counts every outbound attempt, whichever consumer triggered it. */
  let calls = 0

  beforeEach(() => {
    original = getConfig()
    calls = 0
    __setUpdateCheckDepsForTests({
      fetch: () => {
        calls++
        return Promise.resolve(
          new Response(manifestBody({ version: "0.9.0", min: "0.6.1" }), {
            status: 200,
          }),
        )
      },
      currentVersion: "0.6.0",
    })
  })
  afterEach(() => {
    writeConfig(original)
  })

  test("checkUpdates:false silences the notification; the floor keeps its own", async () => {
    writeConfig({ ...original, checkUpdates: false })

    // getUpdateStatus stays idle — no fetch, nothing to report…
    const status = await getUpdateStatus(true)
    expect(status.enabled).toBe(false)
    expect(status.update_available).toBe(false)
    expect(status.latest).toBeNull()
    expect(calls).toBe(0)

    // …and the floor still applies, because it is governed by its OWN key and
    // that one is still at its default. `checkUpdates` never meant "stop
    // enforcing the floor" — it now means only what it always documented.
    checkVersionFloor()
    await settle()
    expect(checkVersionFloor().retired).toBe(true)
  })

  test("enforceVersionFloor:false stops the fetch and the gating", async () => {
    writeConfig({ ...original, enforceVersionFloor: false })

    expect(checkVersionFloor()).toEqual({
      current: "0.6.0",
      minSupported: null,
      retired: false,
    })
    await settle()
    expect(calls).toBe(0) // the floor makes no outbound call when it is off

    // …and a build that WOULD be retired proxies normally.
    const res = await publicApp.request("/v1/models")
    expect(res.status).not.toBe(426)
  })

  test("a floor the update check happened to cache is not enforced once off", async () => {
    // The cache is shared, so an update check can populate `minSupported` even
    // with the lever off. That must not resurrect the gate: with no floor in
    // force, a cached one is not a floor.
    await getUpdateStatus(true)
    expect((await getUpdateStatus()).min_supported).toBe("0.6.1")
    expect(checkVersionFloor().retired).toBe(true)

    writeConfig({ ...original, enforceVersionFloor: false })
    expect(checkVersionFloor()).toEqual({
      current: "0.6.0",
      minSupported: null,
      retired: false,
    })
    expect((await publicApp.request("/v1/models")).status).not.toBe(426)
  })

  test("both off means zero outbound calls", async () => {
    writeConfig({
      ...original,
      checkUpdates: false,
      enforceVersionFloor: false,
    })

    await getUpdateStatus(true)
    checkVersionFloor()
    const res = await publicApp.request("/v1/models")
    await settle()

    expect(calls).toBe(0)
    // Unchanged pre-#7 behaviour: no GitHub token in the test process.
    expect(res.status).toBe(401)
  })

  test("both default to on", () => {
    // The security control ships enabled; only an explicit opt-out turns it off.
    writeConfig({
      ...original,
      checkUpdates: undefined,
      enforceVersionFloor: undefined,
    })
    expect(isUpdateCheckEnabled()).toBe(true)
    expect(isVersionFloorEnforced()).toBe(true)
  })
})

describe("update/status reports the floor", () => {
  test("min_supported rides along for diagnostics", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.0",
    )
    const status = await getUpdateStatus()
    expect(status.min_supported).toBe("0.6.1")
    expect(status.latest).toBe("0.9.0")
    expect(status.url).toBe(DOWNLOAD_URL)
  })
})

describe("the proxy path refuses a retired build", () => {
  test("a below-floor build gets 426 build_retired with the remedy", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.0",
    )

    const res = await publicApp.request("/v1/models")

    expect(res.status).toBe(426)
    const body = (await res.json()) as {
      error: {
        message: string
        type: string
        current_version: string
        min_supported_version: string
        upgrade_url: string
      }
    }
    expect(body.error.type).toBe(BUILD_RETIRED_TYPE)
    expect(body.error.current_version).toBe("0.6.0")
    expect(body.error.min_supported_version).toBe("0.6.1")
    expect(body.error.upgrade_url).toBe(DOWNLOAD_URL)
    // Legible: names both versions and, like CopilotTokenStaleError, says what
    // will NOT help so no client sends the user down a re-login path.
    expect(body.error.message).toContain("0.6.0")
    expect(body.error.message).toContain("0.6.1")
    expect(body.error.message).toContain("will not help")
  })

  test("every upstream-touching route family is gated", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.0",
    )

    for (const path of [
      "/chat/completions",
      "/models",
      "/embeddings",
      "/responses",
      "/v1/chat/completions",
      "/v1/models",
      "/v1/messages",
      "/copilot/v1/messages",
    ]) {
      const res = await publicApp.request(path, { method: "POST" })
      expect({ path, status: res.status }).toEqual({ path, status: 426 })
    }
  })

  test("the gate runs BEFORE the GitHub-auth gate", async () => {
    // With no GitHub token the same request would 401 `not_authenticated`.
    // "Sign in" is not the remedy for a retired build, so the upgrade error
    // must win.
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.0",
    )
    const res = await publicApp.request("/v1/models")
    expect(res.status).toBe(426)
  })

  test("the diagnosis-and-recovery surfaces stay reachable", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.0",
    )

    // A blocked user must still be able to see WHY and to fix it.
    for (const path of ["/", "/status", "/setup-status"]) {
      const res = await publicApp.request(path)
      expect({ path, status: res.status }).toEqual({ path, status: 200 })
    }
    // …including the whole control listener, which is how a supervisor drives
    // sign-in, reads update/status, and requests an upgrade.
    const control = await controlApp.request("/control/rpc", { method: "GET" })
    expect(control.status).not.toBe(426)
  })
})

describe("at or above the floor there is no effect at all", () => {
  test("a supported build reaches the auth gate untouched", async () => {
    await warmManifest(
      manifestBody({ version: "0.9.0", min: "0.6.1" }),
      "0.6.1",
    )
    const res = await publicApp.request("/v1/models")
    // Unchanged pre-#7 behaviour: no GitHub token in the test process.
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "not_authenticated" })
  })

  test("a manifest with no floor is a no-op", async () => {
    await warmManifest(manifestBody({ version: "0.9.0" }), "0.0.1")
    const res = await publicApp.request("/v1/models")
    expect(res.status).toBe(401)
  })

  test("an unreachable manifest is a no-op (fail-open on the request path)", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.reject(new Error("offline")),
      currentVersion: "0.0.1",
    })
    await getUpdateStatus(true)

    const res = await publicApp.request("/v1/models")
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "not_authenticated" })
  })
})
