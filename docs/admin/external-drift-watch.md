# External-surface drift watch

**Domain:** GitOps / operational tooling — _not_ part of the maximal proxy.
This automation maintains the product; it is not shipped in it. It lives under
`scripts/ops/` and runs in GitHub Actions, deliberately outside the product's
`bun test` root (`bunfig.toml` → `[test] root = "tests"`) and outside
`docs/architecture.md`.

## Why it exists

The proxy impersonates several third-party clients and mirrors the Anthropic
`/v1/messages` wire contract. Those upstreams live outside this repo and move on
their own schedule, so a stale hardcoded pin fails **silently** in production
(the 421 endpoint-migration and stale client-version field reports both trace to
this class of drift). The watcher turns "did an upstream we mirror move?" into a
deterministic check with no LLM and no interactive auth.

## What it watches

Each pin is compared against an authoritative upstream. The pin in `src/` is the
single source of truth — the watcher reads it, never a duplicate.

**`VERSION_PINS`** — a machine-readable "latest" exists, so these are
auto-`--fix`-able:

| Pin (source of truth)                                               | Upstream authority                                          | Signal                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `COPILOT_VERSION` — `src/lib/config/api-config.ts`                  | `microsoft/vscode-copilot-chat` latest release              | Copilot client version + proxy for `/models` schema |
| `CLAUDE_AGENT_USER_AGENT` — same file                               | `anthropics/claude-code` latest release                     | impersonated agent version                          |
| `OPENCODE_SEMVER` — same file (`OPENCODE_VERSION` derives from it)  | `sst/opencode` latest release                               | impersonated client version                         |

**`HEADER_PINS`** — upstream API-version *header* date strings. No machine-readable
"latest" exists and a bump needs a human changelog read, so these compare against
a last-reviewed baseline in `scripts/ops/external-drift-baseline.json` and route
to the **issue path only**, never `--fix`:

| Pin (source of truth)                                                     | Review before bumping                     |
| ------------------------------------------------------------------------- | ----------------------------------------- |
| `ANTHROPIC_API_VERSION` — `src/lib/models/anthropic-types.ts`             | Anthropic API versioning docs             |
| `x-github-api-version` (user/token endpoints) — `src/lib/config/api-config.ts` | GitHub REST API versions docs        |
| `x-github-api-version` (token-exchange endpoint) — same file             | GitHub REST API versions docs             |

**Baseline-only:**

| Pin (source of truth)                                               | Upstream authority                                          | Signal                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `anthropicSdkStatsSha` — `scripts/ops/external-drift-baseline.json` | `anthropics/anthropic-sdk-typescript` `.stats.yml` blob SHA | `/v1/messages` OpenAPI-spec change                  |

The runtime Copilot `/models` **values** sit behind an authed token with no
public mirror, so the watcher does not call that endpoint. A `/models` _schema_
change only ships when the Copilot client changes, which the `copilotChat`
release watch already catches — diff the live schema locally with your own
credentials when it fires.

## How it reacts (no human in the loop)

`.github/workflows/watch-external-drift.yml` runs daily. It **detects and files
an issue — it never opens a PR**:

- **Any drift** (a version pin fell behind, the Anthropic spec hash moved, or a
  check failed) → files/refreshes one idempotent `external-drift`-labelled
  issue. The body is scoped so a reconciliation PR can be derived from it
  directly: the exact file to change, current pin, target version, an
  upstream-review link, and the acceptance step.
- **Clean run** → closes a stale drift issue.

**Why issue-only, not auto-PR.** Bumping an impersonated client version can
shift proxy behaviour, so reviewing the upstream release _before_ the pin moves
is the correct gate — the watcher hands off a detailed, PR-derivable issue
rather than a narrower, blind pin rewrite. This also keeps the watcher off the
require-PR ruleset path entirely: filing an issue needs only a plain
`GITHUB_TOKEN` with `issues: write` — no app-token, and none of the "a
bot-authored PR won't trigger CI" fragility that an auto-PR path would have to
manage.

## Separation of concerns

- **Code:** `scripts/ops/watch-external-drift.ts` (alongside the other ops
  scripts). Pure Bun, deterministic.
- **Test:** `scripts/ops/watch-external-drift.test.ts`, colocated and kept out
  of the product `bun test` root. It is the **parity guard**: rename a pinned
  constant and `extractPin` reds the tooling CI before the watcher can report a
  bogus pin.
- **Tooling CI:** `.github/workflows/tooling-ci.yml` runs `bun run check:ops`
  (typecheck *and* the colocated tests) on PRs touching `scripts/ops/**`,
  `package.json`, `.bun-version`, or the workflow itself — `package.json` is in
  the filter because the parity guards assert against the real manifest. The
  daily watcher also self-checks (runs `test:ops`) before it acts. The product's
  `ci.yml` never runs tooling tests.
- **Docs:** this file (`docs/admin/`), not `docs/architecture.md`.

## Reconciling a flag

A maintainer picks the `external-drift`-labelled issue up and derives the
reconciliation PR from it. Either way:

- **Version pin:** review the linked upstream release for behavioural changes,
  then bump the pin in `src/lib/config/api-config.ts` to the target version.
  Reconcile **every** occurrence — a version can also appear verbatim in a
  coupled User-Agent string (e.g. `OPENCODE_SEMVER` is echoed in the opencode
  UA we send via `OPENCODE_VERSION`), so a search-and-replace on the bare value,
  reviewed before committing, is safer than touching only the pinned constant.
- **Header pin:** read the provider changelog linked in the issue, reconcile any
  behaviour change, then bump that pin's baseline value in
  `scripts/ops/external-drift-baseline.json` in the same change. `--fix` never
  touches these.
- **Anthropic spec hash:** review the SDK diff for new/changed message params,
  content blocks, or stream events; reconcile `src/lib/models/anthropic-types.ts`
  if needed; then bump `anthropicSdkStatsSha` in
  `scripts/ops/external-drift-baseline.json` in the same change. Current value:
  `gh api repos/anthropics/anthropic-sdk-typescript/contents/.stats.yml --jq .sha`

## Running locally

```sh
bun run watch:drift          # detect; writes a report if anything drifted
bun run test:ops             # the tooling test (scripts/ops/, its own bunfig)
```
