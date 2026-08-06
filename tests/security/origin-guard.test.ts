import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  CSRF_GUARDED_PREFIXES,
  buildCorsOptions,
  createOriginGuardMiddleware,
  isAllowedOrigin,
  isCsrfGuardedPath,
} from "~/lib/auth/origin-guard"
import { controlApp, publicApp } from "~/server"

/**
 * Control-surface hardening (ADR-0021 §6).
 *
 * The first half of this file unit-tests the two pure predicates and the
 * middleware in isolation. The second half is the **route-enumeration** test
 * ADR-0021 → _Testing_ asked for: it walks the real `routes` tables of both
 * listeners so a control route added outside a guarded prefix fails here rather
 * than shipping unguarded.
 *
 * The version this replaced enumerated nothing. It asserted on `/settings/api`
 * and mounted its own throwaway Hono app on that path — a surface deleted at the
 * core split — so it passed while exercising a route table that did not exist.
 * A route-enumeration test that cannot fail is worse than none: it is what let
 * `/control` be added to `CSRF_GUARDED_PREFIXES` with nothing checking that the
 * guard reached it. Everything below drives `~/server`'s actual apps.
 */

const PORT = 4141

describe("isAllowedOrigin", () => {
  test("a missing Origin passes — CLI/plugin clients send none (§6.6 invariant)", () => {
    expect(isAllowedOrigin(null, PORT)).toBe(true)
  })
  test("localhost + 127.0.0.1 on the bound port pass", () => {
    expect(isAllowedOrigin(`http://localhost:${PORT}`, PORT)).toBe(true)
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT)).toBe(true)
  })
  test("a foreign origin is rejected", () => {
    expect(isAllowedOrigin("https://evil.example", PORT)).toBe(false)
  })
  test("the wrong port is rejected (not a blanket localhost allow)", () => {
    expect(isAllowedOrigin(`http://localhost:${PORT + 1}`, PORT)).toBe(false)
  })
})

describe("isCsrfGuardedPath", () => {
  test("guards the control prefixes and not the proxy surface", () => {
    expect(isCsrfGuardedPath("/control/rpc")).toBe(true)
    expect(isCsrfGuardedPath("/_internal/shutdown")).toBe(true)
    expect(isCsrfGuardedPath("/_debug/state")).toBe(true)
    expect(isCsrfGuardedPath("/v1/models")).toBe(false) // CLI surface stays open
  })
  test("a prefix matches on a segment boundary, not a substring", () => {
    expect(isCsrfGuardedPath("/controlled/thing")).toBe(false)
    expect(isCsrfGuardedPath("/control")).toBe(true)
  })
})

/** The guard in front of a single control route, isolated from `~/server`. */
function mountGuarded() {
  const app = new Hono()
  app.use("*", createOriginGuardMiddleware({ boundPort: () => PORT }))
  app.post("/control/accounts/remove", (c) => c.json({ ok: true }))
  return app
}

describe("origin guard middleware in isolation", () => {
  test("evil Origin → 403 on a mutation", async () => {
    const res = await mountGuarded().request("/control/accounts/remove", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })
    expect(res.status).toBe(403)
    // Pin the machine-readable error contract — clients branch on `type`.
    const body = (await res.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe("csrf_error")
  })

  test("localhost Origin passes the Origin gate (reaches the route)", async () => {
    const res = await mountGuarded().request("/control/accounts/remove", {
      method: "POST",
      headers: { origin: `http://localhost:${PORT}` },
    })
    expect(res.status).toBe(200)
  })

  test("cors options never echo '*'", () => {
    const opts = buildCorsOptions(() => PORT)
    expect(opts.origin("https://evil.example")).toBeNull()
    expect(opts.origin(`http://localhost:${PORT}`)).toBe(
      `http://localhost:${PORT}`,
    )
  })
})

// ── Route enumeration ───────────────────────────────────────────────────────

/**
 * A concrete, requestable route on one of the two listeners.
 *
 * Hono's `app.routes` mixes handlers with middleware. `applyCommonMiddleware`
 * registers as `ALL /*`, and `.route(path, subApp)` additionally contributes an
 * `ALL <path>/*` entry when the sub-app has middleware of its own (`/control`
 * does; `/_internal` does not). The `ALL /*` entries are app-wide and match
 * everything, so they say nothing about *where* routes live; every other entry
 * does, including those `ALL <path>/*` mounts — which is what keeps a newly
 * mounted sub-app visible here even before its own paths are read.
 */
interface EnumeratedRoute {
  readonly app: "publicApp" | "controlApp"
  readonly method: string
  readonly path: string
}

function enumerate(
  name: EnumeratedRoute["app"],
  app: Hono,
): Array<EnumeratedRoute> {
  const seen = new Set<string>()
  const out: Array<EnumeratedRoute> = []
  for (const { method, path } of app.routes) {
    // App-wide middleware, not a route. Anything else — including a handler
    // mounted at "/" — is kept.
    if (path === "/*" && method === "ALL") continue
    const key = `${method} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ app: name, method, path })
  }
  return out
}

const ROUTES = [
  ...enumerate("controlApp", controlApp),
  ...enumerate("publicApp", publicApp),
]

/** `"GET /control/api-keys/:id"` — stable, greppable failure output. */
const label = (r: EnumeratedRoute) => `${r.app} ${r.method} ${r.path}`

/**
 * A requestable URL for a route pattern: `:param` and trailing `*` become a
 * literal segment. The Origin guard only reads `c.req.path`, so the substitution
 * cannot change the verdict — it just makes the path routable.
 */
function probePath(path: string): string {
  return path.replaceAll(/:[^/]+/gu, "__probe").replaceAll("*", "__probe")
}

/**
 * Guarded prefixes with no route behind them on either listener.
 *
 * `/settings/api` was deleted at the core split; the prefix stays in
 * `CSRF_GUARDED_PREFIXES` belt-and-braces. Listing it here rather than letting
 * it sit unexamined is the point: this file previously treated it as a live
 * surface. If a route ever appears under it, the "declared-dead prefixes really
 * are dead" test below fails and someone has to decide whether it is genuinely
 * back.
 */
const DECLARED_DEAD_PREFIXES = ["/settings/api"]

describe("route enumeration — the Origin guard's coverage is self-maintaining", () => {
  test("the walker actually finds both route tables (guards the guard)", () => {
    // If a refactor makes `app.routes` empty or the filter over-eager, every
    // assertion below would pass vacuously. These floors are far under the
    // current counts and only trip on that failure mode.
    expect(ROUTES.filter((r) => r.app === "controlApp").length).toBeGreaterThan(
      10,
    )
    expect(ROUTES.filter((r) => r.app === "publicApp").length).toBeGreaterThan(
      10,
    )
  })

  test("every route on the control listener falls under a guarded prefix", () => {
    // controlApp exists solely to carry the control plane, so the invariant is
    // total: mount something new on it without extending
    // CSRF_GUARDED_PREFIXES and this fails by omission.
    const unguarded = ROUTES.filter(
      (r) => r.app === "controlApp" && !isCsrfGuardedPath(r.path),
    ).map((r) => label(r))
    expect(unguarded).toEqual([])
  })

  test("on the public listener, nothing outside /_internal is guarded", () => {
    // The other half of the invariant, and the §6.6 CLI/plugin regression gate:
    // publicApp carries the proxy surface that non-browser clients call, so
    // widening a prefix to cover `/v1` or `/models` fails here.
    const guarded = ROUTES.filter(
      (r) => r.app === "publicApp" && isCsrfGuardedPath(r.path),
    )
    expect(
      guarded
        .filter((r) => !r.path.startsWith("/_internal"))
        .map((r) => label(r)),
    ).toEqual([])
    // …and the set is not empty, or the assertion above passes vacuously.
    expect(guarded.map((r) => `${r.method} ${r.path}`)).toContain(
      "POST /_internal/shutdown",
    )
  })

  test("every guarded prefix is either served or declared dead", () => {
    // Stops a third `/settings/api` from accumulating: a prefix that guards
    // nothing and is not declared dead is a fiction, and a fiction in this list
    // is what the previous version of this file was testing.
    const orphans = CSRF_GUARDED_PREFIXES.filter(
      (prefix) =>
        !DECLARED_DEAD_PREFIXES.includes(prefix)
        && !ROUTES.some(
          (r) => r.path === prefix || r.path.startsWith(prefix + "/"),
        ),
    )
    expect(orphans).toEqual([])
  })

  test("declared-dead prefixes really are dead", () => {
    const resurrected = ROUTES.filter((r) =>
      DECLARED_DEAD_PREFIXES.some(
        (prefix) => r.path === prefix || r.path.startsWith(prefix + "/"),
      ),
    ).map((r) => label(r))
    expect(resurrected).toEqual([])
  })

  test("every guarded route 403s a cross-origin request on the real app", async () => {
    // The list membership above is a string test. This drives the actual
    // middleware stack of the actual apps, so it also fails if the guard is
    // unmounted, mounted after the routes, or mounted on only one listener.
    // Safe to run against mutating routes: the guard short-circuits ahead of
    // every handler, which is the property being asserted.
    const guarded = ROUTES.filter((r) => isCsrfGuardedPath(r.path))
    expect(guarded.length).toBeGreaterThan(10)

    const failures: Array<string> = []
    for (const route of guarded) {
      const app = route.app === "controlApp" ? controlApp : publicApp
      const res = await app.request(probePath(route.path), {
        method: route.method === "ALL" ? "POST" : route.method,
        headers: { origin: "https://evil.example" },
      })
      const body = (await res.json().catch(() => ({}))) as {
        error?: { type?: string }
      }
      if (res.status !== 403 || body.error?.type !== "csrf_error") {
        failures.push(`${label(route)} → ${res.status} ${body.error?.type}`)
      }
    }
    expect(failures).toEqual([])
  })
})
