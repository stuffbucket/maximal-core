/**
 * /control/* — the decoupled control surface a UI (or third-party consumer)
 * uses to read state, drive actions, and receive a live event stream. Replaces
 * the removed /settings/api + /ws. See docs/spec/control-api.md.
 *
 * Loopback-only: the auth middleware treats /control as unauthenticated (no
 * proxy API key needed for a same-machine UI), so this router re-checks loopback
 * itself — a remote caller gets a 404, exactly like /_internal.
 */

import type { Context, Hono as HonoApp } from "hono"

import { Hono } from "hono"
import { z } from "zod"

import {
  cancelDeviceFlow,
  getAuthStatus,
  rearmCopilotAuth,
  signOut,
  startDeviceFlow,
} from "~/lib/auth/auth-controller"
import { activateAccountLive } from "~/lib/auth/auth-recovery"
import {
  readDefaultRegistry,
  removeAccount,
  writeDefaultRegistry,
} from "~/lib/auth/github-token-store"
import { defaultGetRequestIp, isLoopbackAddress } from "~/lib/auth/request-auth"
import { getConfig } from "~/lib/config/config"
import { forwardError } from "~/lib/errors/error"
import { listActiveClients } from "~/lib/http/active-clients"
import { createRpcHandler } from "~/lib/jsonrpc/dispatch"
import { controlError } from "~/lib/jsonrpc/errors"
import { errorResponse } from "~/lib/jsonrpc/message"
import { type ControlHub } from "~/lib/live/hub"
import { AsyncMutex } from "~/lib/live/mutex"
import {
  buildAccountsList,
  buildAppsList,
  buildModelsList,
  type ControlSnapshot,
} from "~/lib/live/resources"
import { getControlHub } from "~/lib/live/service"
import { streamSubscription } from "~/lib/live/stream-subscription"
import { cacheModels } from "~/lib/platform/utils"
import { emitQuitRequest, emitUpdateRequest } from "~/lib/start/boot-status"
import { getTokenUsageSummary } from "~/lib/token-usage"
import { getUpdateStatus } from "~/lib/update/update-check"

import {
  createControlRpcMethods,
  SUPPORTED_PROTOCOL_VERSION,
  unsupportedVersion,
} from "./rpc"
import { registerSettingsEndpoints } from "./settings-endpoints"

type HubAccessor = () => ControlHub<ControlSnapshot>

export interface ControlRoutesOptions {
  /** Injectable request-IP reader (tests simulate loopback / non-loopback). */
  getRequestIp?: (c: Context) => string | null
  /** Injectable hub (tests pass a fresh one; default is the wired singleton). */
  hub?: ControlHub<ControlSnapshot>
}

/** Validated rather than cast: `c.req.json()` returns `any`, and asserting a
 *  shape onto it moves an untrusted payload into the type system unchecked. */
const keyBodySchema = z.object({ key: z.string().min(1) })

async function readKey(c: Context): Promise<string | null> {
  const parsed = keyBodySchema.safeParse(await c.req.json().catch(() => null))
  return parsed.success ? parsed.data.key : null
}

/**
 * Live SSE stream (deprecated — prefer the `subscriptions/listen` RPC).
 *
 * Retained for one cycle so existing consumers keep working, but it is no longer
 * resumable: `Last-Event-ID` and `epoch` are ignored because the hub no longer
 * rings frames. Every connect gets a fresh snapshot.
 */
function registerEventStream(app: HonoApp, hub: HubAccessor): void {
  app.get("/events", (c) => streamSubscription(c, hub))
}

/** Read endpoints — each mirrors a live topic and shares its type. */
function registerReads(app: HonoApp): void {
  app.get("/auth", (c) => c.json(getAuthStatus()))

  app.get("/accounts", async (c) => {
    try {
      return c.json(await buildAccountsList())
    } catch (error) {
      return forwardError(c, error)
    }
  })

  app.get("/apps", async (c) => {
    try {
      return c.json(await buildAppsList())
    } catch (error) {
      return forwardError(c, error)
    }
  })

  app.get("/models", (c) => c.json(buildModelsList()))

  app.get("/usage", async (c) => {
    try {
      return c.json(await getTokenUsageSummary("day"))
    } catch (error) {
      return forwardError(c, error)
    }
  })

  app.get("/config", (c) => c.json(getConfig()))

  app.get("/clients", (c) => {
    const clients = listActiveClients()
    return c.json({ clients, total: clients.length })
  })

  app.get("/update-status", async (c) => {
    try {
      return c.json(await getUpdateStatus())
    } catch (error) {
      return forwardError(c, error)
    }
  })
}

/**
 * GitHub auth flow — thin wrappers over the auth-controller state machine. The
 * UI POSTs /auth/start, renders the device code from the returned status, and
 * watches the live `auth` topic until the state flips. /cancel aborts without
 * signing out; /rearm self-heals a session that degraded (OS wake / focus).
 * /models/refresh forces a catalog refetch.
 */
function registerAuthActions(app: HonoApp): void {
  app.post("/auth/start", async (c) => {
    try {
      return c.json(await startDeviceFlow())
    } catch (error) {
      return forwardError(c, error)
    }
  })

  app.post("/auth/cancel", (c) => c.json(cancelDeviceFlow()))

  app.post("/auth/rearm", async (c) =>
    c.json({ outcome: await rearmCopilotAuth(), status: getAuthStatus() }),
  )

  app.post("/auth/sign-out", async (c) => {
    try {
      await signOut()
      return c.json({ ok: true })
    } catch (error) {
      return forwardError(c, error)
    }
  })

  app.post("/models/refresh", async (c) => {
    try {
      await cacheModels()
      return c.json(buildModelsList())
    } catch (error) {
      return forwardError(c, error)
    }
  })
}

/** Browser-tab quit / in-place upgrade — a UI with no native host POSTs these
 *  and the sidecar relays to a supervising shell over stdout. 409 on a plain
 *  CLI run (no shell to receive them). */
function registerShellSignals(app: HonoApp): void {
  app.post("/quit", (c) => {
    if (emitQuitRequest()) return c.json({ ok: true, quitting: true }, 202)
    return c.json({ ok: false, reason: "no_supervising_shell" }, 409)
  })

  app.post("/upgrade", (c) => {
    if (emitUpdateRequest()) return c.json({ ok: true, upgrading: true }, 202)
    return c.json({ ok: false, reason: "no_supervising_shell" }, 409)
  })
}

/**
 * Account switch/remove — serialized through the mutex; broadcast the new
 * accounts list on success. /switch adopts the account in the RUNNING proxy
 * live via activateAccountLive (mint + commit + refresh + emit); /remove only
 * edits the persisted registry (a reconnect/restart drops a removed active key).
 */
function registerAccountActions(
  app: HonoApp,
  hub: HubAccessor,
  mutex: AsyncMutex,
): void {
  app.post("/accounts/switch", (c) =>
    mutex.runExclusive(async () => {
      try {
        const key = await readKey(c)
        if (!key) {
          return c.json({ error: { message: "Expected { key } string." } }, 400)
        }
        // Live switch: mint the Copilot token, commit active, refresh models,
        // emit auth.changed — the running proxy adopts the account, no restart.
        const result = await activateAccountLive(key)
        if (!result.ok) {
          return c.json({ error: { message: result.message } }, result.status)
        }
        hub().emit("accounts", await buildAccountsList())
        return c.json({ ok: true, key })
      } catch (error) {
        return forwardError(c, error)
      }
    }),
  )

  app.post("/accounts/remove", (c) =>
    mutex.runExclusive(async () => {
      try {
        const key = await readKey(c)
        if (!key) {
          return c.json({ error: { message: "Expected { key } string." } }, 400)
        }
        const reg = await readDefaultRegistry()
        if (!(key in reg.accounts)) {
          return c.json({ error: { message: `No account ${key}.` } }, 404)
        }
        const wasActive = reg.activeKey === key
        await writeDefaultRegistry(removeAccount(reg, key))
        hub().emit("accounts", await buildAccountsList())
        return c.json({ ok: true, key, was_active: wasActive })
      } catch (error) {
        return forwardError(c, error)
      }
    }),
  )
}

/**
 * JSON-RPC control plane (ADR-0023). One POST endpoint, stateless, no session.
 *
 * The hub- and mutex-dependent methods are composed here rather than in the
 * static registry because they need the same injected accessors the REST
 * account actions use — and they call the SAME underlying operations, so the two
 * surfaces cannot diverge while both exist.
 */
function registerRpc(app: HonoApp, hub: HubAccessor, mutex: AsyncMutex): void {
  const dispatch = createRpcHandler(createControlRpcMethods({ hub, mutex }))

  app.post("/rpc", async (c) => {
    // A client that pins a version we don't speak gets told so explicitly,
    // rather than failing later on a shape it didn't expect (maximal-core#8).
    const pinned = unsupportedVersion(c)
    if (pinned !== null) {
      return c.json(
        errorResponse(
          undefined,
          controlError(
            "unsupported_version",
            `Unsupported protocol version ${pinned}; this sidecar speaks ${SUPPORTED_PROTOCOL_VERSION}.`,
          ),
        ),
        400,
      )
    }
    return dispatch(c)
  })

  // The transport is POST-only; GET/DELETE were the session-era verbs MCP
  // removed in 2026-07-28 and we never had.
  app.on(["GET", "DELETE"], "/rpc", (c) => c.body(null, 405))
}

export function createControlRoutes(options: ControlRoutesOptions = {}): Hono {
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp
  // Resolved lazily so importing this module doesn't eagerly build the wired
  // hub (with its flush timer). Tests inject their own.
  const hub: HubAccessor = () => options.hub ?? getControlHub()
  const app = new Hono()

  // Loopback gate for the whole surface.
  app.use("*", async (c, next) => {
    if (!isLoopbackAddress(getRequestIp(c as Context))) {
      return c.notFound()
    }
    await next()
  })

  registerEventStream(app, hub)
  registerReads(app)
  registerAuthActions(app)
  registerSettingsEndpoints(app)
  registerShellSignals(app)
  registerAccountActions(app, hub, new AsyncMutex())
  registerRpc(app, hub, new AsyncMutex())

  return app
}

export const controlRoutes = createControlRoutes()
