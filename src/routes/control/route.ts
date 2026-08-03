/**
 * /control/* — the decoupled control surface a UI (or third-party consumer)
 * uses to read state, drive actions, and receive a live event stream. Replaces
 * the removed /settings/api + /ws. See docs/spec/control-api.md.
 *
 * Loopback-only: the auth middleware treats /control as unauthenticated (no
 * proxy API key needed for a same-machine UI), so this router re-checks loopback
 * itself — a remote caller gets a 404, exactly like /_internal.
 */

import type { Context } from "hono"

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { getAuthStatus } from "~/lib/auth/auth-controller"
import { preflightCopilotError } from "~/lib/auth/copilot-preflight"
import {
  readDefaultRegistry,
  removeAccount,
  setActive,
  writeDefaultRegistry,
} from "~/lib/auth/github-token-store"
import { defaultGetRequestIp, isLoopbackAddress } from "~/lib/auth/request-auth"
import { getConfig } from "~/lib/config/config"
import { forwardError } from "~/lib/errors/error"
import { listActiveClients } from "~/lib/http/active-clients"
import { type ControlSink } from "~/lib/live/hub"
import { AsyncMutex } from "~/lib/live/mutex"
import {
  buildAccountsList,
  buildAppsList,
  buildModelsList,
} from "~/lib/live/resources"
import { getControlHub } from "~/lib/live/service"
import { getTokenUsageSummary } from "~/lib/token-usage"

export const controlRoutes = new Hono()

// Serialize every state-mutating action so no two interleave across their await
// chains (see docs/spec/control-api.md — mutation serialization).
const actionMutex = new AsyncMutex()

// Loopback gate for the whole surface.
controlRoutes.use("*", async (c, next) => {
  if (!isLoopbackAddress(defaultGetRequestIp(c as Context))) {
    return c.notFound()
  }
  await next()
})

async function readKey(c: Context): Promise<string | null> {
  const body = (await c.req.json().catch(() => null)) as {
    key?: unknown
  } | null
  const key = body?.key
  return typeof key === "string" && key ? key : null
}

// ── Live event stream ───────────────────────────────────────────────────────

controlRoutes.get("/events", (c) => {
  const hub = getControlHub()
  const lastEventId = c.req.header("last-event-id")
  const epoch = c.req.query("epoch")

  return streamSSE(c, async (stream) => {
    // The hub's per-subscriber drain loop is the SOLE writer for this stream.
    const sink: ControlSink = {
      write: async (frame) => {
        await stream.write(frame)
      },
      close: () => {
        // The handler resolves on abort below; nothing to do here.
      },
    }
    const unsubscribe = await hub.subscribe(sink, { lastEventId, epoch })
    // Hold the response open until the client disconnects; on abort, unsubscribe
    // (which stops the drain and cleans up the hub subscriber).
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe()
        resolve()
      })
    })
  })
})

// ── Reads (each mirrors a live topic) ───────────────────────────────────────

controlRoutes.get("/auth", (c) => c.json(getAuthStatus()))

controlRoutes.get("/accounts", async (c) => {
  try {
    return c.json(await buildAccountsList())
  } catch (error) {
    return forwardError(c, error)
  }
})

controlRoutes.get("/apps", async (c) => {
  try {
    return c.json(await buildAppsList())
  } catch (error) {
    return forwardError(c, error)
  }
})

controlRoutes.get("/models", (c) => c.json(buildModelsList()))

controlRoutes.get("/usage", async (c) => {
  try {
    return c.json(await getTokenUsageSummary("day"))
  } catch (error) {
    return forwardError(c, error)
  }
})

controlRoutes.get("/config", (c) => c.json(getConfig()))

controlRoutes.get("/clients", (c) => {
  const clients = listActiveClients()
  return c.json({ clients, total: clients.length })
})

// ── Actions (serialized; broadcast the resulting state) ─────────────────────
//
// NOTE: switch/remove edit maximal's persisted registry and broadcast the new
// accounts list. Making the RUNNING proxy adopt the new account without a
// restart (re-mint the Copilot token, refresh models, swap the in-memory trio)
// is the follow-up `activateAccount` work in the spec; today a reconnect/restart
// picks up the new active key.

controlRoutes.post("/accounts/switch", (c) =>
  actionMutex.runExclusive(async () => {
    try {
      const key = await readKey(c)
      if (!key) {
        return c.json({ error: { message: "Expected { key } string." } }, 400)
      }
      const reg = await readDefaultRegistry()
      if (!(key in reg.accounts)) {
        return c.json({ error: { message: `No account ${key}.` } }, 404)
      }
      const target = reg.accounts[key]
      const preflightError = await preflightCopilotError(
        target.token,
        target.login,
      )
      if (preflightError) {
        return c.json({ error: { message: preflightError } }, 422)
      }
      await writeDefaultRegistry(setActive(reg, key))
      getControlHub().emit("accounts", await buildAccountsList())
      return c.json({ ok: true, key })
    } catch (error) {
      return forwardError(c, error)
    }
  }),
)

controlRoutes.post("/accounts/remove", (c) =>
  actionMutex.runExclusive(async () => {
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
      getControlHub().emit("accounts", await buildAccountsList())
      return c.json({ ok: true, key, was_active: wasActive })
    } catch (error) {
      return forwardError(c, error)
    }
  }),
)
