# Auth, Middleware & Upstream Transport (Wire)

**Scope banner.** This describes **current behaviour**, not a plan. It was
written pre-split as a PRD for work that has since shipped, and the pre-split
text described auth classes (`/ui/*`, `/settings/api/*`) for surfaces core no
longer has. It was rewritten from source on 2026-08-05 and re-verified against a
running engine; the acceptance list at the end is the probe set that was
actually executed.

It stays here rather than in `docs/spec/archive/` because
[`README.md`](README.md) makes it the foundation document for the six sibling
wire PRDs — they reference its middleware, client-auth, and upstream-header
sections instead of repeating them. Archiving it would leave the set with no
auth/transport contract; the file's failure was drift, not genre.

**Citation convention.** References here are `path` + exported symbol name, not
`path:line`. `tests/docs-reference-parity.test.ts` excludes `docs/spec/**` from
path checking, so nothing in this file is verified by CI — a symbol name is at
least greppable when it moves, and a line number is the part that rotted last
time.

## Scope

- The Hono middleware stack, and the fact that **both** listeners share it.
- How the proxy authenticates a **client** (API key), and which paths are
  exempt, loopback-gated, or Origin-gated.
- Where credentials attach on the way **out** (ADR-0001's single mechanism).
- How the proxy authenticates **itself to Copilot** and the header set it
  injects.
- Rate limiting, timeouts, and the shared upstream error contract.

## The two listeners

`src/server.ts` exports two Hono apps; `bindListeners` in
`src/lib/start/run-server.ts` binds them with two separate `serve()` calls.

| Listener | Bind | Port | Serves |
|---|---|---|---|
| `publicApp` | all interfaces | `--port`, default 4141, port policy applies | `/`, `/status`, `/setup-status`, `/openapi.json`, `/_internal/*`, the proxy routes (`/chat/completions`, `/models`, `/embeddings`, `/responses`, `/usage`, `/token-usage*`), their `/v1/*` aliases, `/v1/messages`, `/:provider/v1/*` |
| `controlApp` | `127.0.0.1` only | `--control-port`, default `0` (ephemeral) | `/control/*`, `/_debug/*` |

The separation is **structural, not a path filter**: `/v1` is never mounted on
the control app, so it cannot be reached there by any request-shaping trick, and
the control listener is not reachable off-box at all (verified: a connect to the
control port on the LAN address is refused).

`/_internal` stays on the **public** listener on purpose — `evictRunning`
(`src/lib/platform/replace-running.ts`) takes over the public port by POSTing
`/_internal/shutdown` *to that port*, and the evicting process does not know the
occupant's ephemeral control port.

## Shared middleware stack

`applyCommonMiddleware(app)` in `src/server.ts` is applied to **both** apps, in
this order. One applier rather than two stacks: a drifted auth or origin stack
would be a security bug, not a cosmetic one. Paths that do not exist on a given
app simply 404 after passing through.

| # | Middleware | Wire effect |
|---|---|---|
| 1 | `traceIdMiddleware` (`src/lib/http/trace.ts`) | Resolves `x-trace-id` from the request or generates one, echoes it on the response, and runs the rest of the request inside an `AsyncLocalStorage` context (`src/lib/http/request-context.ts`) carrying trace id, start time, user-agent, `x-session-affinity`, `x-parent-session-id`. |
| 2 | version stamp (inline in `src/server.ts`) | Sets `x-maximal-version: <BUILD_VERSION>` (`src/lib/update/build-info.ts`) on **every** response, so a client can read which build served it without a second call. Static constant; no per-request cost, no secrets. |
| 3 | `logger()` | Hono's request logger (stdout). |
| 4 | `cors(buildCorsOptions(controlPort))` (`src/lib/auth/origin-guard.ts`) | **A localhost allowlist, not `*`.** See below. |
| 5 | `createOriginGuardMiddleware({ boundPort: controlPort })` (`src/lib/auth/origin-guard.ts`) | 403s a present, non-localhost `Origin` on the guarded prefixes. Mounted **before** auth, so a cross-origin browser request is refused regardless of any key. |
| 6 | `createAuthMiddleware(...)` (`src/lib/auth/request-auth.ts`) | Client API-key validation + per-request client attribution. |
| 7 | `staleRefreshMiddleware(...)` (`src/lib/models/refresh-models.ts`) | After auth: fire-and-forget background refresh of the model cache when stale. Never blocks or alters the triggering response. See `models-wire-prd.md`. |

`requireGithubAuth` is **not** in the shared stack — it is mounted per route
group on `publicApp` only. See *GitHub token gate*.

Both the CORS allowlist and the Origin guard are keyed on `state.controlPort`
(read lazily per request, since `runServer` resolves ports before binding).

## CORS and the Origin guard

Both live in `src/lib/auth/origin-guard.ts` and share one predicate,
`isAllowedOrigin(origin, boundPort)`:

- `origin === null` (header absent) → **allowed**. This is the CLI/plugin/SDK
  invariant (ADR-0021 §6.6): Claude Code, opencode, and SDK clients send no
  `Origin`. `Origin` is a Forbidden header, so page JS cannot suppress it — a
  missing one means a non-browser caller.
- hostname ∈ {`localhost`, `127.0.0.1`, `[::1]`} **and** port exactly
  `state.controlPort` → allowed.
- anything else, including an unparseable/opaque origin (the literal `"null"` a
  sandboxed iframe sends) → refused.

**Origin guard.** `CSRF_GUARDED_PREFIXES` = `/settings/api`, `/_internal`,
`/_debug/state`, `/control`. A guarded path with a disallowed `Origin` gets:

```
403  { "error": { "message": "Forbidden: cross-origin request to a control endpoint",
                  "type": "csrf_error" } }
```

`/settings/api` is a **dead prefix** — those routes were removed at the core
split. It is retained in the list as a belt-and-braces entry; nothing serves it.

**CORS.** `buildCorsOptions` echoes the request `Origin` back as
`Access-Control-Allow-Origin` only when `isAllowedOrigin` passes, and returns
`null` (no header at all) otherwise, so the browser blocks the cross-origin
read. `Vary: Origin` is always set. The `OPTIONS` preflight is the load-bearing
case, because auth bypasses `OPTIONS`.

Two consequences worth stating plainly, both verified live:

- Because the port is the **control** port on both listeners, a browser page
  served from the *public* port (`http://localhost:4141`) is **not** an allowed
  origin — it gets a 403 on guarded prefixes and no `Access-Control-Allow-Origin`
  anywhere. That is stricter than the module comment implies ("every
  `CSRF_GUARDED_PREFIX` lives on that listener" is not true of `/_internal`,
  which is on the public app).
- A non-browser client is unaffected by either gate.

## Client authentication

### Credential extraction

`extractRequestApiKey` (`src/lib/auth/request-auth.ts`), in precedence order:

1. `x-api-key` header (trimmed).
2. `Authorization: <scheme> <token>` where the scheme matches `bearer`
   case-insensitively.

There is **no query-string fallback.** The pre-split `?key=` path for an
EventSource endpoint is gone with that endpoint: the live feed is JSON-RPC/SSE
over the control listener (`src/routes/control/route.ts`, transport in
`src/lib/live/`), not a browser `EventSource`, so no credential travels in a URL
or a log line. Verified: `/v1/models?key=<valid key>` under enforcement returns
`401`.

### The decision

`decideAuth` (`src/lib/auth/request-auth.ts`), in order:

1. **Shell key.** A request whose key equals `state.shellApiKey`
   (`MAXIMAL_SHELL_KEY` in the process env) is allowed and attributed to
   `"Maximal Settings"`, regardless of the enforce flag. A legacy of the
   desktop-shell spawn; core itself never sets it.
2. **Enforcement off** (`config.auth.enforce !== true`, the default for a fresh
   install) → allowed. The configured key list is still consulted, but only to
   *attribute* the request to a named client.
3. Otherwise the key must be present and match an entry from
   `getConfiguredApiKeys()` — the union of legacy `auth.apiKeys` and enabled
   `auth.apiKeyEntries`.

An allowed request is recorded via `recordClient` (`src/lib/http/active-clients.ts`)
with its key id, label, and user-agent; that is what `/control` reports as
connected clients.

### Bypass order

`shouldBypass` runs **before** any key is extracted, in this order:

1. `allowOptionsBypass` (default `true`) and method is `OPTIONS`.
2. Exact match in `allowUnauthenticatedPaths`.
3. Prefix match in `allowUnauthenticatedPrefixes`.
4. Exact match in `loopbackOnlyPaths` **and** the peer IP is loopback.

Only if none matches is `extractRequestApiKey` called and `decideAuth` consulted.
The ordering matters for `/control`: it bypasses at step 3, so no key is ever
read for it — the control surface is not "auth-exempt after a key check", it is
never key-checked at all.

### Path classes

Configured at the middleware call site in `src/server.ts`:

| Class | Paths | Behaviour |
|---|---|---|
| **Unauthenticated** | `/`, `/status`, `/_debug/state`, `/setup-status`, `/openapi.json` | No key required, ever. `/openapi.json` is a public spec document with no secrets; `/_debug/state` is additionally `verbose`-gated by its own handler (404 otherwise). |
| **Unauthenticated prefix** | `/control` | Exempt from the API-key dance entirely. It is protected by three other things instead: the listener binds loopback-only, the control router re-checks the peer IP and 404s a remote caller, and the Origin guard 403s a cross-origin browser request. |
| **Loopback-only** | `/usage`, `/token-usage`, `/token-usage/events`, `/_internal/shutdown` | Auth is skipped **for loopback callers**; a remote caller still needs a valid key. |

Loopback is peer IP ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`} via
`isLoopbackAddress`, reading `request.ip` as attached by srvx's Bun and Node
adapters (`defaultGetRequestIp`).

`/_internal/shutdown` is **loopback-gated, not key-gated**. Listing it under
`loopbackOnlyPaths` only skips the auth dance for a local caller; the handler
(`src/routes/internal/route.ts`) independently requires loopback and returns
`404` to anyone else. A remote caller holding a *valid* API key therefore cannot
evict the running instance — verified live.

There is deliberately **no** "…except these sub-prefixes" escape hatch on
`allowUnauthenticatedPrefixes`. The `requireAuthPrefixes` and
`alwaysEnforcePrefixes` options (ADR-0021 §6.2, alongside an exported
`MANDATORY_AUTH_PREFIX = "/settings/api"`) were the `/settings/api` hardening
levers; that surface was removed at the core split, `server.ts` passed neither,
and all three were deleted with it — see the note on
`allowUnauthenticatedPrefixes` in `src/lib/auth/request-auth.ts`.

### Client failure responses

| Scenario | Status | Body / headers |
|---|---|---|
| Missing/invalid API key while enforcing | `401` | `{ "error": { "message": "Unauthorized", "type": "authentication_error" } }` + `WWW-Authenticate: Bearer realm="copilot-api"` (`createUnauthorizedResponse`) |
| Cross-origin request to a guarded prefix | `403` | `{ "error": { "message": "Forbidden: …", "type": "csrf_error" } }` |
| Remote caller on `/control/*` or `/_internal/shutdown` | `404` | Hono's not-found body — indistinguishable from a missing route to a remote scanner |
| Upstream-touching route with no GitHub token | `401` | `{ "error": "not_authenticated", "hint": "Open Settings → Account to sign in, or run \`maximal auth\`." }` (`requireGithubAuth`) |

## GitHub token gate (`requireGithubAuth`)

Mounted on `publicApp` only, on `/chat/completions(/*)`, `/models(/*)`,
`/embeddings(/*)`, `/responses(/*)`, `/v1/*`, and `/:provider/v1/*`.

When the engine boots **without** a GitHub token the HTTP server still listens
— so a supervisor can drive sign-in over `/control` — but every
upstream-touching endpoint answers the `not_authenticated` 401 above instead of
crashing or firing the device-code flow. It runs *after* the client-auth
middleware, so under enforcement an unkeyed request sees `authentication_error`
first and never reaches this gate.

## Where credentials attach on the way out

**ADR-0001: a credential becomes an `Authorization` / `x-api-key` header in
exactly one file**, `src/lib/http/send-request.ts`. The mechanism — not the
caller — picks the credential, keyed on the **destination host**
(`attachHostAuth`), compared by parsed URL **origin**, never by string prefix:

| Destination | Credential |
|---|---|
| `copilotBaseUrl(state)` | `Authorization: Bearer <state.copilotToken>` |
| `getGitHubApiBaseUrl()` | `Authorization: token <githubToken>`, or `Bearer` under the opencode OAuth app |
| `https://api.anthropic.com` | `x-api-key: <anthropicApiKey>` (count_tokens only), when configured |
| anything else (incl. `github.com/login/*`) | none — a typo'd host fails unauthenticated rather than leaking |

The `github.com/login/*` row is the *default* arrangement, and it holds because
the login host and the API host are two different origins. Under
`GITHUB_API_BASE` (below) they are deliberately collapsed onto one, so the
device-flow endpoints then sit on the credentialed origin and do receive the
GitHub token. That is the intended trade: routing the override through
`getGitHubApiBaseUrl()` is precisely what keeps the origin comparison
recognising the configured host, so a fixture-pointed auth path stays
credentialed instead of silently going anonymous. It is also why the override
itself is bounded to a loopback origin under `NODE_ENV=test` (#133) — the
environment must not be able to name a *remote* credential destination, which
is the guarantee this whole mechanism exists to make. The override is inert in
production, so nothing about the default posture changes.

There is **one** `fetch` sink (`dispatch`) and one CodeQL
`js/file-access-to-http` suppression. The invariant is enforced by a
`no-restricted-syntax` rule in `eslint.config.js` that bans hand-attaching an
auth header anywhere under `src/**`.

Two documented exceptions:

1. **`sendProviderRequest`** — the config-selected passthrough provider
   (`/:provider/*`) has an arbitrary user-configured base URL, so the host
   cannot resolve it. The resolved `ResolvedProviderConfig` (host + key + scheme
   bundled) is passed in and `attachProviderAuth` applies it. That supplies the
   credential *object*; it is not a choice among ambiguous labels. Still inside
   the same file and the same sink.
2. **`src/routes/messages/web-tools/executor.ts`** — the only `ignores` entry in
   the ESLint rule besides the mechanism itself. It forwards a *separate*
   sandbox key (`OLLAMA_API_KEY`) to the web-tools service; a different
   credential domain, not folded into `sendRequest` yet.

`SendRequestInit.githubToken` is a narrower affordance, not an exception: it
supplies a candidate token value during sign-in, before that token is in
`state`. It does not change which credential the host selects.

## Upstream authentication (proxy → Copilot)

### Token exchange

`src/lib/auth/token.ts`, `src/lib/auth/github-token-store.ts`. The token type is
inferred from its prefix (`inferTokenType`):

- **`gho_*`** (OAuth-App user token) — accepted directly by the Copilot edge.
  Used as the Copilot bearer with no exchange and no refresh loop.
- **`ghu_*`** (GitHub-App user-to-server token, the default from client id
  `Iv1.b507a08c87ecfe98`) — exchanged at `COPILOT_TOKEN_PATH`
  (`/copilot_internal/v2/token`) on the active GitHub API host
  (`getCopilotTokenUrl`), which returns `{ token, refresh_in, endpoints: { api } }`.
- anything else → `unknown`, treated like `ghu_`.

The minted bearer is cached as `state.copilotToken` and kept fresh by
`runCopilotRefreshLoop`: the refresh deadline is
`now + max(refresh_in * 1000 - 60_000, 1_000)`, approached in slices of at most
`REFRESH_POLL_INTERVAL_MS` (15 s) so an abort is observed promptly; a failed
refresh retries after `RETRY_REFRESH_DELAY_MS` (15 s), and an auth-fatal
rejection is retried up to `maxFatalRefreshRetries` (3) before being treated as
fatal.

### Host discovery & migration

`copilotBaseUrl(state)` (`src/lib/config/api-config.ts`), highest precedence
first:

1. **Enterprise (GHES)** — `COPILOT_API_ENTERPRISE_URL` domain →
   `https://copilot-api.<domain>`.
2. **opencode OAuth app** (`COPILOT_API_OAUTH_APP=opencode`) →
   `https://api.githubcopilot.com`; its tokens are only valid against the apex.
3. **Token-discovered** — `state.copilotApiUrl`, taken from `endpoints.api` on
   the mint/refresh response and validated + branded by `toCopilotHost()`
   (https-only). Re-applied on **every** mint and refresh, which is how a
   long-running session self-heals when GitHub migrates an account to another
   Copilot host (the wrong host answers `421 Misdirected Request`).
4. **Account-type default** — `hostForAccountType(state.accountType)`.

The two config-driven overrides outrank discovery **intentionally**: both are
explicit operator choices pinning the edge, and a discovered `endpoints.api`
must not silently redirect them.

### GitHub host override (`GITHUB_API_BASE`)

`getGitHubBaseUrl()` / `getGitHubApiBaseUrl()` (`src/lib/config/api-config.ts`),
highest precedence first:

1. **`GITHUB_API_BASE`** — a **test-only, loopback-only** full origin
   (`http://127.0.0.1:8787`, `http://[::1]:8787`). It replaces **both** hosts:
   the login/OAuth host and the API host. One variable covers both because the
   device-code flow straddles them — `/login/device/code` and
   `/login/oauth/access_token` are login-host paths, while `/user` and
   `/copilot_internal/*` are API-host paths — and the override exists so a
   **single** local fixture can serve the whole auth path deterministically and
   offline. Modelling a *split* deployment is what `COPILOT_API_ENTERPRISE_URL`
   is for.
2. **`COPILOT_API_ENTERPRISE_URL`** — a bare domain, re-prefixed `https://` and
   `https://api.`. It cannot express a loopback origin (no scheme, no port),
   which is why the override is a second variable rather than a reuse.
3. **Public GitHub** — `https://github.com` / `https://api.github.com`.

An accepted `GITHUB_API_BASE` wins because it is the more explicit of the two:
a full origin, not a domain to be re-prefixed. Acceptance is deliberately
narrow, because the overridden origin is the one that receives the GitHub
credential (above): the value is honoured only under `NODE_ENV === "test"`,
only with scheme `http:`, only for the loopback literals `127.0.0.1` and
`[::1]` (not the name `localhost`), and only with no userinfo, no path beyond
`/`, no query and no fragment. Everything else — a typo included — is ignored
and the defaults stand, because a bad value must not null out the auth path.
An accepted value is normalized to its origin. That set still admits
`http://127.0.0.1:<ephemeral port>`, which is the entire use case, and admits
no remote origin at all. It does **not** affect `copilotBaseUrl(state)`, which
is the LLM edge rather than the auth path. Covered by
`tests/github-api-base-override.test.ts`, which asserts every rejected shape by
name and drives the real device-code flow against a `Bun.serve({ port: 0 })`
fixture on both loopback families.

## Injected upstream headers

Built by `copilotHeaders(state, requestId, vision)`
(`src/lib/config/api-config.ts`). **`Authorization` is not in this set** — it is
attached downstream by `send-request.ts` (ADR-0001). Everything these builders
return is non-secret.

**GitHub Copilot (default — `githubCopilotHeaders`):**

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `copilot-integration-id` | `vscode-chat` |
| `editor-device-id` | `<state.vsCodeDeviceId>` |
| `editor-version` | `vscode/<state.vsCodeVersion>` |
| `editor-plugin-version` | `copilot-chat/0.46.0` |
| `user-agent` | `GitHubCopilotChat/0.46.0` |
| `openai-intent` | `conversation-agent` (overridden per endpoint) |
| `x-github-api-version` | `2025-10-01` |
| `x-request-id` | per-request UUID |
| `x-agent-task-id` | same UUID as `x-request-id` |
| `x-vscode-user-agent-library-version` | `electron-fetch` |
| `x-interaction-type` | `conversation-agent` (overridden per endpoint) |
| `copilot-vision-request` | `true` — only when `vision === true` |
| `vscode-machineid` | `<state.macMachineId>` — optional |
| `vscode-sessionid` | `<state.vsCodeSessionId>` — optional |

**opencode OAuth app:** `Accept` + `Content-Type: application/json`,
`User-Agent: opencode/<version> ai-sdk/... , opencode/<version>` (an inbound
`opencode/*` user-agent is preferred and normalised),
`Openai-Intent: conversation-edits`, plus optional `x-session-affinity`,
`x-parent-session-id` (both from the request context) and
`Copilot-Vision-Request`.

`buildCopilotHeaders` (`src/services/copilot/upstream-request.ts`) is the shared
entry point for the three completion builders: base headers +
`x-initiator` + `prepareInteractionHeaders` + `prepareForCompact`.

### Per-endpoint overrides

| Endpoint | Overrides |
|---|---|
| `/v1/messages` | `x-initiator`; optional `anthropic-beta`; `prepareMessageProxyHeaders()` sets `x-interaction-type` + `openai-intent` to `messages-proxy`, swaps `user-agent` to `vscode_claude_code/…`, regenerates a fresh `x-request-id`/`x-agent-task-id` pair, and **deletes** `copilot-integration-id` |
| `/chat/completions` | `x-initiator`; `x-interaction-type: conversation-subagent` when a subagent marker is present; optional `x-interaction-id: <sessionId>` |
| `/responses` | `x-initiator`; `x-interaction-type` / `openai-intent` / `x-interaction-id` via `prepareInteractionHeaders()` + `prepareForCompact()` |
| `/models` | `copilotModelsHeaders()`: `x-interaction-type: model-access`, `openai-intent: model-access`; `x-interaction-id` and `content-type` **removed** |
| `/embeddings` | base headers only; no rate-limit check, no initiator |

Under the opencode OAuth app, `prepareInteractionHeaders`,
`prepareMessageProxyHeaders`, and the `conversation-other` half of
`prepareForCompact` are all suppressed — that client's upstream contract does
not carry the interaction headers.

`x-initiator` is billing-relevant (Copilot bills an agent turn differently from
a user turn), so it is single-sourced in
`src/services/copilot/agent-initiator.ts` with one function per request shape:

- **Messages** — `user` only when the last message has role `user` *and* its
  content is not composed solely of `tool_result` blocks. Assistant turns,
  tool-result-only user turns, and an empty history are `agent`.
- **Chat Completions** — `agent` when the last message role is `assistant` or
  `tool`; empty history is `user`.
- **Responses** — `agent` when the last input item has role `assistant`, or has
  no role at all (function-call / reasoning items); empty input is `user`.

`prepareForCompact` additionally forces `x-initiator: agent` on a detected
compaction request.

## Rate limiting

### Client-side throttle

`checkRateLimit` (`src/lib/http/rate-limit.ts`), governed by
`state.rateLimitSeconds`. It is **not** middleware — it is called at the top of
the `/v1/messages`, `/responses`, and `/chat/completions` handlers only.
`/embeddings`, `/models`, and the non-completion surfaces are unthrottled. When
a request arrives inside the window the proxy either waits
(`state.rateLimitWait`) or throws:

```
429  { "message": "Rate limit exceeded" }
```

### Upstream rate-limit signal

Copilot returns `x-usage-ratelimit-session` and `x-usage-ratelimit-weekly`,
formatted `rem=<remaining>&rst=<reset-epoch>`. `logCopilotRateLimits`
(`src/lib/errors/copilot-rate-limit.ts`) parses and **logs** them on every
upstream completion response; they are not surfaced to the client except as part
of the verbatim `x-*` relay on a 429 (below).

## Upstream error contract

A non-OK upstream response is handled in two stages.

**Stage 1 — classify, at the call site.** `finishUpstreamResponse`
(`src/services/copilot/upstream-request.ts`) parses the body with
`parseCopilotErrorBody` (`src/lib/errors/copilot-error-parser.ts`), which pulls a
human message from `message` / `notification.message` / `error.message` /
`error` / `error_description` and a remediation URL from `documentation_url` /
`message_url` / `url` / `notification.url` / an embedded `github.com` link. Then
`isAuthFatal(status, parsed)`:

- `401` → always auth-fatal.
- `403` → auth-fatal **only** with an entitlement marker in the message or URL
  ("terms of service", "not entitled", "license revoked", "subscription
  required", "copilot/signup", …).
- `402`, `429`, any other `4xx`/`5xx` → never auth-fatal.

Auth-fatal throws `CopilotAuthFatalError`; anything else calls
`setLastUpstreamRejection` (a dismissable state flag the next success clears via
`clearLastUpstreamRejection`) and throws `HTTPError`.

**Stage 2 — respond.** `forwardError(c, error)` (`src/lib/errors/error.ts`):

| Class | Client status | Client body | Side effect |
|---|---|---|---|
| `CopilotAuthFatalError`, re-mint **succeeds** (`rearmCopilotAuth()` → `"online"`) | `503` | `{ error: { message: "Re-authenticated with Copilot after a stale token; please retry the request.", type: "server_error" } }` | A fresh bearer is live; nothing is cleared |
| `CopilotAuthFatalError`, re-mint **transiently fails** (`"offline"`) | `503` | `{ error: { message: "Reconnecting to Copilot; please retry the request.", type: "server_error" } }` | Nothing cleared — a network blip must not wedge the session |
| `CopilotAuthFatalError`, re-mint **rejected** (`"auth_fatal"`) | upstream status (401/403) | `{ error: { message, type: "auth_fatal", remediation_url? } }` | `markAuthDegraded()` — drops the live token and flags the account needs-reauth, but **retains the on-disk credential**. Degradation is non-destructive |
| `HTTPError` | upstream status | `{ error: { message, type: "error" } }`, message reframed by `adviseUpstreamError` (`src/lib/errors/upstream-error-advice.ts`) when the failure is recognisable, else the raw body | On `429`, the upstream `retry-after` and every `x-*` header are copied to the client response |
| anything else | `500` | `{ error: { message: "<err.message>", type: "error" } }` | — |

The re-mint step is the important one and is new since the pre-split text: a
completion `401` is frequently a merely **stale** ~25-minute bearer (a laptop
that slept), not a dead GitHub identity. The mint is the discriminator — it only
fails if the identity is genuinely bad — so the proxy re-mints first and asks
the client to retry, instead of terminally degrading a recoverable session. The
old "clear the token and sign out" model is gone; nothing on this path deletes a
saved account.

## Timeouts

`src/lib/http/http-timeouts.ts`, applied via `AbortSignal.timeout()` (Bun's
`fetch` has no default timeout, so a half-open connection would otherwise hang
forever):

- `COPILOT_TOKEN_TIMEOUT_MS = 30_000` — token mint + the refresh self-loop.
- `GITHUB_API_TIMEOUT_MS = 15_000` — `/user`, `/copilot_internal/user`, the
  device-code request.
- `DEVICE_POLL_TIMEOUT_MS = 15_000` — one device-code poll attempt.

Per-completion upstream fetches carry no ceiling — they inherit Copilot's own
latency, and a streaming response is held open for the duration of the stream.

## Acceptance

Verified 2026-08-05 against an engine started with `--port 0 --control-port 0`,
once with a default config and once with
`{"auth":{"enforce":true,"apiKeys":["…"]}}`.

1. **Version + trace stamp.** Every response, on both listeners, carries
   `x-maximal-version` and `x-trace-id`. ✅
2. **Structural split.** `POST /control/rpc` on the public port → `404`; on the
   control port → a JSON-RPC result. The control port refuses connections on the
   LAN address. ✅
3. **Origin guard.** `/control/rpc` with `Origin: http://evil.example` → `403`
   `csrf_error`; with `Origin: http://127.0.0.1:<controlPort>` → `200`; with the
   *public* port in the origin → `403`. No `Origin` → `200`. ✅
4. **CORS.** `OPTIONS /v1/messages` echoes `Access-Control-Allow-Origin` only for
   a localhost origin on the control port; an evil origin and a public-port
   origin both get `Vary: Origin` and **no** allow-origin header. ✅
5. **Key extraction.** Under enforcement, `x-api-key: <valid>` and
   `Authorization: BeArEr <valid>` both pass; `?key=<valid>` returns `401`. ✅
6. **Enforcement.** Unkeyed and wrong-key `/v1/models` → `401`
   `authentication_error` + `WWW-Authenticate: Bearer realm="copilot-api"`. ✅
7. **Bypasses under enforcement.** `/`, `/status`, `/setup-status`,
   `/openapi.json` → `200` unkeyed; `OPTIONS /v1/messages` → `204` unkeyed;
   `/control/rpc` → `200` unkeyed (bypassed before any key is read);
   `/token-usage` from loopback → `200` unkeyed. ✅
8. **Loopback gating.** From a non-loopback peer: `GET /usage` unkeyed → `401`;
   `POST /_internal/shutdown` **with a valid API key** → `404`. `/status` from the
   same peer → `200`. ✅
9. **GitHub token gate.** With a valid API key but no GitHub token, `/v1/models`
   → `401` `not_authenticated`, and the server stays up. ✅
10. Not exercised live (needs a Copilot account): the upstream header set, the
    `x-initiator` derivations, the `429` header relay, and the auth-fatal
    re-mint path. Those sections are read from source and cite their symbols.
