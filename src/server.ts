import consola from "consola"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import {
  buildCorsOptions,
  createOriginGuardMiddleware,
} from "./lib/auth/origin-guard"
import {
  createAuthMiddleware,
  requireGithubAuth,
} from "./lib/auth/request-auth"
import { traceIdMiddleware } from "./lib/http/trace"
import { staleRefreshMiddleware } from "./lib/models/refresh-models"
import { cacheModels } from "./lib/platform/utils"
import { getModelsLoadedAtMs, state } from "./lib/runtime-state/state"
import { buildStatus } from "./lib/runtime-state/status"
import { BUILD_VERSION } from "./lib/update/build-info"
import { requireSupportedBuild } from "./lib/update/version-gate"
import { completionRoutes } from "./routes/chat-completions/route"
import { controlRoutes } from "./routes/control/route"
import { debugRoutes } from "./routes/debug/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { internalRoutes } from "./routes/internal/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { productApiRoutes } from "./routes/product-api"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { usageRoute } from "./routes/usage/route"

/**
 * The two listeners (maximal-core#10).
 *
 * Third-party tools hardcode `http://127.0.0.1:4141/v1`, so the data plane needs
 * a well-known port. The control plane — auth, config, models, live events — is
 * sensitive and should not sit anywhere guessable. One listener cannot satisfy
 * both, so they are separated at the port level: `publicApp` on 4141 (with a
 * prefer-then-fall-back policy), `controlApp` on an ephemeral port the
 * supervisor learns from the ready-line.
 *
 * Separation is **structural, not a path filter**. `/v1` is never mounted on the
 * control app, so it cannot be reached there by any request-shaping trick — the
 * property the issue asks for is a fact about the route table rather than a
 * check somebody could regress.
 */
export const publicApp = new Hono()
export const controlApp = new Hono()

/** Captured at module load — anchors the `/status` uptime to "when the
 *  server module first ran," which is what callers mean by "how long has
 *  Maximal been up." */
const SERVER_START_MS = Date.now()

// Control-surface hardening (§6, ADR-0021). Read lazily per request —
// `runServer` sets the resolved ports before binding, and in-memory tests fall
// back to the 4141 default.
//
// Keyed on the CONTROL port on BOTH listeners, deliberately: the only browser
// page that has any business driving a guarded prefix is one served from the
// control origin, so that is what "us" means here. It is not the case that every
// CSRF_GUARDED_PREFIX lives on the control listener — `/_internal` is mounted on
// `publicApp` (see the `/_internal` comment below) — which makes this stricter
// than a per-listener key, not looser: a page served from the public port is not
// an allowed origin either, and gets a 403 on `/_internal/shutdown`.
const controlPort = (): number => state.controlPort

/**
 * Middleware every listener shares, applied identically to both.
 *
 * One applier rather than two stacks: the alternative is two copies that drift,
 * and a drifted auth or origin stack is a security bug rather than a cosmetic
 * one. Paths that do not exist on a given app simply 404 after passing through,
 * so listing all of them here is harmless.
 */
function applyCommonMiddleware(app: Hono): void {
  app.use(traceIdMiddleware)
  // Stamp the proxy build version on every response so downstream clients
  // can read which Maximal build served their request without hitting a
  // separate endpoint. Value is a static build constant — no per-request cost,
  // no secrets. Set before next() so it applies to c.res on the way out.
  app.use(async (c, next) => {
    c.header("x-maximal-version", BUILD_VERSION)
    await next()
  })
  app.use(logger())
  // CORS narrowed from `*` to a localhost allowlist. The OPTIONS preflight is the
  // load-bearing case (auth bypasses OPTIONS), so a `*` here would let any origin
  // preflight-probe the control surface.
  app.use(cors(buildCorsOptions(controlPort)))
  // Reject any present, non-localhost `Origin` on the control prefixes.
  // A missing Origin passes (the CLI/plugin/SDK invariant, §6.6). Mounted before
  // auth so a cross-origin browser request is refused regardless of any key.
  app.use(createOriginGuardMiddleware({ boundPort: controlPort }))
  app.use(
    "*",
    createAuthMiddleware({
      allowUnauthenticatedPaths: [
        "/",
        "/status",
        "/_debug/state",
        "/setup-status",
        // The product-API OpenAPI document is a public spec (no secrets),
        // served alongside the fresh-install `/setup-status` surface.
        "/openapi.json",
      ],
      // The /control/* surface is for a same-machine UI. It's exempt from the
      // API-key dance; the control router enforces loopback itself (a remote
      // caller gets 404) and the Origin guard 403s cross-origin browser requests.
      allowUnauthenticatedPrefixes: ["/control"],
      // Loopback callers on the same machine skip the API-key dance for these
      // local-only endpoints; remote callers still need a valid API key.
      loopbackOnlyPaths: [
        "/usage",
        "/token-usage",
        "/token-usage/events",
        // Graceful eviction: a second `maximal start --replace` POSTs here to ask
        // the running instance to release the port. The route handler *also*
        // enforces loopback (a remote caller with a valid API key must NOT be
        // able to evict the running instance); listing it here just skips the
        // auth dance for the local caller.
        "/_internal/shutdown",
      ],
    }),
  )

  // L1a model-cache lazy refresh. Runs after auth so unauthenticated
  // probes ("/", "/usage-viewer") don't count as activity. Fire-and-
  // forget; the triggering request continues with the slightly stale
  // cache. See docs/spec/model-protocol-strategy.md.
  app.use(
    "*",
    staleRefreshMiddleware({
      getLoadedAtMs: getModelsLoadedAtMs,
      refresh: cacheModels,
      onError: (err) =>
        consola.warn(
          "Background models refresh failed; keeping stale cache",
          err,
        ),
    }),
  )
}

applyCommonMiddleware(publicApp)
applyCommonMiddleware(controlApp)

// ── Control listener ────────────────────────────────────────────────────────
// The decoupled control API + live event stream for a same-machine UI.
// Loopback-gated inside the router. See src/routes/control/route.ts.
controlApp.route("/control", controlRoutes)
// Diagnostics move here with the control surface: `/_debug/state` is a
// CSRF-guarded prefix, and keeping it off the well-known port is the point of
// the split. A CLI user finds this port in the boot banner.
controlApp.route("/_debug", debugRoutes)

// ── Public listener ─────────────────────────────────────────────────────────
// The identity probe. `probePort` (src/lib/start/port.ts) keys off this exact
// body to tell another maximal from a foreign process, so it must stay on the
// PUBLIC port — that is the one a second instance contends for.
publicApp.get("/", (c) => c.text("Server running"))

// Identity + liveness probe. Unauthenticated and loopback-friendly so a
// local caller (the Claude Code shim, a health check, a script) can ask
// "is the thing on :4141 actually Maximal, is it up, and is it ready to
// serve?" without an API key. The `service: "maximal"` field is the
// unambiguous identity marker the shim keys off; `subsystems` namespaces
// per-part health so new subsystems slot in without reshaping the
// contract. Safe-for-unauth only (booleans/tiers/counts, no secrets);
// see src/lib/runtime-state/status.ts. Cheap: in-memory state, no upstream calls.
publicApp.get("/status", (c) => c.json(buildStatus(SERVER_START_MS)))

// Stays public deliberately: `evictRunning` takes over the public port by
// POSTing /_internal/shutdown *to that port*. Moving it to the control listener
// would break `--replace`, since the evicting process does not know the
// occupant's ephemeral control port.
publicApp.route("/_internal", internalRoutes)
// The maximal-specific product API surface: `/setup-status` plus its
// route-bound OpenAPI document at `/openapi.json`. See routes/product-api.ts.
publicApp.route("/", productApiRoutes)

/**
 * The upstream-touching route set — everything that forwards to GitHub Copilot.
 *
 * Listed once because two middlewares gate exactly this set and must never
 * drift apart: `requireSupportedBuild` (is this build still allowed to proxy?)
 * and `requireGithubAuth` (do we hold a credential to proxy with?). Order is
 * deliberate — a retired build gets the force-upgrade error even when it is
 * also signed out, because "sign in" is not the actionable remedy there.
 *
 * Nothing outside this list is gated: `/`, `/status`, `/setup-status`,
 * `/openapi.json`, `/usage`, `/token-usage`, `/_internal`, and the entire
 * control listener stay reachable, so a blocked user can still see why and
 * still drive an upgrade.
 */
const UPSTREAM_ROUTES = [
  "/chat/completions",
  "/chat/completions/*",
  "/models",
  "/models/*",
  "/embeddings",
  "/embeddings/*",
  "/responses",
  "/responses/*",
  "/v1/*",
  "/:provider/v1/*",
]

for (const path of UPSTREAM_ROUTES) {
  // Force-upgrade lever (#7). Fail-open and synchronous — see version-gate.ts.
  publicApp.use(path, requireSupportedBuild)
  // Gate on the presence of a GitHub token. When the engine boots without one,
  // the HTTP server still listens (so a supervisor can drive sign-in over
  // `/control`, and `maximal auth` can run alongside) but the proxy endpoints
  // 401 with `not_authenticated` instead of crashing or firing the device-code
  // flow.
  publicApp.use(path, requireGithubAuth)
}

publicApp.route("/chat/completions", completionRoutes)
publicApp.route("/models", modelRoutes)
publicApp.route("/embeddings", embeddingRoutes)
publicApp.route("/usage", usageRoute)
publicApp.route("/token-usage", tokenUsageRoute)
publicApp.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
publicApp.route("/v1/chat/completions", completionRoutes)
publicApp.route("/v1/models", modelRoutes)
publicApp.route("/v1/embeddings", embeddingRoutes)
publicApp.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
publicApp.route("/v1/messages", messageRoutes)

// Provider scoped Anthropic-compatible endpoints
publicApp.route("/:provider/v1/messages", providerMessageRoutes)
publicApp.route("/:provider/v1/models", providerModelRoutes)
