/**
 * JSON-RPC method registry for the control plane (ADR-0023, maximal-core#4/#8).
 *
 * Every method projects an operation the REST control routes already expose —
 * the underlying calls are shared, not reimplemented, so the two surfaces cannot
 * drift while the REST paths remain during the deprecation cycle.
 *
 * Naming follows the vocabulary fixed in maximal-core#4 (`server/discover`,
 * `auth/status`, `config/get`, `health`, …) rather than anything invented here,
 * so the Electron client codes against one agreed method set.
 */
import type { Context } from "hono"

import type { RpcRegistry } from "~/lib/jsonrpc/dispatch"
import type { ControlHub } from "~/lib/live/hub"
import type { AsyncMutex } from "~/lib/live/mutex"
import type { ControlSnapshot } from "~/lib/live/resources"

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
import { getConfig } from "~/lib/config/config"
import { listActiveClients } from "~/lib/http/active-clients"
import { RpcParamsError } from "~/lib/jsonrpc/errors"
import { CONTROL_PROTOCOL_VERSION } from "~/lib/live/contract"
import {
  buildAccountsList,
  buildAppsList,
  buildModelsList,
} from "~/lib/live/resources"
import { cacheModels } from "~/lib/platform/utils"
import { emitQuitRequest, emitUpdateRequest } from "~/lib/start/boot-status"
import { getTokenUsageSummary } from "~/lib/token-usage"
import { BUILD_VERSION } from "~/lib/update/build-info"
import { getUpdateStatus } from "~/lib/update/update-check"

/** Header a client mirrors its `protocolVersion` into (maximal-core#8). Named in
 *  the MCP style because ADR-0023 aligns on the stateless *shape*; it is our
 *  version, not MCP's. */
export const PROTOCOL_VERSION_HEADER = "mcp-protocol-version"

/** The single supported wire version. A client discovers this via
 *  `server/discover` and pins to it; a mismatch is reported legibly rather than
 *  crashing (#8). */
export const SUPPORTED_PROTOCOL_VERSION = String(CONTROL_PROTOCOL_VERSION)

export interface ControlRpcDeps {
  hub: () => ControlHub<ControlSnapshot>
  mutex: AsyncMutex
}

/** Both account methods take `{ key }`; validated once so the two call sites
 *  cannot disagree about the shape. */
function keyFromParams(params: unknown): string {
  const key = (params as { key?: unknown } | null | undefined)?.key
  if (typeof key !== "string" || !key) {
    throw new RpcParamsError("Expected { key } string.")
  }
  return key
}

/**
 * Shell-relay signals. The REST routes answer 202/409; over RPC the same
 * distinction is carried in the result rather than a status, because clients
 * discriminate on the payload and never on HTTP (ADR-0023).
 */
function relayToShell(emit: () => boolean, verb: "quitting" | "upgrading") {
  return () =>
    emit() ?
      { ok: true, [verb]: true }
    : { ok: false, reason: "no_supervising_shell" as const }
}

/**
 * Build the full method registry.
 *
 * This is a factory rather than a module constant because `server/discover` must
 * advertise the *effective* method set — including the hub- and mutex-dependent
 * account methods. A static constant under-reported them, which silently broke
 * feature detection: a client that trusts `capabilities.methods` would never
 * call `accounts/switch` even though it dispatches fine.
 */
export function createControlRpcMethods(deps: ControlRpcDeps): RpcRegistry {
  const { hub, mutex } = deps

  const registry: RpcRegistry = {
    health: () => ({ ok: true, version: BUILD_VERSION }),

    // Reads. Each mirrors a live feed topic and shares its builder, so a
    // snapshot read and a pushed update can never describe different shapes.
    "auth/status": () => getAuthStatus(),
    "accounts/list": () => buildAccountsList(),
    "apps/list": () => buildAppsList(),
    "models/list": () => buildModelsList(),
    "usage/get": () => getTokenUsageSummary("day"),
    "config/get": () => getConfig(),
    "clients/list": () => {
      const clients = listActiveClients()
      return { clients, total: clients.length }
    },
    "update/status": () => getUpdateStatus(),

    // Auth actions. `auth/status` returns ADR-0006's discriminated union, so
    // these deliberately return the same union rather than a parallel vocabulary.
    "auth/start": () => startDeviceFlow(),
    "auth/cancel": () => cancelDeviceFlow(),
    "auth/rearm": async () => ({
      outcome: await rearmCopilotAuth(),
      status: getAuthStatus(),
    }),
    "auth/signOut": async () => {
      await signOut()
      return { ok: true }
    },

    "models/refresh": async () => {
      await cacheModels()
      return buildModelsList()
    },

    // Account mutations, serialized through the same mutex the REST routes use
    // so an RPC switch and a REST switch can never interleave.
    "accounts/switch": (params: unknown) =>
      mutex.runExclusive(async () => {
        const key = keyFromParams(params)
        const result = await activateAccountLive(key)
        if (!result.ok) throw new RpcParamsError(result.message)
        hub().emit("accounts", await buildAccountsList())
        return { ok: true, key }
      }),

    "accounts/remove": (params: unknown) =>
      mutex.runExclusive(async () => {
        const key = keyFromParams(params)
        const reg = await readDefaultRegistry()
        if (!(key in reg.accounts)) {
          throw new RpcParamsError(`No account ${key}.`)
        }
        const wasActive = reg.activeKey === key
        await writeDefaultRegistry(removeAccount(reg, key))
        hub().emit("accounts", await buildAccountsList())
        return { ok: true, key, was_active: wasActive }
      }),

    "app/quit": relayToShell(emitQuitRequest, "quitting"),
    "app/upgrade": relayToShell(emitUpdateRequest, "upgrading"),
  }

  // Stateless capability discovery: callable at any time, no prior handshake and
  // no session. MCP removed `initialize` in 2026-07-28 and ADR-0023 follows that
  // shape deliberately. Closes over `registry` so it can never under-report.
  return {
    ...registry,
    "server/discover": () => ({
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      capabilities: {
        methods: [...Object.keys(registry), "server/discover"].sort(),
        feed: true,
      },
      identity: { name: "maximal-core", version: BUILD_VERSION },
    }),
  }
}

/**
 * Reject a request that pins an unsupported protocol version.
 *
 * A missing header is allowed: `server/discover` is how a client learns the
 * version, and requiring the header on the very call that discovers it would be
 * circular. Present-but-wrong is the case worth failing loudly on (#8).
 */
export function unsupportedVersion(c: Context): string | null {
  const pinned = c.req.header(PROTOCOL_VERSION_HEADER)
  if (pinned === undefined || pinned === SUPPORTED_PROTOCOL_VERSION) return null
  return pinned
}
