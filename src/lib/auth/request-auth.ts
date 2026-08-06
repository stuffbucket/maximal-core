import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { getConfig, type AppConfig } from "~/lib/config/config"
import { recordClient } from "~/lib/http/active-clients"
import { hasGithubToken, state } from "~/lib/runtime-state/state"

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  /**
   * Resolver for the "block unknown connections" flag. When it returns
   * false (the default), the middleware allows every request and only
   * uses `getApiKeys()` for attribution. Injectable for tests.
   */
  isEnforcing?: () => boolean
  allowUnauthenticatedPaths?: Array<string>
  /**
   * Path prefixes that bypass auth entirely. `/control` is the only caller:
   * it is a same-machine surface protected by the loopback-only bind, the
   * control router's own peer-IP 404, and the Origin guard, so it never takes
   * part in the API-key dance.
   *
   * There is deliberately no "…except these sub-prefixes" escape hatch. The
   * `requireAuthPrefixes` / `alwaysEnforcePrefixes` options that used to sit
   * here were the `/settings/api` hardening levers from ADR-0021 §6.2; that
   * surface was removed at the core split, `server.ts` passed neither, and
   * unreachable auth configuration is a liability on a security path. Bring one
   * back with the caller that needs it, not before.
   */
  allowUnauthenticatedPrefixes?: Array<string>
  allowOptionsBypass?: boolean
  /**
   * Paths that should skip auth when the request comes from loopback
   * (127.0.0.1, ::1, ::ffff:127.0.0.1). Used to exempt the local usage
   * dashboard from needing an API key while keeping the same endpoints
   * authenticated for any non-loopback caller.
   */
  loopbackOnlyPaths?: Array<string>
  /**
   * Resolves the peer IP for the current request. Injectable so tests
   * can simulate loopback vs. non-loopback requests without spinning up
   * a real Bun.serve / Node http.Server.
   */
  getRequestIp?: (c: Context) => string | null
}

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/")
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false
  return LOOPBACK_IPS.has(address)
}

/**
 * Reads the peer IP off the raw Request object. srvx attaches `ip` to
 * the request for both its Bun and Node adapters
 * (Bun: `server.requestIP(req).address`; Node: `req.socket.remoteAddress`),
 * so the same field works for our deployment paths.
 */
export function defaultGetRequestIp(c: Context): string | null {
  const raw = c.req.raw as Request & { ip?: string | null }
  return raw.ip ?? null
}

export function normalizeApiKeys(apiKeys: unknown): Array<string> {
  if (!Array.isArray(apiKeys)) {
    if (apiKeys !== undefined) {
      consola.warn("Invalid auth.apiKeys config. Expected an array of strings.")
    }
    return []
  }

  const normalizedKeys = apiKeys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)

  if (normalizedKeys.length !== apiKeys.length) {
    consola.warn(
      "Invalid auth.apiKeys entries found. Only non-empty strings are allowed.",
    )
  }

  return [...new Set(normalizedKeys)]
}

export function getConfiguredApiKeys(
  config: AppConfig = getConfig(),
): Array<string> {
  const legacy = normalizeApiKeys(config.auth?.apiKeys)
  const entries = config.auth?.apiKeyEntries ?? []
  const fromEntries = entries
    .filter((e) => e.enabled)
    .map((e) => e.key.trim())
    .filter((k) => k.length > 0)
  return [...new Set([...legacy, ...fromEntries])]
}

/**
 * Match an incoming request key against the configured allow list.
 * Only consulted when enforcement is on; the entry list is otherwise
 * used purely for connection labeling, not for blocking.
 */
export function apiKeyAllowed(
  allowList: Array<string>,
  requestKey: string,
): boolean {
  if (requestKey.length === 0) return false
  return allowList.includes(requestKey)
}

/**
 * Locate the configured API-key entry that the incoming request key
 * resolves to, so the caller can attribute usage to a named client.
 * Returns null when no entry matches.
 */
export function findApiKeyEntry(
  requestKey: string,
): { id: string; label: string } | null {
  if (requestKey.length === 0) return null
  const config = getConfig()
  const entries = config.auth?.apiKeyEntries ?? []
  const match = entries.find((e) => e.enabled && e.key === requestKey)
  return match ? { id: match.id, label: match.label } : null
}

export function extractRequestApiKey(c: Context): string | null {
  const xApiKey = c.req.header("x-api-key")?.trim()
  if (xApiKey) {
    return xApiKey
  }

  const authorization = c.req.header("authorization")
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/)
    if (scheme.toLowerCase() === "bearer") {
      const bearerToken = rest.join(" ").trim()
      if (bearerToken) return bearerToken
    }
  }

  // No query-string `?key=` fallback anywhere: the header paths above are the
  // only ways to authenticate a proxy/control request, so keys never leak into
  // request URLs or logs. The live feed is JSON-RPC over the control listener
  // (`routes/control/route.ts`, transport in `lib/live/`), not a browser
  // WebSocket, so nothing needs a URL-borne credential here.
  return null
}

/**
 * Shell-internal key match. When a desktop shell spawns the sidecar it injects
 * MAXIMAL_SHELL_KEY as env; a request carrying that exact key bypasses the
 * enforce flag so a user who turns on "Block unknown connections" can't lock
 * their own shell out. Core itself never sets it.
 */
function isShellKey(requestApiKey: string | null): boolean {
  return (
    requestApiKey !== null
    && state.shellApiKey !== undefined
    && requestApiKey === state.shellApiKey
  )
}

function createUnauthorizedResponse(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    {
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  const getApiKeys = options.getApiKeys ?? getConfiguredApiKeys
  const isEnforcing =
    options.isEnforcing ?? (() => getConfig().auth?.enforce === true)
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowUnauthenticatedPrefixes =
    options.allowUnauthenticatedPrefixes ?? []
  const allowOptionsBypass = options.allowOptionsBypass ?? true
  const loopbackOnlyPaths = options.loopbackOnlyPaths ?? []
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp

  const shouldBypass = (c: Context): boolean => {
    if (allowOptionsBypass && c.req.method === "OPTIONS") return true
    if (allowUnauthenticatedPaths.includes(c.req.path)) return true
    const path = c.req.path
    if (allowUnauthenticatedPrefixes.some((p) => pathMatchesPrefix(path, p))) {
      return true
    }
    // Loopback exemption: the local usage dashboard hits these endpoints
    // same-machine and shouldn't need a key; non-loopback callers still
    // get gated normally.
    if (
      loopbackOnlyPaths.includes(c.req.path)
      && isLoopbackAddress(getRequestIp(c))
    ) {
      return true
    }
    return false
  }

  const decideAuth = (requestApiKey: string | null): AuthDecision => {
    if (isShellKey(requestApiKey)) {
      return { allow: true, id: null, label: "Maximal Settings" }
    }
    if (!isEnforcing()) {
      const entry = requestApiKey ? findApiKeyEntry(requestApiKey) : null
      return { allow: true, id: entry?.id ?? null, label: entry?.label ?? null }
    }
    if (!requestApiKey || !apiKeyAllowed(getApiKeys(), requestApiKey)) {
      return { allow: false }
    }
    const entry = findApiKeyEntry(requestApiKey)
    return { allow: true, id: entry?.id ?? null, label: entry?.label ?? null }
  }

  return async (c, next) => {
    if (shouldBypass(c)) return next()
    const decision = decideAuth(extractRequestApiKey(c))
    if (!decision.allow) return createUnauthorizedResponse(c)
    recordClient({
      apiKeyId: decision.id,
      apiKeyLabel: decision.label,
      userAgent: c.req.header("user-agent") ?? "",
    })
    return next()
  }
}

type AuthDecision =
  | { allow: true; id: string | null; label: string | null }
  | { allow: false }

/**
 * Gate for routes that forward to the GitHub Copilot upstream. Orthogonal
 * to {@link createAuthMiddleware} (which validates the *client's* API key);
 * this one short-circuits when the proxy itself has no GitHub token to
 * forward with. Lets the HTTP server come up in "unauthenticated mode"
 * (the `/control` surface and `/status` still reachable) so a supervisor can
 * drive sign-in on demand, instead of crashing or firing the device-code flow.
 */
export const requireGithubAuth: MiddlewareHandler = async (c, next) => {
  if (hasGithubToken()) {
    return next()
  }
  return c.json(
    {
      error: "not_authenticated",
      // Name something core actually has. There is no Settings UI here: the CLI
      // flow is `maximal auth`, and a supervisor drives the same flow over the
      // control listener.
      hint: "Run `maximal auth` to sign in, or start the flow over the /control API.",
    },
    401,
  )
}
