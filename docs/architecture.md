# Architecture

`maximal-core` is a **headless** local proxy that exposes the GitHub Copilot
API as both an OpenAI-compatible and Anthropic-compatible HTTP service. It uses
GitHub Copilot the same way Opencode's built-in Copilot provider does:
authenticate with the user's own Copilot license, route requests to the Copilot
endpoint, translate the response shape. The entry point is `src/main.ts` (CLI
via `citty`), which dispatches to subcommands: `auth`, `start`, `setup`, `app`,
`api`, `uninstall`, `check-usage`, `debug`.

There is no UI in core. A decoupled UI tier or desktop app drives the engine
over the loopback `/control` JSON-RPC 2.0 surface, with SSE for the live stream
(see [Control API + live event stream](#control-api--live-event-stream)).

## Request flow for `/v1/messages` (Anthropic path)

`src/routes/messages/handler.ts` is the core dispatch logic:

1. Rate limit check
2. Parse Anthropic payload
3. Detect subagent marker (`__SUBAGENT_MARKER__` in `<system-reminder>`) → sets `x-initiator: agent`
4. Detect compact requests (Claude Code context compaction)
5. Force `smallModel` for tool-less warmup/probe requests (default `gpt-5-mini`; **warmup only** — distinct from the Claude Code *haiku tier*, which carries subagent tool calls and must stay tool-competent: see `src/lib/models/small-model.ts` `resolveSmallToolModel`)
6. Merge mixed `tool_result` + text blocks to avoid fresh premium request
7. Normalize model ID → look up Copilot model
8. Route to one of three upstream flows:
   - `handleWithMessagesApi` — Copilot native `/v1/messages` (Claude models, preferred)
   - `handleWithResponsesApi` — Copilot `/responses` (GPT models)
   - `handleWithChatCompletions` — fallback for everything else

## Key directories

| Path | Purpose |
|---|---|
| `src/server.ts` | Hono app, middleware stack, route registration |
| `src/lib/` | Shared utilities: config, state, auth, tokens, rate-limit, models, tokenizer, trace, and the `live/` control hub |
| `src/routes/` | Route handlers grouped by endpoint family |
| `src/routes/control/` | The decoupled control API + SSE event stream (loopback-only) |
| `src/services/` | Upstream API clients (Copilot, GitHub, providers) |
| `tests/` | All test files (`*.test.ts`), Bun built-in runner |

There is no `shell/`, and no `routes/ui`, `routes/settings`, `routes/ws`, or
`lib/ws` — those UI surfaces were removed when core was split out. `routes/control`
is the replacement.

## Mounted routes and middleware stack

`src/server.ts` builds the Hono app. Middleware runs in this order:

`traceIdMiddleware` → version-header stamp (`x-maximal-version`) → `logger()` →
`cors()` (localhost allowlist, not `*`) → `createOriginGuardMiddleware` (rejects
a present non-localhost `Origin` on control prefixes) → `createAuthMiddleware`
(API-key validation via `x-api-key` or `Authorization: Bearer`) →
`staleRefreshMiddleware` (lazy model-cache refresh, after auth).

Auth exemptions the middleware grants:

- **Unauthenticated paths:** `/`, `/status`, `/_debug/state`, `/setup-status`, `/openapi.json`.
- **Unauthenticated prefixes:** `/control/*` — the control router enforces loopback itself.
- **Loopback-only paths:** `/usage`, `/token-usage`, `/token-usage/events`, `/_internal/shutdown` — same-machine callers skip the API-key dance; remote callers still need a key.

Upstream-touching routes (`/chat/completions`, `/models`, `/embeddings`,
`/responses`, `/v1/*`, `/:provider/v1/*`) carry two additional gates, in this
order:

1. `requireSupportedBuild` (`src/lib/update/version-gate.ts`, maximal-core#7) —
   the force-upgrade lever. When the release manifest's channel declares a
   `min_supported_version` above the running build, these routes answer `426`
   with `error.type: "build_retired"`. The floor is read **synchronously** off
   the update-check cache (`checkVersionFloor`), so no request ever awaits the
   network, and **every** unknown — cold cache, timeout, non-200, malformed
   manifest, no floor declared — fails open. Everything a blocked user needs in
   order to recover is outside this set by construction: `/status`, `/`,
   `/setup-status`, `/_internal` and the whole control listener stay reachable.
   Governed by its own config key, `enforceVersionFloor` (default ON) — not by
   `checkUpdates`, which keeps its documented meaning of disabling the release
   ping entirely. Turning both off is what buys zero outbound calls.
2. `requireGithubAuth` — without a GitHub token the server still listens but
   these answer `401 not_authenticated` instead of crashing.

Both read the single `UPSTREAM_ROUTES` list in `src/server.ts`, so the two sets
cannot drift.

Mounted routers: `/_debug`, `/_internal`, `/control`, product-API
(`/setup-status` + `/openapi.json`), `/chat/completions`, `/models`,
`/embeddings`, `/usage`, `/token-usage`, `/responses`, their `/v1/*`
aliases, `/v1/messages`, and the provider-scoped `/:provider/v1/messages`
and `/:provider/v1/models`.

## Model routing

`src/lib/models/models.ts` normalizes Claude model IDs via regex patterns
(handles variants like `claude-opus-4-6`, `claude-opus-4.6`). The
`useMessagesApi` config flag (default `true`) controls whether Claude-family
models use the native Messages API or fall back to Chat Completions.

## Config and state

- `src/lib/config/config.ts` — `AppConfig` shape, disk read/write from `~/.local/share/maximal/config.json` (Linux/macOS) or `%USERPROFILE%\.local\share\maximal\config.json` (Windows). Also respects `COPILOT_API_HOME` env var.
- `src/lib/config/config-schema.ts` — zod runtime validation. Bad config → exit non-zero with key path. Unknown keys → warning, kept via `.loose()`.
- `src/lib/runtime-state/state.ts` — singleton mutable state: tokens, accountType, rate-limit, models cache.
- `src/lib/auth/github-token-store.ts` — the GitHub identity store. Multi-account registry (schema v2) at `accounts.json` beside the legacy `github_token`: `{ activeKey, accounts: Record<"login@host", AccountRecord> }`, atomic temp+rename writes. Boot reads the active account; the legacy single-record file is migrated in once (gated, offline→`unknown@host`) and kept as a rollback fallback. The three sign-in producers (device-code, CLI, gh-reuse) all persist a typed `AccountRecord`. The `/control/accounts/switch` and `/control/accounts/remove` actions edit this registry (set active → a reconnect/restart adopts it). Sign-out forgets the active account; Remove forgets a specific one; both touch only maximal's own copy — never `gh`. RMW takes no lock (safe on the single Bun process; see the comment above `addAccountToDefaultRegistry`).
- `src/lib/auth/secrets.ts` — file-based provider keys at `~/.local/share/maximal/secrets/<name>` (mode 0600). Env wins; file fills in unset values.
- `src/lib/runtime-state/cache.ts` — `Cache<K,V>` LRU wrapper with hit/miss/eviction metrics. Wrapped instances register globally for `/_debug/state`.

#### Token storage: 0600 file, no OS keyring (maximal-core#6)

The GitHub bearer lives in a `0600` file under the data home (`COPILOT_API_HOME`
/ `~/.local/share/maximal`) and nowhere else — written temp+rename with
`{ mode: 0o600 }` so the mode survives the swap, and `ensurePaths` chmods on
create. **An OS keyring was considered and deliberately not built.** Core is a
headless sidecar; a keyring would add a native dependency and three per-platform
code paths (Keychain / libsecret / Windows Credential Manager), plus a headless
story for CI and Linux runners where no keyring is unlocked — all to defend
against an attacker who can already read the user's own files *as the user*, at
which point the process memory and the live proxy port are theirs too. That is
the same model `gh auth login` ships (see ADR-0001), and the repo's documented
threat model is about the *network* surface (ADR-0021's Origin/CSRF hardening,
loopback-only control plane), not local same-user file reads. Revisit only if
core ever runs under an account the user does not control.

The paired invariant is that the bearer never leaves that file: the file sink in
`logger.ts` runs every string through `scrubSecrets` and every object through
`redactForLog`. `tests/github-token-store.test.ts` asserts the mode;
`tests/token-never-logged.test.ts` boots the real engine with a seeded token and
asserts it appears in neither stdout/stderr nor `<home>/logs/`. The one exception
is `--show-token`, an explicit operator opt-in that prints through bare `consola`
(stdout only, never the file sink) because the user asked to see it.

### Two listeners

`/v1` and the control plane bind separate ports (maximal-core#10), as two
separate Hono apps in `src/server.ts`:

| Listener | Port | Serves |
|---|---|---|
| Public | `--port`, default 4141, policy applies | `/`, `/status`, `/v1/*`, the proxy routes, `/_internal` |
| Control | `--control-port`, default 0 (ephemeral), loopback-only | `/control/*`, `/_debug/*` |

The separation is structural: `/v1` is never mounted on the control app, so it
cannot be reached there. `/_internal` stays public on purpose — `evictRunning`
takes over the public port by POSTing `/_internal/shutdown` *to that port*, and
moving it would break `--replace`.

Both bound ports are reported four ways, because a host may miss any one of
them: the boot banner, the stdout ready-line, `/status`, and `server/discover`.

The ready-line is versioned (`v: 1`) and parsed against a shared zod schema
(`readyLineSchema` in `src/lib/start/boot-status.ts`) so emitter and parser
cannot drift. `parseReadyLine` also accepts the pre-#14 `{port, pid}` shape,
normalising it by pointing both ports at the single one and reporting `v: 0` —
a host may supervise an older engine than itself. Emitter and parser have
**separate types** (maximal-core#20): `ReadyLine` is what `emitReadyLine` puts
on the wire (`v >= 1`), `ParsedReadyLine` is what `parseReadyLine` and
`awaitReadyLine` return (`0` or any `v >= 1`, normalised). Do not annotate a
parse result with `ReadyLine` — that hands a caller trusting `v >= 1` a `v: 0`.

### Port selection

`src/lib/start/port.ts` decides what to bind, driven by `config.server.portPolicy`:

| Policy | Behaviour |
|---|---|
| `next` (default) | Requested port busy → scan upward for the first usable one, up to `PORT_SCAN_LIMIT` (20). Announces the move. |
| `fail` | Report who holds it and exit 1. The pre-policy behaviour. |
| `replace` | Evict a *maximal* instance holding it, then bind. Never evicts a foreign process — that degrades to `fail`. |

Two properties worth preserving:

- **`--port 0` bypasses the policy entirely.** A supervised sidecar asks the OS to choose, so there is nothing to resolve. Every desktop-spawned engine takes this path.
- **A port is usable only when nothing answers HTTP there *and* `isPortBindable` succeeds.** These answer different questions. An HTTP probe cannot see a non-HTTP listener, and one that resolves `::1` cannot see an app holding `127.0.0.1`. The bind test deliberately tries the *specific* loopback addresses rather than only the wildcard, because Node sets `SO_REUSEADDR` and a wildcard bind will otherwise succeed alongside a specific-address one — reporting free a port the engine would then be unreachable on for any IPv4-first client.

`resolvePort` returns a decision and never exits; `portOrExit` is the single place that reports and exits. That split is what makes the policy testable without stubbing process globals.

## Control API + live event stream

Core is headless: sign-in is CLI-only and the engine serves no UI. A decoupled
UI-server tier or desktop app consumes core over the loopback `/control`
surface (Ollama-style), which replaces the removed `/settings/api` request API
and `/ws` live feed. The wire types live in `src/lib/jsonrpc/contract.ts`
(published as `./control-contract`) and `src/lib/live/contract.ts` (published as
`./contract`); the callable method set is whatever `server/discover` returns at
runtime — both are generated from the code that serves them, so neither can
drift from it the way a prose spec does.

- **JSON-RPC (canonical):** `POST /control/rpc` — stateless JSON-RPC 2.0 per
  **ADR-0023** (`stuffbucket/maximal` `docs/decisions/0023-…`). Methods are
  registered in `src/routes/control/rpc.ts`; the message layer is
  `src/lib/jsonrpc/`. No session, no cursor, no `Last-Event-ID` — MCP removed all
  three in spec 2026-07-28 and we follow that shape. `GET`/`DELETE` are `405`.
- **Capability discovery:** `server/discover` returns
  `{ protocolVersion, capabilities, identity }` with no handshake, callable at
  any time. Clients mirror the version into an `MCP-Protocol-Version` header; a
  pinned mismatch fails legibly naming both versions.
- **Live stream:** the `subscriptions/listen` method's response *is* the
  subscription — an SSE stream carrying a `control/snapshot` notification, then
  `control/<topic>` notifications until either side closes. Closing the stream is
  the unsubscribe. `ControlHub` (`src/lib/live/hub.ts`) owns fan-out and
  per-subscriber bounded queues (drop-slow-then-disconnect); it holds **no**
  cursor, ring, or epoch. A dropped feed reconnects and re-snapshots.
- **Errors** are JSON-RPC error objects carrying a string discriminant in
  `data.reason` plus `retryable`. Clients discriminate on that, never on an HTTP
  status. Application codes are positive integers: JSON-RPC reserves
  `-32768..-32000` and MCP reserves `-32020..-32099` within it.
- **REST (deprecated, one cycle):** `GET /control/{auth,accounts,apps,models,usage,config,clients,update-status,api-keys,gh/status,diagnostics}` and the `POST`/`DELETE` actions (`auth/start`, `auth/cancel`, `auth/rearm`, `auth/sign-out`, `models/refresh`, `accounts/switch`, `accounts/remove`, `quit`, `upgrade`, `api-keys`, `api-keys/:id`, `gh/use`, `apps/claude-code/toggle`, `apps/claude-desktop/toggle`) still work and share the same builders, so the two surfaces cannot drift. Registration is split between `src/routes/control/route.ts` and `src/routes/control/settings-endpoints.ts`. `GET /control/events` still streams but is **no longer resumable** — it ignores `Last-Event-ID`/`epoch`.
- **Loopback gate:** the whole `/control` surface re-checks the caller IP itself — a remote caller gets `404`, exactly like `/_internal`, *above* the JSON-RPC layer so no well-formed error confirms the endpoint exists. Cross-origin browser requests are additionally 403'd by the Origin guard.

### Not in scope: agent-run state

Core does **not** own agent runs and the control plane will not expose a read
model for them. A run's status, branch, diff summary, approval state, project,
and current-activity line are filesystem, VCS and orchestration facts that never
reach a loopback proxy — core could not populate them without a harness telling
it, so a core-owned schema would be core-owned coupling with none of the
knowledge, and a core release every time a field is added. Agent-run
orchestration belongs to the harness that does the orchestrating.

What core does own is per-request facts, tagged with a caller-supplied key it
never interprets. `traceIdMiddleware` (`src/lib/http/trace.ts`) accepts
`x-trace-id`, `x-session-affinity` and `x-parent-session-id` on any request,
echoes the trace id back, and carries all three in `AsyncLocalStorage`.
`x-session-affinity` then becomes the `session_id` on every persisted usage row
(`src/lib/token-usage/`), which records model, endpoint, timestamps, the four
token counts, nano-AIU and the premium flag. A harness that stamps its own run
id on outbound requests can therefore attribute cost and model choice per run
without core knowing what a run is.

Reading those rows back by key is not exposed today — `usage/get` returns a
day summary, not per-event rows filtered by session. Note also that the `usage`
control topic is coalesced last-value on purpose (`src/lib/live/hub.ts`): a
per-request event storm would overflow every subscriber's bounded queue and get
slow clients dropped, so "stream every request as it happens" is the shape this
design rejects. The workable pattern is the coalesced tick as a change signal,
with the consumer re-querying by key when it fires.

## Diagnostic surfaces

- **`maximal debug`** (and `--json`) — effective config, executor selection (which `Executor` `selectExecutor()` would pick), secret sources (env/file/config/unset, never values), paths.
- **`GET /_debug/state`** — live equivalent on a running proxy. 404 by default; gated on `state.verbose`. Useful when restart isn't an option.
- **`GET /status`** — unauthenticated identity + liveness probe (`service: "maximal"`, per-subsystem health; safe-for-unauth booleans/counts only).
- **Daily log** at `~/.local/share/maximal/logs/messages-handler-<date>.log` — request payloads, translated SSE events, web-tools agent traces. 7-day retention.

## Token counting

`/v1/messages/count_tokens`: when `anthropicApiKey` is configured, forwards
Claude model requests to Anthropic's free `/v1/messages/count_tokens` endpoint
for exact counts. Otherwise falls back to GPT `o200k_base` tokenizer with 1.15x
multiplier (`src/lib/models/tokenizer.ts`).

## Parallel-agent convention

This repo can collide on a shared working tree (lint-staged stash + concurrent
merge ate a turn already). The `git stash pop` prohibition is in
[`AGENTS.md`](../AGENTS.md); the isolation mechanics are:

- **Spawned subagents:** pass `isolation: "worktree"` to the Agent tool.
- **Sessions:** create a worktree manually with `git worktree add ../maximal-<task> -b agent/<task>`; clean up with `git worktree remove ../maximal-<task>` after merging back. `git worktree add` does **not** run `bun install`, so run it in the new tree if you need its node_modules.
- **Inspecting a stash is fine** — `git stash show -p stash@{N}` is read-only. It is `pop`/`apply` outside an isolated tree that corrupts another worker's state.

See also: `docs/codegen-feedback-loops-practices.md` → Dispatch and review loops.

## Testing gotchas

The rule is in [`AGENTS.md`](../AGENTS.md); the mechanism, the five incidents
behind it, and the mutant-disposition procedure are in
[`dev/testing-strategy.md`](dev/testing-strategy.md) §5.1 (module-mock leakage,
`mockModuleLeakGuard`, why a restore must hand back a spread copy captured
*before* the install — and why even a correct one is cleanup, not protection)
and §6 (mutation testing — every surviving mutant is killable, dead, or
proven-equivalent). The decision itself is
[ADR-0011](decisions/0011-mock-module-leakage-discipline.md).


## Release & PR conventions

- **A release is a GitHub milestone whose title is the tag.** There is no
  release automation in this repo — `release-please.yml` and `release.yml`
  do not exist here, and no release-please config remains. A PR
  pre-selects its release by being assigned to the `vX.Y.Z` milestone;
  whatever is in that milestone is what ships. `bun run release:notes
  vX.Y.Z` turns it into changelog-shaped Markdown. See
  [`docs/release-runbook.md`](release-runbook.md).
- **The version is chosen by a human, up front.** Pre-1.0, `feat:` and
  `fix:` both cut a **patch**, and a breaking change (`feat!:`) cuts a
  **minor** — the pre-1.0 convention inherited from release-please
  (`bump-minor-pre-major` + `bump-patch-for-minor-pre-major`), now
  enforced by `requiredBump` in
  [`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts).
  This matters more than it looks: `^0.2.0` means `>=0.2.0 <0.3.0`, so a
  breaking change released as a patch is *auto-installed* by a downstream
  consumer. Minor is the only thing that puts it out of range.
- **Conventional Commit *types* still drive the notes.** They no longer
  decide *whether* a release happens (the milestone does), but they decide
  which section an entry lands in, and a `!` is what emits the
  `BREAKING CHANGES` block. `release:notes` refuses to emit on a title it
  cannot parse rather than silently dropping the entry.
- **Squash-merge uses the PR *title* as the commit subject.** So the PR
  title must be a single valid Conventional Commit (`fix: …`, not
  `test+fix: …`). A non-standard type like `test+fix` parses as one
  unrecognized token, and since the notes are generated from PR titles it
  is the title — not the body's individual commits, which a squash
  discards — that has to be right.
- **`main` is protected by two rulesets, and they are what make every other
  gate blocking.** A PR is mandatory, squash is the only merge method,
  `test` / `windows` / `gate` are required status checks, the branch must be
  up to date before it merges (the substitute for a Merge Queue this
  user-owned repo cannot have), and `main` cannot be deleted or force-pushed.
  There is **no bypass actor on either ruleset** — the release commit goes
  through a PR like everything else (`release:prepare`, then `release:tag` on the
  merged head), and a bypass reappearing is drift. Verified by
  `bun run rules:check`; described in
  [`docs/admin/branch-rulesets.md`](admin/branch-rulesets.md).
