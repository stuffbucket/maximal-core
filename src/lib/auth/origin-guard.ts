/**
 * Control-surface hardening (ADR-0021 §6). This is the landed implementation,
 * not a plan — the CSRF hole it closes is closed.
 *
 * Loopback gating alone was never enough: it checks the source IP, and a
 * malicious page driving the user's local browser originates from 127.0.0.1 and
 * passes. So this module adds the two Origin-shaped gates, both mounted by
 * `applyCommonMiddleware` in `server.ts` ahead of every route:
 *
 *   - `createOriginGuardMiddleware` — 403s any request to a
 *     {@link CSRF_GUARDED_PREFIXES} path whose `Origin` is present and not
 *     localhost-on-the-bound-port. `Origin` is a Forbidden header (page JS
 *     cannot forge it), so this blocks all browser-driven cross-origin calls. A
 *     MISSING Origin passes — the CLI/plugin invariant (§6.6): Claude Code,
 *     opencode, and SDK clients send no Origin and must stay reachable.
 *   - `buildCorsOptions` — the global `cors()` is a localhost allowlist rather
 *     than `*`. The OPTIONS preflight is the load-bearing case, because auth
 *     bypasses OPTIONS.
 *
 * Both are keyed on `state.controlPort` (see `server.ts`), so a page served from
 * the *public* port is not an allowed origin either.
 *
 * §6.2 (mandatory auth on `/settings/api/*`, decoupled from the `enforce`
 * toggle) has no implementation here or in `request-auth.ts`: that surface was
 * removed with the UI cluster at the core split. `/control` replaced it and is
 * protected instead by the loopback-only bind, the control router's own peer-IP
 * 404, and this Origin guard.
 *
 * `tests/security/origin-guard.test.ts` walks the real route tables of both
 * listeners against this list, so a new control route that lands outside a
 * guarded prefix fails there rather than shipping unguarded.
 */
import type { MiddlewareHandler } from "hono"

/**
 * Prefixes that mutate or expose control state and therefore need the Origin gate.
 * `/_internal/*` (incl. `/_internal/shutdown`) and read-only `/_debug/state` are in
 * scope too — the shutdown route is the same hole class (§6.1). `/control` covers
 * the JSON-RPC control API and its live feed, whose snapshot exposes auth and
 * accounts state.
 *
 * `/settings/api` is retained belt-and-braces only: those routes were removed at
 * the core split and nothing serves the prefix today. The route-enumeration test
 * asserts it stays unserved, so it cannot quietly become a live-but-untested
 * surface again.
 *
 * There is no `/ws` entry: the browser-facing WebSocket this list once guarded
 * was removed with the rest of the UI cluster in the core split, and the feed it
 * carried is now JSON-RPC over `/control` (`routes/control/route.ts`).
 */
export const CSRF_GUARDED_PREFIXES = [
  "/settings/api",
  "/_internal",
  "/_debug/state",
  "/control",
] as const

/** Loopback hostnames a browser may report in an `Origin` for the local UI. */
const LOCALHOST_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]", // URL.hostname brackets IPv6 literals
])

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/")
}

/**
 * True if the request may proceed past the Origin gate.
 * - `origin === null` (no header) → true  — non-browser CLI callers (§6.6).
 * - `http://localhost:<port>` / `http://127.0.0.1:<port>` → true.
 * - anything else → false.
 *
 * Pure; the unit + mutation-test anchor for the gate.
 */
export function isAllowedOrigin(
  origin: string | null,
  boundPort: number,
): boolean {
  // No Origin header at all: the CLI/plugin/SDK invariant (§6.6). `Origin` is a
  // Forbidden header, so page JS can never suppress it — a missing one means a
  // non-browser caller, which we let through.
  if (origin === null) return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // Unparseable / opaque origin (e.g. the literal "null" a sandboxed iframe
    // sends) — treat as hostile.
    return false
  }
  if (!LOCALHOST_HOSTNAMES.has(url.hostname)) return false
  // A localhost UI is always served on an explicit port, so require an exact
  // match against the bound port — not a blanket "any localhost" allow (which
  // would let a page on another local port drive the control surface).
  return url.port === String(boundPort)
}

/** True if `path` falls under any guarded prefix (drives where the gate applies). */
export function isCsrfGuardedPath(path: string): boolean {
  return CSRF_GUARDED_PREFIXES.some((prefix) => pathMatchesPrefix(path, prefix))
}

export interface OriginGuardOptions {
  /** The sidecar's discovered bound port (NOT a literal 4141 — §1.1). */
  readonly boundPort: () => number
}

/** 403s a present, non-localhost `Origin` on any guarded path. */
export function createOriginGuardMiddleware(
  options: OriginGuardOptions,
): MiddlewareHandler {
  return async (c, next) => {
    if (
      isCsrfGuardedPath(c.req.path)
      && !isAllowedOrigin(c.req.header("origin") ?? null, options.boundPort())
    ) {
      return c.json(
        {
          error: {
            message: "Forbidden: cross-origin request to a control endpoint",
            type: "csrf_error",
          },
        },
        403,
      )
    }
    return next()
  }
}

/**
 * Tighten the global `cors()` from `*` to an explicit localhost allowlist. The
 * OPTIONS preflight is the load-bearing case (auth bypasses it). Returns the
 * option object for `hono/cors`'s `cors(...)`.
 */
export function buildCorsOptions(boundPort: () => number): {
  origin: (origin: string) => string | null
} {
  // hono/cors calls this with the request's `Origin`; echo it back (allow) only
  // for a localhost origin on the bound port, else return null (no
  // Access-Control-Allow-Origin header → the browser blocks the cross-origin read).
  return {
    origin: (origin: string) =>
      origin && isAllowedOrigin(origin, boundPort()) ? origin : null,
  }
}
