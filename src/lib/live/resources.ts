/**
 * Read/aggregation helpers for the control API, re-homed into lib/ from the
 * deleted routes/settings/* and lib/ws/live-feed.ts (see docs/spec/control-api.md
 * — "re-homing checklist"). These are the reusable core the control endpoints
 * and the live-feed snapshot are both built from; keeping them here (not in a
 * route) means the ControlHub can compose them without a lib -> routes edge.
 *
 * All field mappings are preserved byte-for-byte from the originals so a GET
 * body and a live delta carry the identical shape.
 */

import type { AuthStatus } from "~/lib/config/settings-types"
import type {
  AccountsListResponse,
  AppsListResponse,
  ModelsListResponse,
  ModelSummary,
} from "~/lib/config/settings-types"
import type { Model } from "~/services/copilot/get-models"

import { getAllApps } from "~/apps/registry"
import { getAuthStatus } from "~/lib/auth/auth-controller"
import {
  listAccounts,
  readDefaultRegistry,
} from "~/lib/auth/github-token-store"
import { listActiveClients } from "~/lib/http/active-clients"
import { getModelsLoadedAtMs, state } from "~/lib/runtime-state/state"
import { getTokenUsageSummary } from "~/lib/token-usage"

/** The `/control/accounts` body, from maximal's on-disk registry. */
export async function buildAccountsList(): Promise<AccountsListResponse> {
  const reg = await readDefaultRegistry()
  const accounts = listAccounts(reg).map((account) => ({
    key: account.key,
    login: account.login,
    host: account.host,
    added_via: account.addedVia,
    obtained_at: account.obtainedAt,
    active: account.active,
  }))
  return { accounts, active_key: reg.activeKey }
}

/** The `/control/apps` body — every registered client app's live details. */
export async function buildAppsList(): Promise<AppsListResponse> {
  const apps = await Promise.all(getAllApps().map((app) => app.getDetails()))
  return { apps }
}

/** Flatten an upstream `Model` into the UI-shaped summary. Optional upstream
 *  fields collapse to null/false so the contract stays total. */
function toModelSummary(model: Model): ModelSummary {
  const capabilities =
    (model as { capabilities?: Partial<Model["capabilities"]> }).capabilities
    ?? {}
  const limits = capabilities.limits ?? {}
  const supports = capabilities.supports ?? {}
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    family: capabilities.family ?? "",
    type: capabilities.type ?? "",
    preview: model.preview,
    context_window_tokens: limits.max_context_window_tokens ?? null,
    max_output_tokens: limits.max_output_tokens ?? null,
    capabilities: {
      vision: supports.vision ?? false,
      tool_calls: supports.tool_calls ?? false,
      streaming: supports.streaming ?? false,
      reasoning:
        (supports.adaptive_thinking ?? false)
        || (supports.reasoning_effort?.length ?? 0) > 0,
    },
  }
}

/** The `/control/models` body from the cached catalog, sorted for a stable UI. */
export function buildModelsList(): ModelsListResponse {
  const models = (state.models?.data ?? []).map((model) =>
    toModelSummary(model),
  )
  models.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  )
  const loadedAtMs = getModelsLoadedAtMs()
  return {
    models,
    count: models.length,
    loaded_at: loadedAtMs === null ? null : new Date(loadedAtMs).toISOString(),
  }
}

/** The full snapshot a client receives on connect (replaces the deleted
 *  buildSnapshot). Composed from the same reads the individual GETs use, so the
 *  first paint never disagrees with the first live delta. */
export interface ControlSnapshot {
  auth: AuthStatus
  accounts: AccountsListResponse
  apps: AppsListResponse
  models: ModelsListResponse
  usage: Awaited<ReturnType<typeof getTokenUsageSummary>>
  clients: { clients: ReturnType<typeof listActiveClients>; total: number }
}

export async function buildControlSnapshot(): Promise<ControlSnapshot> {
  const auth = getAuthStatus()
  const [accounts, apps, usage] = await Promise.all([
    buildAccountsList(),
    buildAppsList(),
    getTokenUsageSummary("day"),
  ])
  const models = buildModelsList()
  const clients = listActiveClients()
  return {
    auth,
    accounts,
    apps,
    models,
    usage,
    clients: { clients, total: clients.length },
  }
}
