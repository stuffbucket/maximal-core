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

export const server = new Hono()

/** Captured at module load — anchors the `/status` uptime to "when the
 *  server module first ran," which is what callers mean by "how long has
 *  Maximal been up." */
const SERVER_START_MS = Date.now()

server.use(traceIdMiddleware)
// Stamp the proxy build version on every response so downstream clients
// can read which Maximal build served their request without hitting a
// separate endpoint. Global (right after trace) means it lands on
// completion responses, /status, /settings/api/*, redirects, and errors
// alike. Value is a static build constant — no per-request cost, no
// secrets. Set before next() so it applies to c.res on the way out.
server.use(async (c, next) => {
  c.header("x-maximal-version", BUILD_VERSION)
  await next()
})
server.use(logger())
// Control-surface hardening (§6, ADR-0021). `boundPort` is read lazily per
// request — `runServer` sets `state.boundPort` from the resolved `--port` before
// it binds, and in-memory tests fall back to the 4141 default.
const boundPort = (): number => state.boundPort
// CORS narrowed from `*` to a localhost allowlist. The OPTIONS preflight is the
// load-bearing case (auth bypasses OPTIONS), so a `*` here would let any origin
// preflight-probe the control surface.
server.use(cors(buildCorsOptions(boundPort)))
// Reject any present, non-localhost `Origin` on the control prefixes
// (`/settings/api`, `/_internal`, `/_debug/state`) — including `/_internal/shutdown`.
// A missing Origin passes (the CLI/plugin/SDK invariant, §6.6). Mounted before
// auth so a cross-origin browser request is refused regardless of any key.
server.use(createOriginGuardMiddleware({ boundPort }))
server.use(
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
    // The /control/* surface (control API + SSE event stream) is for a
    // same-machine UI. It's exempt from the API-key dance; the control router
    // enforces loopback itself (a remote caller gets 404) and the Origin guard
    // 403s cross-origin browser requests.
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
server.use(
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

server.get("/", (c) => c.text("Server running"))

// Identity + liveness probe. Unauthenticated and loopback-friendly so a
// local caller (the Claude Code shim, a health check, a script) can ask
// "is the thing on :4141 actually Maximal, is it up, and is it ready to
// serve?" without an API key. The `service: "maximal"` field is the
// unambiguous identity marker the shim keys off; `subsystems` namespaces
// per-part health so new subsystems slot in without reshaping the
// contract. Safe-for-unauth only (booleans/tiers/counts, no secrets);
// see src/lib/status.ts. Cheap: in-memory state, no upstream calls.
server.get("/status", (c) => c.json(buildStatus(SERVER_START_MS)))

server.route("/_debug", debugRoutes)
server.route("/_internal", internalRoutes)
// The decoupled control API + live SSE event stream for a same-machine UI.
// Loopback-gated inside the router. See src/routes/control/route.ts.
server.route("/control", controlRoutes)
// The maximal-specific product API surface: `/setup-status` plus its
// route-bound OpenAPI document at `/openapi.json`. See routes/product-api.ts.
server.route("/", productApiRoutes)

// Gate every upstream-touching route on the presence of a GitHub token.
// When the sidecar boots without one, the HTTP server still listens (so
// the desktop shell can load Settings and trigger auth on demand) but the
// proxy endpoints 401 with `not_authenticated` instead of crashing or
// firing the device-code flow.
server.use("/chat/completions", requireGithubAuth)
server.use("/chat/completions/*", requireGithubAuth)
server.use("/models", requireGithubAuth)
server.use("/models/*", requireGithubAuth)
server.use("/embeddings", requireGithubAuth)
server.use("/embeddings/*", requireGithubAuth)
server.use("/responses", requireGithubAuth)
server.use("/responses/*", requireGithubAuth)
server.use("/v1/*", requireGithubAuth)
server.use("/:provider/v1/*", requireGithubAuth)

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token-usage", tokenUsageRoute)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Provider scoped Anthropic-compatible endpoints
server.route("/:provider/v1/messages", providerMessageRoutes)
server.route("/:provider/v1/models", providerModelRoutes)
