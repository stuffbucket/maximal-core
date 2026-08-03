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
import { streamSSE } from "hono/streaming"

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
import { type ControlHub, type ControlSink } from "~/lib/live/hub"
import { AsyncMutex } from "~/lib/live/mutex"
import {
  buildAccountsList,
  buildAppsList,
  buildModelsList,
  type ControlSnapshot,
} from "~/lib/live/resources"
import { getControlHub } from "~/lib/live/service"
import { cacheModels } from "~/lib/platform/utils"
import { emitQuitRequest, emitUpdateRequest } from "~/lib/start/boot-status"
import { getTokenUsageSummary } from "~/lib/token-usage"
import { getUpdateStatus } from "~/lib/update/update-check"

import { registerSettingsEndpoints } from "./settings-endpoints"

type HubAccessor = () => ControlHub<ControlSnapshot>

export interface ControlRoutesOptions {
  /** Injectable request-IP reader (tests simulate loopback / non-loopback). */
  getRequestIp?: (c: Context) => string | null
  /** Injectable hub (tests pass a fresh one; default is the wired singleton). */
  hub?: ControlHub<ControlSnapshot>
}

async function readKey(c: Context): Promise<string | null> {
  const body = (await c.req.json().catch(() => null)) as {
    key?: unknown
  } | null
  const key = body?.key
  return typeof key === "string" && key ? key : null
}

/** Live SSE stream. The hub's per-subscriber drain loop is the SOLE writer for
 *  the stream; the handler just holds it open until the client disconnects. */
function registerEventStream(app: HonoApp, hub: HubAccessor): void {
  app.get("/events", (c) => {
    const lastEventId = c.req.header("last-event-id")
    const epoch = c.req.query("epoch")
    return streamSSE(c, async (stream) => {
      const sink: ControlSink = {
        write: async (frame) => {
          await stream.write(frame)
        },
        close: () => {
          // The handler resolves on abort below; nothing to do here.
        },
      }
      const unsubscribe = await hub().subscribe(sink, { lastEventId, epoch })
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe()
          resolve()
        })
      })
    })
  })
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

  return app
}

export const controlRoutes = createControlRoutes()
