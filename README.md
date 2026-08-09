# maximal-core

The headless proxy core of [maximal](https://github.com/stuffbucket/maximal).
A local HTTP proxy that lets Anthropic-API and OpenAI-API clients (Claude
Code, Codex, and similar) talk to GitHub Copilot's backend, including GitHub
Enterprise deployments. It adds a server-side web-tools agent loop, model-id
rewriting, and a runtime-selected search/fetch executor.

This package (`@stuffbucket/maximal-core`) is **headless** — there is no UI,
no menu-bar shell, and it serves no browser pages. It exposes a decoupled
`/control` JSON-RPC 2.0 API that a separate UI tier or desktop app consumes over
loopback (Ollama-style). See [Relation to `maximal`](#relation-to-maximal).

## What this gives you

Run the proxy locally, point your client at it, and Copilot serves the model.
Claude Code thinks it's talking to `api.anthropic.com`; Codex thinks it's
talking to `api.openai.com`; both are actually hitting GitHub Copilot. GHE is
supported via `COPILOT_API_ENTERPRISE_URL`.

Server-side web tools (`web_search_20250305`, `web_fetch_20250910`) that
Copilot rejects natively are resolved by an internal agent loop: the proxy
strips the server-side declaration, substitutes a client-side shim, drives the
model through tool round-trips with Copilot, and synthesizes the
Anthropic-shaped result blocks back to the client. The search backend is picked
at runtime by `chooseExecutor` (`src/routes/messages/web-tools/executor.ts`), in
this order: `OLLAMA_API_KEY` set → ollama.com hosted search; else a
`/responses`-capable GPT model in the live catalog → Copilot's native
server-side search, no extra key; else an in-process DuckDuckGo HTML scrape.
`maximal debug` reports which one is selected.

## Endpoints

The data-plane routes below bind `127.0.0.1:4141` by default. The **control
plane is a second listener on its own ephemeral port**, loopback-only — see
*Two listeners* below.

| Path | Listener | Purpose |
|---|---|---|
| `POST /v1/messages`, `/v1/messages/count_tokens` | public | Anthropic-compatible messages API |
| `POST /:provider/v1/messages`, `/:provider/v1/models` | public | Provider-scoped Anthropic-compatible endpoints |
| `POST /chat/completions`, `/v1/chat/completions` | public | OpenAI-compatible chat completions |
| `POST /responses`, `/v1/responses` | public | OpenAI Responses API |
| `POST /embeddings`, `/v1/embeddings` | public | Embeddings |
| `GET /models`, `/v1/models` | public | Model catalog |
| `GET /status` | public | Identity + liveness probe (unauthenticated) |
| `GET /` | public | `Server running` identity probe used by port contention |
| `GET /setup-status`, `/openapi.json` | public | Fresh-install status + its OpenAPI document (unauthenticated) |
| `GET /usage`, `/token-usage`, `/token-usage/events` | public | Usage surfaces (loopback callers skip the API key) |
| `POST /_internal/shutdown` | public | Graceful eviction target for `maximal start --replace` (loopback-only) |
| `POST /control/rpc` | **control** | Decoupled control API — stateless JSON-RPC 2.0; live push via `subscriptions/listen` |
| `GET /control/*` | **control** | Deprecated REST mirror of the same builders |
| `GET /_debug/state` | **control** | Live effective state, gated on `--verbose` |

The proxy endpoints require a GitHub token (from `maximal auth`); without one
the server still listens but upstream routes answer `401 not_authenticated`.

## Install

`maximal-core` is published as `@stuffbucket/maximal-core` and installs the
`maximal` command (`dist/main.js`). It is on the **GitHub Package Registry**,
not npmjs, so an install needs the scope pointed at it and an authenticated
token:

```sh
echo "@stuffbucket:registry=https://npm.pkg.github.com" >> .npmrc
bun add @stuffbucket/maximal-core
```

**The `maximal` command needs Bun on PATH.** `dist/main.js` is a
`bun build --target=bun` bundle — it uses Bun-runtime internals, so its shebang
asks for `bun` and Node cannot execute it. `engines.node` covers the library
half (`dist/lib`, an esbuild bundle a Node consumer can import); it does not
cover the CLI. v0.4.4 shipped with a `node` shebang and a `maximal start` that
died on `__require is not a function` — see #94.

Tags v0.2.0 … v0.4.3 predate the package and exist only as git refs; a git
dependency on this repo still resolves and still works. Run from source for
development:

```sh
bun install
bun run ./src/main.ts auth --verbose                       # one-time device flow
bun run ./src/main.ts start --account-type enterprise      # listen on :4141
```

Build a standalone bundle with `bun run build` (`bun build src/main.ts
--target=bun --outdir dist`). It refuses to run when your Bun is not the one
`.bun-version` pins, because the bundle is committed and its bytes are a
function of the Bun version — use `bun run container:run -- bun run build`.

## Run

Sign in once with the CLI device-code flow, then start the proxy:

```sh
maximal auth --verbose                       # one-time device flow
maximal start --account-type enterprise      # listen on :4141
```

Then point Claude Code at the proxy:

```sh
ANTHROPIC_BASE_URL=http://localhost:4141 \
ANTHROPIC_AUTH_TOKEN=anything \
ANTHROPIC_MODEL=claude-sonnet-4-6-20260301 \
claude
```

The CLI (`src/main.ts`, via `citty`) dispatches these subcommands: `auth`,
`start`, `setup`, `app`, `api`, `uninstall`, `check-usage`, `debug`.

## Configuration

Settings can be supplied through five sources. Higher in the list wins:

| # | Source | Lifetime | Notes |
|---|---|---|---|
| 1 | **CLI flags** | per-invocation | `--port`, `--account-type`, `--verbose`, etc. See `maximal start --help`. |
| 2 | **Environment variables** | shell scope | `OLLAMA_API_KEY`, `ANTHROPIC_API_KEY`, `COPILOT_API_HOME`, `COPILOT_API_ENTERPRISE_URL`, `COPILOT_API_OAUTH_APP`, `GITHUB_API_BASE`. Bun also auto-loads `.env`. |
| 3 | **Secrets files** | persistent, mode 0600 | `~/.local/share/maximal/secrets/<provider>` (e.g. `secrets/ollama`). Refused if mode is broader than 0600. |
| 4 | **Config file** | persistent | `~/.local/share/maximal/config.json`. Schema-validated at boot; bad keys fail with a key path. Unknown keys warn but pass through. |
| 5 | **Built-in defaults** | always | `src/lib/config/config.ts`. |

The XDG home (`~/.local/share/maximal`, overridable via `COPILOT_API_HOME`)
and config are shared with the parent `maximal` app.

### Knob reference

| Knob | CLI | Env | File | Default |
|---|---|---|---|---|
| Public `/v1` port | `--port` / `-p` | — | — | `4141` |
| Control-plane port | `--control-port` | — | — | `0` (ephemeral) |
| Busy-port policy | — | — | `config.server.portPolicy` | `next` |
| Account type | `--account-type` / `-a` | — | — | `individual` |
| Verbose logging | `--verbose` / `-v` | — | — | off |
| Manual approval | `--manual` | — | — | off |
| Rate limit (s) | `--rate-limit` / `-r` | — | — | unset |
| Wait on rate limit | `--wait` / `-w` | — | — | off |
| Evict a running instance | `--replace` | — | — | off |
| Ollama API key | — | `OLLAMA_API_KEY` | `secrets/ollama` | unset |
| Anthropic API key | — | `ANTHROPIC_API_KEY` | `secrets/anthropic` | `config.anthropicApiKey` |
| GitHub token | `--github-token` / `-g` | — | `app/github_token` | from `auth` flow |
| App home dir | — | `COPILOT_API_HOME` | — | `~/.local/share/maximal` |
| Enterprise URL | — | `COPILOT_API_ENTERPRISE_URL` | — | unset |
| GitHub host override | — | `GITHUB_API_BASE` | — | unset |
| OAuth app ID | — | `COPILOT_API_OAUTH_APP` | — | upstream default |
| Use Messages API | — | — | `useMessagesApi` | `true` |
| Use Apply Patch | — | — | `useFunctionApplyPatch` | `true` |
| Responses web search | — | — | `useResponsesApiWebSearch` | `true` |
| Small model alias | — | — | `smallModel` | `gpt-5-mini` |
| Claude token multiplier | — | — | `claudeTokenMultiplier` | `1.15` |
| Prompt-cache retention | — | — | `promptCacheRetention` | unset (param omitted) |
| Auto-recover account | — | — | `autoRecoverAccount` | `false` |
| Update check | — | — | `checkUpdates` | `true` |
| Log retention (days) | — | — | `logRetentionDays` | `7` (`0` = delete on cleanup tick) |
| Token-usage retention (days) | — | — | `tokenUsageRetentionDays` | `365` (`0` = keep forever) |

The full `AppConfig` shape is `src/lib/config/config.ts`; the `start` flags are
`src/lib/start/cli.ts` (or `maximal start --help`).

`GITHUB_API_BASE` is a full origin (scheme, host, and port — e.g.
`http://127.0.0.1:8787`) that replaces **both** GitHub hosts at once: the
login/OAuth host (`https://github.com`, which serves `/login/device/code` and
`/login/oauth/access_token`) and the API host (`https://api.github.com`, which
serves `/user` and `/copilot_internal/*`). The device-code sign-in flow spans
both, so one variable covers both — that is what lets a single local fixture
server answer the whole auth path for deterministic offline testing. It
outranks `COPILOT_API_ENTERPRISE_URL`, which takes a bare *domain* and always
re-prefixes `https://`, and so cannot express a loopback origin. A value that
is not a parseable `http:`/`https:` URL is ignored; only the origin is used.
Unset (the default) leaves every host exactly as before.

Secrets follow that order with no exceptions: `readSecret()` in
`src/lib/auth/secrets.ts` resolves env → file → unset, and the Anthropic key
adds the config tier below both (`getAnthropicApiKey()` in
`src/lib/config/config.ts`). The boot loader materializes each secrets file into
its env var, so an env read covers tiers 2 and 3 together.

To inspect what the proxy actually thinks its config is:

```sh
maximal debug                    # human-readable
maximal debug --json             # machine-readable
curl http://127.0.0.1:$CONTROL_PORT/_debug/state | jq  # --verbose; port from the boot banner
```

Secrets are masked everywhere — the debug output reports `<env>` /
`<file>` / `<config>` / `<unset>`, never the value.

## Relation to `maximal`

`maximal-core` was extracted from
[`stuffbucket/maximal`](https://github.com/stuffbucket/maximal) to hold only
the headless proxy engine. The UI that used to live in the parent repo (the
menu-bar shell, the React settings UI, and the engine-served `/ui`,
`/settings/api`, and `/ws` surfaces) is **not** part of core. In its place,
core exposes the decoupled `/control` JSON-RPC 2.0 API
([`docs/architecture.md`](docs/architecture.md)) so a separate UI-server tier or
desktop app can drive it over loopback HTTP, the same way a client talks to
Ollama. Auth is CLI-only (`maximal auth`, device-code flow).

### Two listeners

`/v1` and the control plane bind **separate ports** (maximal-core#10):

- **Public** — `/v1` and the proxy routes, on `4141` by default. Third-party
  tools hardcode this. If it is held, core falls back to the next free port and
  says so; it never evicts the occupant.
- **Control** — JSON-RPC, live events, `/_debug`, on an **ephemeral** port bound
  to loopback only. Nothing external is meant to find it.

They are separate Hono apps, so `/v1` is not merely filtered off the control
port — it is not mounted there at all. Both bound ports are reported by the boot
banner, the stdout ready-line, `/status`, and `server/discover`.

A desktop shell consumes core as a **sidecar binary**, not a library: it spawns
`maximal start`, reads the bound ports off the stdout ready-line, and supervises
the process. It does **not** need to pass `--port 0`: the control plane is
already ephemeral by default, and forcing the *public* port to be ephemeral
too would defeat the split — third-party tools would have no stable `/v1` to
find. Pass `--port 0` only when you deliberately want a private engine that
serves nobody else.

Read both ports off the ready-line rather than assuming either: `controlPort`
for JSON-RPC, `proxyPort` to advertise `/v1` (it is not necessarily 4141, since
a held port falls back).

```
@@MAXIMAL_READY@@ {"v":1,"controlPort":51234,"proxyPort":4141,"pid":99}
```

`./supervisor` publishes the helpers for that (`awaitReadyLine`,
`parseReadyLine`, `sidecarSpawnEnv`) and owns the ready-line parser so hosts do
not re-derive the format. It accepts the pre-#14 single-port line too, so a
newer host can supervise an older engine. `./control-contract` publishes the
wire types with no engine dependency.

## Layout

```
src/                       Proxy source: CLI, routes, lib, services.
src/routes/                HTTP handlers grouped by endpoint family.
src/lib/                   Shared utilities (config, auth, http, models, live/control hub).
src/services/              Upstream API clients (Copilot, GitHub, providers).
tests/                     bun-test suites.
downstream/                Simulated consumer, compiled by `bun run typecheck:downstream`.
docs/spec/                 Feature specs (tool-bridge, observability, wire PRDs);
                           docs/spec/archive/ holds superseded ones (web-tools).
docs/decisions/            ADRs.
docs/admin/                Operator/MDM reference, and what `main` enforces
                           (docs/admin/branch-rulesets.md).
scripts/                   Dev harnesses (scripts/dev/) and release/ops tooling (scripts/ops/).
LICENSE                    MIT.
THIRD-PARTY-LICENSE        Bundled-dependency license pointer (npm SBOM).
```

## Releasing

`docs/release-runbook.md` is the canonical checklist. A release is a **GitHub
milestone whose title is the tag**: assigning a PR to `vX.Y.Z` pre-selects its
release, so what ships is reviewable before the tag exists. `bun run
release:notes vX.Y.Z` turns the milestone into changelog-shaped Markdown, and
and cutting it takes two commands with a merged pull request between them.
`bun run release:prepare vX.Y.Z` refuses a dirty tree, an off-pin Bun, or a
milestone `release:notes` would not emit for, then bumps, rebuilds `dist/`,
writes the changelog entry, commits all of it on `release/vX.Y.Z`, pushes the
branch and opens the PR — it cuts no tag. Once that PR is merged,
`bun run release:tag vX.Y.Z` cuts the annotated tag on `main`'s merged HEAD,
which is what publishes the package (`publish-package.yml`) and re-runs the tag
gates (`release-tag-check.yml`). Core attaches no binaries.

`main` requires a pull request, three green checks (`test`, `windows`, `gate`)
and a branch that is up to date before it will merge. There is no exemption and
no bypass actor — the release commit included, which is why it takes a PR at all
— see [`docs/admin/branch-rulesets.md`](docs/admin/branch-rulesets.md).

## Status

Pre-alpha. Functional end-to-end against enterprise Copilot. See
[`docs/architecture.md`](docs/architecture.md) for the control surface and
`docs/spec/archive/web-tools.md` for the agent-loop spec.
