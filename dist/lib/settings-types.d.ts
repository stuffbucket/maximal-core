import { z } from 'zod';

/**
 * Shared type contracts between the proxy and the desktop shell's
 * Settings UI. The shapes here are the *stable* contract — distinct
 * from `/_debug/state`, which is a free-form dev dump.
 *
 * The zod schemas are the source of truth; inferred TS types are
 * what the shell consumes. The shell can import the inferred type
 * directly (TS-only import; no runtime zod dependency required on
 * the shell side) via a relative path. If/when the shell needs
 * client-side validation, it can add zod as a dep and import the
 * schema too — keeping the same parser on both ends.
 *
 * Field names follow snake_case to match the rest of `/_debug/state`
 * and the Anthropic / OpenAI JSON conventions.
 */

/** Tail-4 redacted token presence + (when known) source. We do NOT
 *  expose token values, validity windows we don't track, or any
 *  data that could narrow the secret. */
declare const TokenStatus: z.ZodObject<{
    github_token_present: z.ZodBoolean;
    copilot_token_present: z.ZodBoolean;
}, z.core.$strip>;
type TokenStatus = z.infer<typeof TokenStatus>;
/**
 * Health of the Copilot bearer and of the background refresh loop that renews
 * it — GET `/control/diagnostics`.
 *
 * This exists because there was no state between "healthy" and "every request
 * fails with 403" (#9): the refresh loop retried a transport failure every 15s
 * indefinitely and recorded nothing, so a refresh that had been broken for
 * minutes was indistinguishable from one that had never failed.
 *
 * `health` uses #15's `AccountHealth` vocabulary. `needsReauth` is NOT reachable
 * here on purpose — only an auth-fatal rejection may claim a credential is
 * invalid, and that verdict is written on the account record by
 * `markAuthDegraded`. An offline or upstream failure only ever reaches
 * `refreshing` or `expired`.
 *
 * No token value, and `last_failure_reason` is a typed network diagnosis or an
 * error message — never an upstream body.
 */
declare const CopilotRefreshStatus: z.ZodObject<{
    health: z.ZodEnum<{
        unknown: "unknown";
        healthy: "healthy";
        refreshing: "refreshing";
        expired: "expired";
    }>;
    token_expires_at: z.ZodNullable<z.ZodString>;
    last_success_at: z.ZodNullable<z.ZodString>;
    last_failure_at: z.ZodNullable<z.ZodString>;
    last_failure_reason: z.ZodNullable<z.ZodString>;
    consecutive_failures: z.ZodNumber;
}, z.core.$strip>;
type CopilotRefreshStatus = z.infer<typeof CopilotRefreshStatus>;
/** The proxy throttles via a fixed minimum interval between
 *  requests, not a "tokens remaining / resets-at" bucket. The
 *  contract surfaces what actually exists. */
declare const RateLimitStatus: z.ZodObject<{
    interval_seconds: z.ZodNullable<z.ZodNumber>;
    last_request_at: z.ZodNullable<z.ZodString>;
    wait_when_throttled: z.ZodBoolean;
}, z.core.$strip>;
type RateLimitStatus = z.infer<typeof RateLimitStatus>;
/** Which executor resolves web_search / web_fetch tool calls for Claude
 *  clients. `kind` is the executor class (stable, matches
 *  `/_debug/state`); `detail` is the human-readable model/base/notes from
 *  describeExecutor (e.g. the /responses model or "no key"). */
declare const WebSearchStatus: z.ZodObject<{
    kind: z.ZodString;
    detail: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type WebSearchStatus = z.infer<typeof WebSearchStatus>;
/** The upstream Copilot service the proxy is talking to — hosts/URLs only, no
 *  secrets (consistent with the "presence, never values" rule above). All are
 *  resolved from the live request-path config in `~/lib/config/api-config`, so
 *  they reflect exactly where traffic is being sent. `enterprise_domain` and
 *  `discovered_upstream` are null on the default (non-enterprise / pre-token)
 *  path. */
declare const CopilotServiceStatus: z.ZodObject<{
    upstream_host: z.ZodString;
    github_api_base_url: z.ZodString;
    token_endpoint: z.ZodString;
    enterprise_domain: z.ZodNullable<z.ZodString>;
    discovered_upstream: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type CopilotServiceStatus = z.infer<typeof CopilotServiceStatus>;
declare const DiagnosticsResponse: z.ZodObject<{
    version: z.ZodString;
    source_revision: z.ZodNullable<z.ZodString>;
    source_branch: z.ZodNullable<z.ZodString>;
    launch_path: z.ZodString;
    launch_kind: z.ZodEnum<{
        "dmg-app": "dmg-app";
        homebrew: "homebrew";
        "user-bin": "user-bin";
        dev: "dev";
        other: "other";
    }>;
    pid: z.ZodNumber;
    uptime_ms: z.ZodNumber;
    account_type: z.ZodString;
    models_cached: z.ZodNumber;
    tokens: z.ZodObject<{
        github_token_present: z.ZodBoolean;
        copilot_token_present: z.ZodBoolean;
    }, z.core.$strip>;
    copilot_refresh: z.ZodOptional<z.ZodObject<{
        health: z.ZodEnum<{
            unknown: "unknown";
            healthy: "healthy";
            refreshing: "refreshing";
            expired: "expired";
        }>;
        token_expires_at: z.ZodNullable<z.ZodString>;
        last_success_at: z.ZodNullable<z.ZodString>;
        last_failure_at: z.ZodNullable<z.ZodString>;
        last_failure_reason: z.ZodNullable<z.ZodString>;
        consecutive_failures: z.ZodNumber;
    }, z.core.$strip>>;
    rate_limit: z.ZodObject<{
        interval_seconds: z.ZodNullable<z.ZodNumber>;
        last_request_at: z.ZodNullable<z.ZodString>;
        wait_when_throttled: z.ZodBoolean;
    }, z.core.$strip>;
    web_search: z.ZodObject<{
        kind: z.ZodString;
        detail: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    copilot_service: z.ZodOptional<z.ZodObject<{
        upstream_host: z.ZodString;
        github_api_base_url: z.ZodString;
        token_endpoint: z.ZodString;
        enterprise_domain: z.ZodNullable<z.ZodString>;
        discovered_upstream: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type DiagnosticsResponse = z.infer<typeof DiagnosticsResponse>;
/** Update-availability status — GET /settings/api/update-status. Best-effort:
 *  `latest` is null and `update_available` false whenever the check is disabled
 *  or the manifest fetch failed. `url` is the install-channel-neutral download
 *  page (mxml.sh), not a raw release asset. The `enabled` / `checked_at` /
 *  `last_error` fields are diagnostic — they let the Settings UI show whether
 *  the mechanism is working and what it last reported. See update-check.ts. */
declare const UpdateStatusResponse: z.ZodObject<{
    current: z.ZodString;
    latest: z.ZodNullable<z.ZodString>;
    update_available: z.ZodBoolean;
    url: z.ZodString;
    enabled: z.ZodBoolean;
    checked_at: z.ZodNullable<z.ZodString>;
    last_error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type UpdateStatusResponse = z.infer<typeof UpdateStatusResponse>;
/** A model's distilled capability flags — the "key capabilities" the
 *  Settings UI surfaces (not the full upstream model card). Each is a
 *  plain boolean derived from `capabilities.supports.*`, so the shell
 *  can render a compact flag row without knowing Copilot's schema. */
declare const ModelCapabilityFlags: z.ZodObject<{
    vision: z.ZodBoolean;
    tool_calls: z.ZodBoolean;
    streaming: z.ZodBoolean;
    reasoning: z.ZodBoolean;
}, z.core.$strip>;
type ModelCapabilityFlags = z.infer<typeof ModelCapabilityFlags>;
/** One row in the Settings → Models list. A flattened, UI-shaped view
 *  of the upstream `Model` (src/services/copilot/get-models.ts) — only
 *  the fields the section actually renders, snake_cased per the
 *  contract convention. */
declare const ModelSummary: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    vendor: z.ZodString;
    family: z.ZodString;
    type: z.ZodString;
    preview: z.ZodBoolean;
    context_window_tokens: z.ZodNullable<z.ZodNumber>;
    max_output_tokens: z.ZodNullable<z.ZodNumber>;
    capabilities: z.ZodObject<{
        vision: z.ZodBoolean;
        tool_calls: z.ZodBoolean;
        streaming: z.ZodBoolean;
        reasoning: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>;
type ModelSummary = z.infer<typeof ModelSummary>;
/** Response of GET/POST `/settings/api/models`. Carries the cached
 *  catalog plus its freshness so the UI can show staleness and offer a
 *  manual refresh. `loaded_at` is null before the first successful
 *  fetch. */
declare const ModelsListResponse: z.ZodObject<{
    models: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        vendor: z.ZodString;
        family: z.ZodString;
        type: z.ZodString;
        preview: z.ZodBoolean;
        context_window_tokens: z.ZodNullable<z.ZodNumber>;
        max_output_tokens: z.ZodNullable<z.ZodNumber>;
        capabilities: z.ZodObject<{
            vision: z.ZodBoolean;
            tool_calls: z.ZodBoolean;
            streaming: z.ZodBoolean;
            reasoning: z.ZodBoolean;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    count: z.ZodNumber;
    loaded_at: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type ModelsListResponse = z.infer<typeof ModelsListResponse>;
/** Structured error envelope. Mirrors what Hono routes already emit
 *  via forwardError, so the shell can render either source uniformly. */
declare const ApiErrorBody: z.ZodObject<{
    error: z.ZodObject<{
        message: z.ZodString;
        type: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
type ApiErrorBody = z.infer<typeof ApiErrorBody>;
/** Last non-fatal upstream rejection from a Copilot completion
 *  endpoint (quota exhausted, model not on plan, transient upstream
 *  error). Distinct from `error`/`remediation_url` on AuthStatus
 *  (which are about the GitHub-token state itself) —
 *  `last_upstream_rejection` is a sidecar attached to the most recent
 *  completion attempt and clears on the next successful request.
 *  Rides along on `unauthenticated` and `authenticated` states only;
 *  the pending and error variants don't carry it (a token state issue
 *  takes precedence over a completion-time rejection in the UI). */
declare const UpstreamRejection: z.ZodObject<{
    message: z.ZodString;
    status: z.ZodNumber;
    at: z.ZodString;
    remediation_url: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type UpstreamRejection = z.infer<typeof UpstreamRejection>;
/** The hysteresis-resolved network-issue signal for the banner. Distinct from
 *  `last_upstream_rejection` (a completion-time rejection) and from the auth
 *  `error` state (a token problem): this says "we can't reach the service" and
 *  the token may be perfectly fine. Carries ONLY the typed discriminant + scope
 *  — no user-facing prose. The shell builds the message via i18n keyed on
 *  `(kind, scope)` (and, for `scope-unreachable`, tailors copy by `account_type`
 *  on the authenticated variant). Rides on the `authenticated` AND
 *  `unauthenticated` variants so the banner works signed-out. Present only when
 *  a failure has persisted past the onset window; cleared on recovery.
 *
 *  `kind` values MIRROR `NETWORK_DIAGNOSIS_KIND` and `scope` MIRRORS
 *  `NETWORK_SCOPE` (both in `~/lib/net/network-diagnostics`). The literals are
 *  DELIBERATELY re-declared here rather than imported: this wire-type module is
 *  consumed by the desktop shell, and importing network-diagnostics (which pulls
 *  `node:dns`/`node:net`/`node:os`) would drag those into the browser bundle.
 *  A drift guard in `tests/network-hysteresis.test.ts` fails the build if these
 *  fall out of sync with the source-of-truth constants. */
declare const NetworkDiagnosisSignal: z.ZodObject<{
    kind: z.ZodEnum<{
        unknown: "unknown";
        offline: "offline";
        "dns-failure": "dns-failure";
        "scope-unreachable": "scope-unreachable";
    }>;
    scope: z.ZodNullable<z.ZodEnum<{
        "github-copilot-auth": "github-copilot-auth";
    }>>;
}, z.core.$strip>;
type NetworkDiagnosisSignal = z.infer<typeof NetworkDiagnosisSignal>;
/** Account plan type, mirroring `AccountType` (individual|business|enterprise).
 *  Surfaced on the `authenticated` variant so the shell can tailor the
 *  network-banner copy (e.g. an enterprise-specific restart nudge). Nullable
 *  because a session may not have resolved a plan yet. */
declare const AccountTypeWire: z.ZodEnum<{
    individual: "individual";
    business: "business";
    enterprise: "enterprise";
}>;
type AccountTypeWire = z.infer<typeof AccountTypeWire>;
/** GitHub device-code auth state, exposed by /settings/api/auth/github/*.
 *
 *  Lifecycle:
 *    unauthenticated → device_code_issued → polling → authenticated
 *                                                   ↘ error
 *
 *  Transitions are driven by POST /start (issue), the background
 *  poller (polling → authenticated|error), and POST /sign-out (reset).
 *
 *  Modeled as a discriminated union on `state` (boundary D3, ADR-0006):
 *  each variant declares exactly the data valid in that state, so the
 *  shell narrows by `state` and the renderer is exhaustive. Adding a
 *  new state requires a new variant — the compiler then surfaces every
 *  renderer + controller site that must handle it.
 *
 *  Note on `account_login` for the `authenticated` variant: a real
 *  GitHub login is required by contract. The controller resolves it
 *  before flipping to authenticated (see auth-controller.runPoller).
 *  In the best-effort failure path (sign-in succeeded but
 *  getGitHubUser threw), the controller emits the literal `"unknown"`
 *  string rather than dropping the field — the renderer treats
 *  `"unknown"` as a placeholder trigger. The field is never absent.
 */
declare const AuthStatus: z.ZodDiscriminatedUnion<[z.ZodObject<{
    state: z.ZodLiteral<"unauthenticated">;
    last_upstream_rejection: z.ZodOptional<z.ZodObject<{
        message: z.ZodString;
        status: z.ZodNumber;
        at: z.ZodString;
        remediation_url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    network_diagnosis: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            unknown: "unknown";
            offline: "offline";
            "dns-failure": "dns-failure";
            "scope-unreachable": "scope-unreachable";
        }>;
        scope: z.ZodNullable<z.ZodEnum<{
            "github-copilot-auth": "github-copilot-auth";
        }>>;
    }, z.core.$strip>>;
    notify_on_reconnect: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    state: z.ZodLiteral<"device_code_issued">;
    user_code: z.ZodString;
    verification_uri: z.ZodString;
    expires_at: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    state: z.ZodLiteral<"polling">;
    user_code: z.ZodString;
    verification_uri: z.ZodString;
    expires_at: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    state: z.ZodLiteral<"authenticated">;
    account_login: z.ZodString;
    account_avatar_url: z.ZodOptional<z.ZodString>;
    connected_since: z.ZodOptional<z.ZodString>;
    account_type: z.ZodNullable<z.ZodEnum<{
        individual: "individual";
        business: "business";
        enterprise: "enterprise";
    }>>;
    last_upstream_rejection: z.ZodOptional<z.ZodObject<{
        message: z.ZodString;
        status: z.ZodNumber;
        at: z.ZodString;
        remediation_url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    network_diagnosis: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            unknown: "unknown";
            offline: "offline";
            "dns-failure": "dns-failure";
            "scope-unreachable": "scope-unreachable";
        }>;
        scope: z.ZodNullable<z.ZodEnum<{
            "github-copilot-auth": "github-copilot-auth";
        }>>;
    }, z.core.$strip>>;
    notify_on_reconnect: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    state: z.ZodLiteral<"error">;
    error: z.ZodString;
    remediation_url: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "state">;
type AuthStatus = z.infer<typeof AuthStatus>;
declare const AccountSummary: z.ZodObject<{
    key: z.ZodString;
    login: z.ZodString;
    host: z.ZodString;
    added_via: z.ZodEnum<{
        "device-code": "device-code";
        "gh-cli": "gh-cli";
        migration: "migration";
    }>;
    obtained_at: z.ZodString;
    active: z.ZodBoolean;
}, z.core.$strip>;
type AccountSummary = z.infer<typeof AccountSummary>;
declare const AccountsListResponse: z.ZodObject<{
    accounts: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        login: z.ZodString;
        host: z.ZodString;
        added_via: z.ZodEnum<{
            "device-code": "device-code";
            "gh-cli": "gh-cli";
            migration: "migration";
        }>;
        obtained_at: z.ZodString;
        active: z.ZodBoolean;
    }, z.core.$strip>>;
    active_key: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type AccountsListResponse = z.infer<typeof AccountsListResponse>;
/**
 * An API-key entry as managed by Settings → API clients. The key value
 * is returned in full to the local Settings UI — the endpoint is
 * already auth-gated and loopback-only in normal operation, and the
 * "show/hide" affordance lives in the UI, not the wire format.
 *
 * Key value charset matches `API_KEY_VALUE_PATTERN` in config-schema.ts:
 * 8–128 chars of [A-Za-z0-9_-], or the literal "*" wildcard.
 */
declare const ApiKeyEntry: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    key: z.ZodString;
    enabled: z.ZodBoolean;
    created_at: z.ZodString;
}, z.core.$strip>;
type ApiKeyEntry = z.infer<typeof ApiKeyEntry>;
declare const ApiKeysListResponse: z.ZodObject<{
    entries: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        key: z.ZodString;
        enabled: z.ZodBoolean;
        created_at: z.ZodString;
    }, z.core.$strip>>;
    enforcing: z.ZodBoolean;
}, z.core.$strip>;
type ApiKeysListResponse = z.infer<typeof ApiKeysListResponse>;
declare const ApiKeyCreateRequest: z.ZodObject<{
    label: z.ZodString;
    key: z.ZodOptional<z.ZodString>;
    enabled: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateRequest>;
declare const ApiKeyUpdateRequest: z.ZodObject<{
    label: z.ZodOptional<z.ZodString>;
    key: z.ZodOptional<z.ZodString>;
    enabled: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
type ApiKeyUpdateRequest = z.infer<typeof ApiKeyUpdateRequest>;
/** One detected install of a CLI app (display only). */
declare const AppInstall: z.ZodObject<{
    path: z.ZodString;
    version: z.ZodNullable<z.ZodString>;
    source: z.ZodEnum<{
        unknown: "unknown";
        homebrew: "homebrew";
        path: "path";
        "npm-global": "npm-global";
        "local-bin": "local-bin";
        "claude-local": "claude-local";
    }>;
}, z.core.$strip>;
type AppInstall = z.infer<typeof AppInstall>;
/** When set, the UI offers a one-line install command for the app. */
declare const AppInstallHint: z.ZodObject<{
    method: z.ZodString;
    command: z.ZodString;
}, z.core.$strip>;
type AppInstallHint = z.infer<typeof AppInstallHint>;
declare const AppEntry: z.ZodObject<{
    id: z.ZodEnum<{
        "claude-code": "claude-code";
        "claude-desktop": "claude-desktop";
        "copilot-cli": "copilot-cli";
    }>;
    name: z.ZodString;
    kind: z.ZodEnum<{
        config: "config";
        "coming-soon": "coming-soon";
    }>;
    enabled: z.ZodBoolean;
    status: z.ZodEnum<{
        "coming-soon": "coming-soon";
        ready: "ready";
        "not-installed": "not-installed";
    }>;
    installs: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        version: z.ZodNullable<z.ZodString>;
        source: z.ZodEnum<{
            unknown: "unknown";
            homebrew: "homebrew";
            path: "path";
            "npm-global": "npm-global";
            "local-bin": "local-bin";
            "claude-local": "claude-local";
        }>;
    }, z.core.$strip>>;
    install: z.ZodNullable<z.ZodObject<{
        method: z.ZodString;
        command: z.ZodString;
    }, z.core.$strip>>;
    conflict: z.ZodNullable<z.ZodEnum<{
        "foreign-base-url": "foreign-base-url";
        "foreign-api-key-helper": "foreign-api-key-helper";
    }>>;
}, z.core.$strip>;
type AppEntry = z.infer<typeof AppEntry>;
declare const AppsListResponse: z.ZodObject<{
    apps: z.ZodArray<z.ZodObject<{
        id: z.ZodEnum<{
            "claude-code": "claude-code";
            "claude-desktop": "claude-desktop";
            "copilot-cli": "copilot-cli";
        }>;
        name: z.ZodString;
        kind: z.ZodEnum<{
            config: "config";
            "coming-soon": "coming-soon";
        }>;
        enabled: z.ZodBoolean;
        status: z.ZodEnum<{
            "coming-soon": "coming-soon";
            ready: "ready";
            "not-installed": "not-installed";
        }>;
        installs: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            version: z.ZodNullable<z.ZodString>;
            source: z.ZodEnum<{
                unknown: "unknown";
                homebrew: "homebrew";
                path: "path";
                "npm-global": "npm-global";
                "local-bin": "local-bin";
                "claude-local": "claude-local";
            }>;
        }, z.core.$strip>>;
        install: z.ZodNullable<z.ZodObject<{
            method: z.ZodString;
            command: z.ZodString;
        }, z.core.$strip>>;
        conflict: z.ZodNullable<z.ZodEnum<{
            "foreign-base-url": "foreign-base-url";
            "foreign-api-key-helper": "foreign-api-key-helper";
        }>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type AppsListResponse = z.infer<typeof AppsListResponse>;
declare const ClaudeCodeToggleRequest: z.ZodObject<{
    enabled: z.ZodBoolean;
}, z.core.$strip>;
type ClaudeCodeToggleRequest = z.infer<typeof ClaudeCodeToggleRequest>;
declare const ClaudeDesktopToggleRequest: z.ZodObject<{
    enabled: z.ZodBoolean;
}, z.core.$strip>;
type ClaudeDesktopToggleRequest = z.infer<typeof ClaudeDesktopToggleRequest>;

export { AccountSummary, AccountTypeWire, AccountsListResponse, ApiErrorBody, ApiKeyCreateRequest, ApiKeyEntry, ApiKeyUpdateRequest, ApiKeysListResponse, AppEntry, AppInstall, AppInstallHint, AppsListResponse, AuthStatus, ClaudeCodeToggleRequest, ClaudeDesktopToggleRequest, CopilotRefreshStatus, CopilotServiceStatus, DiagnosticsResponse, ModelCapabilityFlags, ModelSummary, ModelsListResponse, NetworkDiagnosisSignal, RateLimitStatus, TokenStatus, UpdateStatusResponse, UpstreamRejection, WebSearchStatus };
