# Architecture

`maximal-core` is a **headless** local proxy that exposes the GitHub Copilot
API as both an OpenAI-compatible and Anthropic-compatible HTTP service. It uses
GitHub Copilot the same way Opencode's built-in Copilot provider does:
authenticate with the user's own Copilot license, route requests to the Copilot
endpoint, translate the response shape. The entry point is `src/main.ts` (CLI
via `citty`), which dispatches to subcommands: `auth`, `start`, `setup`, `app`,
`api`, `uninstall`, `check-usage`, `debug`.

There is no UI in core. A decoupled UI tier or desktop app drives the engine
over the loopback `/control` HTTP + SSE surface (see
[Control API + live event stream](#control-api--live-event-stream)).

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
`/responses`, `/v1/*`, `/:provider/v1/*`) are additionally gated on
`requireGithubAuth`: without a GitHub token the server still listens but these
answer `401 not_authenticated` instead of crashing.

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

## Control API + live event stream

Core is headless: sign-in is CLI-only and the engine serves no UI. A decoupled
UI-server tier or desktop app consumes core over the loopback `/control`
surface (Ollama-style), which replaces the removed `/settings/api` request API
and `/ws` live feed. Full contract in
[`docs/spec/control-api.md`](spec/control-api.md).

- **Reads** (`src/routes/control/route.ts`): `GET /control/{auth,accounts,apps,models,usage,config,clients}` — each mirrors a live topic; a topic's event `data` is byte-identical to its GET body.
- **Actions:** `POST /control/accounts/switch`, `POST /control/accounts/remove` — serialized through an `AsyncMutex`; each broadcasts the resulting accounts list.
- **Live stream:** `GET /control/events` (SSE). A single `ControlHub` (`src/lib/live/hub.ts`) owns the monotonic cursor, replay ring, epoch, and fan-out; the HTTP route is a thin adapter. On connect it emits a `snapshot` frame under lock, then full-resource upsert deltas per topic. `Last-Event-ID` + `epoch` resume from the ring (K8s list-watch semantics); a gap past the ring forces a re-snapshot.
- **Loopback gate:** the whole `/control` surface re-checks the caller IP itself — a remote caller gets `404`, exactly like `/_internal`. Cross-origin browser requests are additionally 403'd by the Origin guard.

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
merge ate a turn already). For parallel agents:

- **Spawned subagents:** pass `isolation: "worktree"` to the Agent tool.
- **Sessions:** create a worktree manually with `git worktree add ../maximal-<task> -b agent/<task>`; clean up with `git worktree remove ../maximal-<task>` after merging back. `git worktree add` does **not** run `bun install`, so run it in the new tree if you need its node_modules.
- **Never run `git stash pop` in a shared working tree.** It silently merges another in-flight worker's stash into your tree, and on conflict it leaves an inconsistent state that's easy to "clean up" by `rm`-ing files that aren't yours. If you need an isolated bisect, use a worktree. If you must inspect a stash, use `git stash show -p stash@{N}` (read-only) and never `pop` / `apply` outside an isolated tree.

See also: `docs/codegen-feedback-loops-practices.md` → Dispatch and review loops.

## Testing gotchas

- **`mock.module` persists forward across files in a run — now lint-enforced.**
  Bun does not reset module mocks between test files, and CI orders files
  differently than local, so an unrestored mock leaks its stub into a
  *sibling* file that then reads stale state — the classic "green locally,
  red on CI" (or vice-versa) failure. This bit us **four times** (the last
  cost a long #229 debugging loop), so an ESLint rule (`mockModuleLeakGuard`
  in `eslint.config.js`, scoped to `tests/**`) now **bans the fire-and-forget
  forms**: `void mock.module(...)` and a bare `mock.module(...)` expression
  statement both error.
  - **Awaited is *not* automatically safe.** `await mock.module(...)` passes
    the lint rule, but an awaited `afterAll` *restore* does **not** reliably
    land before the next file's static imports on CI — so a module mock that
    intercepts a *shared* module still leaks across files even when restored.
    The rule catches the common footgun, not this one.
  - **The durable fix is to not mock a shared module across files at all.**
    Prefer the **real** module (the test preload redirects `COPILOT_API_HOME`
    to a temp dir, and `getClaudeCodeSettingsPath()` honors `CLAUDE_CONFIG_DIR`
    — so config/settings round-trips are already isolated), or **injectable
    function options**. Only stub a module with no env/injection seam, keep the
    wrapper behaviorally identical (spread `...actual`, forward `...rest`), and
    prove via a sequential-import repro that it can't break a later file.
- **Green tests can still test nothing.** Mutation testing (`bun run mutate`)
  caught classification tests that passed without exercising the branch
  they claimed to cover (the fixture hit a different code path that
  returned the same value). For security-critical or branchy logic, run
  Stryker and confirm the targeted mutants actually die — don't trust a
  passing assertion alone. Every surviving mutant must land in exactly one of
  three buckets — **killable** (write the test), **dead** (delete it / encode
  the impossibility in types), or **proven-equivalent** (written proof + reason
  to keep). See [`dev/testing-strategy.md`](dev/testing-strategy.md) §6 for the
  disposition rule and the hot-path modules that warrant periodic sweeps.

## Release & PR conventions

- **Release is driven by Conventional Commit *types*.** release-please
  scans commits since the last tag; only `feat:` (minor) and `fix:`
  (patch) cut a release. `test:`/`chore:`/`ci:`/`docs:`/`refactor:` are
  release-silent. If release-please "isn't doing anything," it almost
  certainly found no `feat`/`fix` commit — check the `release-pr` step
  log for `No user facing commits found ... skipping` before assuming
  it's broken.
- **Squash-merge uses the PR *title* as the commit subject.** So the PR
  title must be a single valid Conventional Commit (`fix: …`, not
  `test+fix: …`). A non-standard type like `test+fix` parses as one
  unrecognized token and release-please skips it — even if the diff
  contains a real `fix:`. Title PRs accordingly; the body's individual
  commit messages don't reach `main` through a squash.
