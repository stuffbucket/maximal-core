// src/lib/config/settings-types.ts
import { z } from "zod";
var TokenStatus = z.object({
  github_token_present: z.boolean(),
  copilot_token_present: z.boolean()
});
var RateLimitStatus = z.object({
  /** Minimum seconds between requests, or null when unconfigured. */
  interval_seconds: z.number().nullable(),
  /** ISO timestamp of the last completed request, or null if none yet. */
  last_request_at: z.string().nullable(),
  /** Whether the proxy waits (vs rejects) when over the limit. */
  wait_when_throttled: z.boolean()
});
var WebSearchStatus = z.object({
  kind: z.string(),
  detail: z.string().nullable()
});
var CopilotServiceStatus = z.object({
  /** Resolved upstream Copilot completions host (`copilotBaseUrl`). */
  upstream_host: z.string(),
  /** GitHub API base the Copilot token is minted against. */
  github_api_base_url: z.string(),
  /** Fully-qualified Copilot token endpoint. */
  token_endpoint: z.string(),
  /** Self-hosted GHES domain override, or null when unset. */
  enterprise_domain: z.string().nullable(),
  /** Host discovered from the token exchange (`endpoints.api`), or null before
   *  the first token mint / when not provided. May differ from `upstream_host`
   *  when an explicit override outranks discovery. */
  discovered_upstream: z.string().nullable()
});
var DiagnosticsResponse = z.object({
  version: z.string(),
  source_revision: z.string().nullable(),
  source_branch: z.string().nullable(),
  /** Absolute path the running sidecar was launched from
   *  (`process.execPath`). Distinguishes a DMG-app launch from a
   *  Homebrew / dev / standalone one in bug reports. */
  launch_path: z.string(),
  /** Coarse classification of `launch_path`. */
  launch_kind: z.enum(["dmg-app", "homebrew", "user-bin", "dev", "other"]),
  pid: z.number().int(),
  uptime_ms: z.number().int(),
  account_type: z.string(),
  models_cached: z.number().int(),
  tokens: TokenStatus,
  rate_limit: RateLimitStatus,
  web_search: WebSearchStatus,
  /** Resolved Copilot service configuration. Optional across versions: a
   *  sidecar predating this field (added with the service disclosure) omits
   *  it, so a newer UI talking to an older running proxy must tolerate its
   *  absence rather than assume it. The current backend always populates it. */
  copilot_service: CopilotServiceStatus.optional()
});
var UpdateStatusResponse = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  update_available: z.boolean(),
  url: z.string(),
  enabled: z.boolean(),
  checked_at: z.string().nullable(),
  last_error: z.string().nullable()
});
var ModelCapabilityFlags = z.object({
  vision: z.boolean(),
  tool_calls: z.boolean(),
  streaming: z.boolean(),
  /** Reasoning / extended-thinking support (adaptive_thinking or a
   *  declared reasoning_effort ladder). */
  reasoning: z.boolean()
});
var ModelSummary = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  family: z.string(),
  /** Upstream `capabilities.type` — "chat", "embeddings", etc. The UI
   *  groups by this. */
  type: z.string(),
  preview: z.boolean(),
  /** Max context window in tokens, or null when upstream omits it. */
  context_window_tokens: z.number().int().nullable(),
  /** Max output tokens, or null when upstream omits it. */
  max_output_tokens: z.number().int().nullable(),
  capabilities: ModelCapabilityFlags
});
var ModelsListResponse = z.object({
  models: z.array(ModelSummary),
  count: z.number().int(),
  /** ISO timestamp of when the cache was last populated, or null. */
  loaded_at: z.string().nullable()
});
var ApiErrorBody = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional()
  })
});
var UpstreamRejection = z.object({
  message: z.string(),
  status: z.number().int(),
  at: z.string(),
  remediation_url: z.string().optional()
});
var NetworkDiagnosisSignal = z.object({
  kind: z.enum(["offline", "dns-failure", "scope-unreachable", "unknown"]),
  scope: z.enum(["github-copilot-auth"]).nullable()
});
var AccountTypeWire = z.enum(["individual", "business", "enterprise"]);
var AuthStatus = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("unauthenticated"),
    last_upstream_rejection: UpstreamRejection.optional(),
    /** Network-issue banner signal — present when a failure has persisted past
     *  the onset window. Rides on the signed-out variant so the banner works
     *  before sign-in. */
    network_diagnosis: NetworkDiagnosisSignal.optional(),
    /** Transient: true on the single event that recovers a long outage, telling
     *  the shell to fire a "reconnected" OS notification. Not part of steady
     *  state — the very next event omits it. */
    notify_on_reconnect: z.boolean().optional()
  }),
  z.object({
    state: z.literal("device_code_issued"),
    user_code: z.string(),
    verification_uri: z.string(),
    expires_at: z.string()
  }),
  z.object({
    state: z.literal("polling"),
    user_code: z.string(),
    verification_uri: z.string(),
    expires_at: z.string()
  }),
  z.object({
    state: z.literal("authenticated"),
    account_login: z.string(),
    /** Profile photo URL from the GitHub `/user` API (`avatar_url`). Optional:
     *  a cold-boot session that couldn't re-fetch the user, or a pre-field
     *  account, omits it and the UI falls back to a typographic initial. Using
     *  the API URL (not `github.com/<login>.png`) is what makes EMU avatars
     *  resolve. */
    account_avatar_url: z.string().optional(),
    /** ISO timestamp of when this session became authenticated — the anchor
     *  for the "Connected · <uptime>" line. Optional for the same cold-boot /
     *  legacy reasons; the UI just shows "Connected" without a duration. */
    connected_since: z.string().optional(),
    /** The account's plan type — lets the shell tailor the network-banner copy
     *  (e.g. the enterprise restart nudge). Null when unresolved. */
    account_type: AccountTypeWire.nullable(),
    last_upstream_rejection: UpstreamRejection.optional(),
    /** Network-issue banner signal — see the unauthenticated variant. */
    network_diagnosis: NetworkDiagnosisSignal.optional(),
    /** Transient reconnect-notification flag — see the unauthenticated variant. */
    notify_on_reconnect: z.boolean().optional()
  }),
  z.object({
    state: z.literal("error"),
    error: z.string(),
    /** Optional remediation URL surfaced when GHCP rejects our token at
     *  the Copilot exchange (e.g. updated TOS, Copilot settings page).
     *  Present only when GHCP returned a URL in the rejection body. */
    remediation_url: z.string().optional()
  })
]);
var AccountSummary = z.object({
  /** Stable identity key, `login@host`. */
  key: z.string(),
  login: z.string(),
  host: z.string(),
  /** How this account entered the registry. */
  added_via: z.enum(["device-code", "gh-cli", "migration"]),
  obtained_at: z.string(),
  /** Whether this is the account the proxy is (or will boot) signed in as. */
  active: z.boolean()
});
var AccountsListResponse = z.object({
  accounts: z.array(AccountSummary),
  active_key: z.string().nullable()
});
var ApiKeyEntry = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  enabled: z.boolean(),
  created_at: z.string()
});
var ApiKeysListResponse = z.object({
  entries: z.array(ApiKeyEntry),
  /** Whether the proxy is currently enforcing API-key auth. False when
   *  both `apiKeys` and `apiKeyEntries` are empty (no enabled keys);
   *  in that mode the proxy accepts all local requests. */
  enforcing: z.boolean()
});
var ApiKeyCreateRequest = z.object({
  label: z.string().min(1).max(64),
  /** Optional: if omitted, the server generates one. */
  key: z.string().optional(),
  enabled: z.boolean().optional()
});
var ApiKeyUpdateRequest = z.object({
  label: z.string().min(1).max(64).optional(),
  key: z.string().optional(),
  enabled: z.boolean().optional()
});
var AppInstall = z.object({
  /** Resolved absolute path of the real binary. */
  path: z.string(),
  /** `--version` output, or null when it couldn't be read. */
  version: z.string().nullable(),
  /** How it was installed (homebrew / npm-global / local-bin / …). */
  source: z.enum([
    "homebrew",
    "npm-global",
    "local-bin",
    "claude-local",
    "path",
    "unknown"
  ])
});
var AppInstallHint = z.object({
  method: z.string(),
  command: z.string()
});
var AppEntry = z.object({
  id: z.enum(["claude-code", "claude-desktop", "copilot-cli"]),
  name: z.string(),
  kind: z.enum(["config", "coming-soon"]),
  /** Whether the integration is currently active (proxy config applied). */
  enabled: z.boolean(),
  status: z.enum(["ready", "not-installed", "coming-soon"]),
  installs: z.array(AppInstall),
  install: AppInstallHint.nullable(),
  /** Non-null when enabling was refused because the app's config already
   *  has a setting we don't own (e.g. a user-set ANTHROPIC_BASE_URL or
   *  apiKeyHelper). The UI surfaces this so the user knows why the toggle
   *  didn't take. */
  conflict: z.enum(["foreign-base-url", "foreign-api-key-helper"]).nullable()
});
var AppsListResponse = z.object({
  apps: z.array(AppEntry)
});
var ClaudeCodeToggleRequest = z.object({
  enabled: z.boolean()
});
var ClaudeDesktopToggleRequest = z.object({
  enabled: z.boolean()
});
export {
  AccountSummary,
  AccountTypeWire,
  AccountsListResponse,
  ApiErrorBody,
  ApiKeyCreateRequest,
  ApiKeyEntry,
  ApiKeyUpdateRequest,
  ApiKeysListResponse,
  AppEntry,
  AppInstall,
  AppInstallHint,
  AppsListResponse,
  AuthStatus,
  ClaudeCodeToggleRequest,
  ClaudeDesktopToggleRequest,
  CopilotServiceStatus,
  DiagnosticsResponse,
  ModelCapabilityFlags,
  ModelSummary,
  ModelsListResponse,
  NetworkDiagnosisSignal,
  RateLimitStatus,
  TokenStatus,
  UpdateStatusResponse,
  UpstreamRejection,
  WebSearchStatus
};
