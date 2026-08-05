# maximal-core

The headless proxy core of [maximal](https://github.com/stuffbucket/maximal).
A local HTTP proxy that lets Anthropic-API and OpenAI-API clients (Claude
Code, Codex, and similar) talk to GitHub Copilot's backend, including GitHub
Enterprise deployments. It adds a server-side web-tools agent loop, model-id
rewriting, and an Ollama Cloud–backed search/fetch executor.

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
Anthropic-shaped result blocks back to the client. Set `OLLAMA_API_KEY` to
enable real search via ollama.com's hosted endpoints; otherwise search returns
`unavailable` and fetch runs in-process.

## Endpoints

The data-plane routes above bind `127.0.0.1:4141` by default. The **control
plane is a second listener on its own ephemeral port**, loopback-only — see
*Two listeners* below.

| Path | Purpose |
|---|---|
| `POST /v1/messages`, `/v1/messages/count_tokens` | Anthropic-compatible messages API |
| `POST /:provider/v1/messages`, `/:provider/v1/models` | Provider-scoped Anthropic-compatible endpoints |
| `POST /chat/completions`, `/v1/chat/completions` | OpenAI-compatible chat completions |
| `POST /responses`, `/v1/responses` | OpenAI Responses API |
| `POST /embeddings`, `/v1/embeddings` | Embeddings |
| `GET /models`, `/v1/models` | Model catalog |
| `GET /status` | Identity + liveness probe (unauthenticated) |
| `POST /control/rpc` | Decoupled control API — stateless JSON-RPC 2.0; live push via `subscriptions/listen`. **Separate listener**, loopback-only, ephemeral port |
| `GET /_debug/state` | Live effective state, gated on `--verbose` |

The proxy endpoints require a GitHub token (from `maximal auth`); without one
the server still listens but upstream routes answer `401 not_authenticated`.

## Install

`maximal-core` is published as `@stuffbucket/maximal-core` and installs the
`maximal` command (`dist/main.js`). Run from source for development:

```sh
bun install
bun run ./src/main.ts auth --verbose                       # one-time device flow
bun run ./src/main.ts start --account-type enterprise      # listen on :4141
```

Build a standalone bundle with `bun run build` (`bun build src/main.ts
--target=bun --outdir dist`).

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
| 2 | **Environment variables** | shell scope | `OLLAMA_API_KEY`, `ANTHROPIC_API_KEY`, `COPILOT_API_HOME`, `COPILOT_API_ENTERPRISE_URL`, `COPILOT_API_OAUTH_APP`. Bun also auto-loads `.env`. |
| 3 | **Secrets files** | persistent, mode 0600 | `~/.local/share/maximal/secrets/<provider>` (e.g. `secrets/ollama`). Refused if mode is broader than 0600. |
| 4 | **Config file** | persistent | `~/.local/share/maximal/config.json`. Schema-validated at boot; bad keys fail with a key path. Unknown keys warn but pass through. |
| 5 | **Built-in defaults** | always | `src/lib/config/config.ts`. |

The XDG home (`~/.local/share/maximal`, overridable via `COPILOT_API_HOME`)
and config are shared with the parent `maximal` app.

### Knob reference

| Knob | CLI | Env | File | Default |
|---|---|---|---|---|
| Public `/v1` port | `--port` | — | — | `4141` |
| Control-plane port | `--control-port` | — | — | `0` (ephemeral) |
| Busy-port policy | — | — | `config.server.portPolicy` | `next` |
| Account type | `--account-type` | — | — | `individual` |
| Verbose logging | `--verbose` | — | — | off |
| Manual approval | `--manual` | — | — | off |
| Rate limit (s) | `--rate-limit` | — | — | unset |
| Ollama API key | — | `OLLAMA_API_KEY` | `secrets/ollama` | unset |
| Anthropic API key | — | `ANTHROPIC_API_KEY` | `secrets/anthropic` | `config.anthropicApiKey` |
| GitHub token | `--github-token` | — | `app/github_token` | from `auth` flow |
| App home dir | — | `COPILOT_API_HOME` | — | `~/.local/share/maximal` |
| Enterprise URL | — | `COPILOT_API_ENTERPRISE_URL` | — | unset |
| OAuth app ID | — | `COPILOT_API_OAUTH_APP` | — | upstream default |
| Use Messages API | — | — | `useMessagesApi` | `true` |
| Use Apply Patch | — | — | `useFunctionApplyPatch` | `true` |
| Small model alias | — | — | `smallModel` | `gpt-5-mini` |
| Log retention (days) | — | — | `logRetentionDays` | `7` (`0` = delete on cleanup tick) |

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
`maximal start --port 0`, reads the bound port off the stdout ready-line, and
supervises the process. `./supervisor` publishes the helpers for that
(`awaitReadyLine`, `sidecarSpawnEnv`); `./control-contract` publishes the wire
types with no engine dependency.

## Layout

```
src/                       Proxy source: CLI, routes, lib, services.
src/routes/                HTTP handlers grouped by endpoint family.
src/lib/                   Shared utilities (config, auth, http, models, live/control hub).
src/services/              Upstream API clients (Copilot, GitHub, providers).
tests/                     bun-test suites.
docs/spec/                 Feature specs (web-tools, tool-bridge, observability).
docs/admin/                Operator/MDM reference.
scripts/                   Operator helpers.
LICENSE                    MIT.
THIRD-PARTY-LICENSE        Bundled-dependency license pointer (npm SBOM).
```

## Releasing

`docs/release-runbook.md` is the canonical checklist. A release is a **GitHub
milestone whose title is the tag**: assigning a PR to `vX.Y.Z` pre-selects its
release, so what ships is reviewable before the tag exists. `bun run
release:notes vX.Y.Z` turns the milestone into changelog-shaped Markdown, and
`bun run release:manual` (bumpp) cuts the version. Tagging is a deliberate
human step — this repo has no release automation.

## Status

Pre-alpha. Functional end-to-end against enterprise Copilot. See
[`docs/architecture.md`](docs/architecture.md) for the control surface and
`docs/spec/archive/web-tools.md` for the agent-loop spec.
