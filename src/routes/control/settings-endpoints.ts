/**
 * The heavier /control endpoints re-homed from the deleted routes/settings/*
 * (recovered from git history): api-keys CRUD, the local-gh helper, app toggles,
 * and the diagnostics snapshot. Split out of route.ts to keep each registrar
 * under the function-length cap. Mounted by createControlRoutes.
 *
 * All logic is preserved from the originals; only the mount prefix changed
 * (/settings/api/* → /control/*) and schema-validated responses are returned
 * directly (the ControlClient validates on its side).
 */

import type { Hono as HonoApp } from "hono"

import { randomUUID } from "node:crypto"
import { z } from "zod"

import { getApp } from "~/apps/registry"
import { describeExecutor } from "~/debug"
import { generateApiKeyValue } from "~/lib/auth/api-key-helper"
import { preflightCopilotError } from "~/lib/auth/copilot-preflight"
import {
  addAccountToDefaultRegistry,
  makeAccountRecord,
} from "~/lib/auth/github-token-store"
import {
  copilotBaseUrl,
  getCopilotTokenUrl,
  getEnterpriseDomain,
  getGitHubApiBaseUrl,
} from "~/lib/config/api-config"
import { getConfig, writeConfig } from "~/lib/config/config"
import { API_KEY_VALUE_PATTERN } from "~/lib/config/config-schema"
import {
  type ApiKeyEntry,
  type ApiKeysListResponse,
  ApiKeyCreateRequest,
  ApiKeyUpdateRequest,
  ClaudeCodeToggleRequest,
  ClaudeDesktopToggleRequest,
  type DiagnosticsResponse,
} from "~/lib/config/settings-types"
import { forwardError } from "~/lib/errors/error"
import { describeLaunchSource } from "~/lib/platform/cli-path"
import { modelsCached, state, tokenPresence } from "~/lib/runtime-state/state"
import { BUILD_VERSION } from "~/lib/update/build-info"
import { getGitVersion, shortSha } from "~/lib/update/version"

const VALIDATION = {
  message:
    "Key must be 8–128 chars of letters, digits, underscore, or hyphen — or the literal '*' wildcard.",
  type: "validation_error",
} as const

function apiKeysList(): ApiKeysListResponse {
  const config = getConfig()
  return {
    entries: config.auth?.apiKeyEntries ?? [],
    enforcing: config.auth?.enforce === true,
  }
}

function persistApiKeyEntries(entries: Array<ApiKeyEntry>): void {
  const config = getConfig()
  writeConfig({ ...config, auth: { ...config.auth, apiKeyEntries: entries } })
}

function registerApiKeyReads(app: HonoApp): void {
  app.get("/api-keys", (c) => c.json(apiKeysList()))
}

function registerApiKeyCreate(app: HonoApp): void {
  app.post("/api-keys", async (c) => {
    const parsed = ApiKeyCreateRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) {
      return c.json(
        { error: { ...VALIDATION, message: "Invalid payload" } },
        400,
      )
    }
    const key = (parsed.data.key ?? generateApiKeyValue()).trim()
    if (!API_KEY_VALUE_PATTERN.test(key)) {
      return c.json({ error: VALIDATION }, 400)
    }
    const existing = getConfig().auth?.apiKeyEntries ?? []
    if (existing.some((e) => e.key === key)) {
      return c.json(
        { error: { message: "Key already exists", type: "conflict" } },
        409,
      )
    }
    const entry: ApiKeyEntry = {
      id: randomUUID(),
      label: parsed.data.label.trim(),
      key,
      enabled: parsed.data.enabled ?? true,
      created_at: new Date().toISOString(),
    }
    persistApiKeyEntries([...existing, entry])
    return c.json(entry, 201)
  })
}

/** Request-body shapes, validated rather than cast. `c.req.json()` returns
 *  `any`, and asserting a shape onto it moves an untrusted payload into the
 *  type system unchecked — see `bun run casts:check`. */
const enforceBodySchema = z.object({ enforce: z.boolean() })
const ghUseBodySchema = z.object({
  login: z.string().min(1),
  host: z.string().min(1),
})

function registerApiKeyMutations(app: HonoApp): void {
  app.patch("/api-keys/enforce", async (c) => {
    const body = enforceBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json(
        {
          error: {
            message: "Expected { enforce: boolean }",
            type: "validation_error",
          },
        },
        400,
      )
    }
    const config = getConfig()
    writeConfig({
      ...config,
      auth: { ...config.auth, enforce: body.data.enforce },
    })
    return c.json(apiKeysList())
  })

  app.patch("/api-keys/:id", async (c) => {
    const parsed = ApiKeyUpdateRequest.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) {
      return c.json(
        { error: { ...VALIDATION, message: "Invalid payload" } },
        400,
      )
    }
    const entries = getConfig().auth?.apiKeyEntries ?? []
    const idx = entries.findIndex((e) => e.id === c.req.param("id"))
    if (idx === -1) {
      return c.json(
        { error: { message: "API key not found", type: "not_found" } },
        404,
      )
    }
    const current = entries[idx]
    let nextKey = current.key
    if (parsed.data.key !== undefined) {
      const candidate = parsed.data.key.trim()
      if (!API_KEY_VALUE_PATTERN.test(candidate)) {
        return c.json({ error: VALIDATION }, 400)
      }
      if (entries.some((e, i) => i !== idx && e.key === candidate)) {
        return c.json(
          { error: { message: "Key already exists", type: "conflict" } },
          409,
        )
      }
      nextKey = candidate
    }
    const updated: ApiKeyEntry = {
      ...current,
      label: parsed.data.label?.trim() ?? current.label,
      key: nextKey,
      enabled: parsed.data.enabled ?? current.enabled,
    }
    const next = [...entries]
    next[idx] = updated
    persistApiKeyEntries(next)
    return c.json(updated)
  })

  app.delete("/api-keys/:id", (c) => {
    const entries = getConfig().auth?.apiKeyEntries ?? []
    const next = entries.filter((e) => e.id !== c.req.param("id"))
    if (next.length === entries.length) {
      return c.json(
        { error: { message: "API key not found", type: "not_found" } },
        404,
      )
    }
    persistApiKeyEntries(next)
    return c.body(null, 204)
  })
}

function registerGh(app: HonoApp): void {
  app.get("/gh/status", async (c) => {
    try {
      const { detectGhCli } = await import("~/lib/system/gh-cli")
      return c.json(await detectGhCli())
    } catch (error) {
      return forwardError(c, error)
    }
  })

  app.post("/gh/use", async (c) => {
    try {
      const { detectGhCli, getGhAccountToken } =
        await import("~/lib/system/gh-cli")
      const parsed = ghUseBodySchema.safeParse(
        await c.req.json().catch(() => null),
      )
      if (!parsed.success) {
        return c.json(
          { error: { message: "Expected { login, host } strings." } },
          400,
        )
      }
      const { login, host } = parsed.data
      const status = await detectGhCli()
      if (!status.accounts.some((a) => a.login === login && a.host === host)) {
        return c.json(
          { error: { message: `gh has no account ${login} on ${host}.` } },
          404,
        )
      }
      const token = await getGhAccountToken(login, host)
      if (!token) {
        return c.json(
          { error: { message: `Could not read the gh token for ${login}.` } },
          502,
        )
      }
      const preErr = await preflightCopilotError(token, login)
      if (preErr) return c.json({ error: { message: preErr } }, 422)
      await addAccountToDefaultRegistry(
        makeAccountRecord({ login, host, token, addedVia: "gh-cli" }),
      )
      return c.json({ ok: true, login, host })
    } catch (error) {
      return forwardError(c, error)
    }
  })
}

function registerAppToggles(app: HonoApp): void {
  app.post("/apps/claude-code/toggle", async (c) => {
    try {
      const parsed = ClaudeCodeToggleRequest.safeParse(
        await c.req.json().catch(() => null),
      )
      if (!parsed.success) {
        return c.json(
          { error: { message: "Expected { enabled: boolean }" } },
          400,
        )
      }
      const appEntry = getApp("claude-code")
      if (!appEntry) return c.json({ error: { message: "App not found" } }, 404)
      if (parsed.data.enabled) {
        if (!(await appEntry.detect())) {
          return c.json(
            { error: { message: "No Claude Code install detected." } },
            409,
          )
        }
        const result = await appEntry.enable()
        return c.json(await appEntry.getDetails(result.conflict ?? null))
      }
      await appEntry.disable()
      return c.json(await appEntry.getDetails())
    } catch (error) {
      return forwardError(c, error)
    }
  })

  app.post("/apps/claude-desktop/toggle", async (c) => {
    try {
      const parsed = ClaudeDesktopToggleRequest.safeParse(
        await c.req.json().catch(() => null),
      )
      if (!parsed.success) {
        return c.json(
          { error: { message: "Expected { enabled: boolean }" } },
          400,
        )
      }
      const appEntry = getApp("claude-desktop")
      if (!appEntry) return c.json({ error: { message: "App not found" } }, 404)
      await (parsed.data.enabled ? appEntry.enable() : appEntry.disable())
      const config = getConfig()
      writeConfig({
        ...config,
        apps: {
          ...config.apps,
          claudeDesktop: {
            ...config.apps?.claudeDesktop,
            enabled: parsed.data.enabled,
          },
        },
      })
      return c.json(await appEntry.getDetails())
    } catch (error) {
      return forwardError(c, error)
    }
  })
}

function buildDiagnostics(): DiagnosticsResponse {
  const git = getGitVersion()
  const launch = describeLaunchSource()
  const tokens = tokenPresence()
  const executor = describeExecutor()
  return {
    version: BUILD_VERSION,
    source_revision: git.sha ? shortSha(git.sha) : null,
    source_branch: git.branch ?? null,
    launch_path: launch.path,
    launch_kind: launch.kind,
    pid: process.pid,
    uptime_ms: Math.round(process.uptime() * 1000),
    account_type: state.accountType,
    models_cached: modelsCached(),
    tokens: {
      github_token_present: tokens.github,
      copilot_token_present: tokens.copilot,
    },
    rate_limit: {
      interval_seconds: state.rateLimitSeconds ?? null,
      last_request_at:
        state.lastRequestTimestamp ?
          new Date(state.lastRequestTimestamp).toISOString()
        : null,
      wait_when_throttled: state.rateLimitWait,
    },
    web_search: {
      kind: executor.web_tools,
      detail: executor.base ?? executor.notes ?? null,
    },
    copilot_service: {
      upstream_host: copilotBaseUrl(state),
      github_api_base_url: getGitHubApiBaseUrl(),
      token_endpoint: getCopilotTokenUrl(),
      enterprise_domain: getEnterpriseDomain(),
      discovered_upstream: state.copilotApiUrl ?? null,
    },
  }
}

function registerDiagnostics(app: HonoApp): void {
  app.get("/diagnostics", (c) => c.json(buildDiagnostics()))
}

/** Mount the recovered settings-derived endpoints on the /control router. */
export function registerSettingsEndpoints(app: HonoApp): void {
  registerApiKeyReads(app)
  registerApiKeyCreate(app)
  registerApiKeyMutations(app)
  registerGh(app)
  registerAppToggles(app)
  registerDiagnostics(app)
}
