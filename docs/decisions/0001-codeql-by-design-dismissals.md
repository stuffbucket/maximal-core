---
id: ADR-0001
title: CodeQL by-design dismissals
status: accepted
date: 2026-05-11
amended: 2026-08-05
authors:
  - stuffbucket
links:
  codeql_config: .github/codeql/codeql-config.yml
  issue: https://github.com/stuffbucket/maximal/issues/9
---

# Context

A handful of CodeQL alerts are by-design for this project: it is an
auth-forwarding proxy, so reading a local token file and sending it to
an upstream over HTTP (`js/file-access-to-http`), and persisting a
freshly-received token back to a 0o600 file (`js/http-to-file-access`),
are exactly what the proxy exists to do. These are decisions with
rationale, not bugs to fix.

GitHub's Security tab records who dismissed each alert with what reason,
but the rationale is per-alert and not greppable. We want the "why" to
live in the repo, next to the code, surviving UI changes and account
churn.

# Decision

**Suppress by-design alerts with an inline CodeQL comment on the sink
line**, carrying the rationale inline:

```ts
const response = await fetch(url, {
  // codeql[js/file-access-to-http] -- by design: the proxy reads its own
  // 0o600 token from disk and forwards it as upstream Authorization. See ADR-0001.
  headers: authHeaders(state),
})
```

`// codeql[<rule-id>] -- <reason>` (legacy alias `// lgtm[...]`) is
CodeQL's native in-source suppression, honored by the JavaScript/
TypeScript analyzer. CodeQL emits it as a SARIF `suppressions` entry
with `@kind: IN_SOURCE`; GitHub code scanning then shows the alert as
resolved. The comment sits on the dataflow **sink** line, so it moves
with the code and the rationale is greppable at the exact point of
concern.

The current suppressed sites (grep `codeql\[` to enumerate):

| Rule | File | Why |
|---|---|---|
| `js/file-access-to-http` | `src/lib/http/send-request.ts` | **Single mechanism** — every authenticated GitHub/Copilot/provider request funnels through `sendRequest`, which attaches the disk-read token and forwards it upstream |
| `js/http-to-file-access` | `src/lib/auth/github-token-store.ts` | Persist OAuth token to 0o600 file |

This table previously also listed `scripts/gemma-watch.ts` and
`scripts/sync-homebrew-formula.ts`, neither of which exists in this repo, and
gave the other two paths as `src/lib/send-request.ts` and
`src/lib/github-token-store.ts` — both stale by one directory level. `grep -rn
'codeql\['` over `src/` returns exactly the two rows above; that grep, not this
table, is the source of truth.

The six per-service `src/services/{copilot,github}/*` suppressions were
collapsed into the single `send-request.ts` mechanism (see the token-
ownership amendment below): callers name a credential domain but never
build the auth header, so the file→HTTP sink they all route through
lives in one place and the taint terminates at one annotated line. New
authenticated endpoints inherit the suppression for free.

# Consequences

- **A suppression cannot drift.** The comment is attached to the sink
  line itself; when the code moves, the comment moves with it. There is
  no external `file:line` registry to fall out of sync.
- **No moving parts.** No reconcile script, no extra workflow, no
  `security-events: write` API writes, nothing to crash. The single
  `codeql.yml` analysis honors the comments directly.
- **Reversing a suppression is a one-line diff:** delete the comment.
  The next analysis re-opens the alert.
- **A new alert on an un-annotated sink is real signal** — it surfaces
  in the Security tab and gets either a code fix or a reviewed inline
  suppression, in the same PR that introduces it.
- **Rule-wide exclusions still belong in `query-filters`** in
  `.github/codeql/codeql-config.yml` — but only when we mean "never run
  this query," never as a substitute for a per-sink decision. Note that
  this config was inert until v0.4.1: `codeql.yml` never passed
  `config-file:` to `github/codeql-action/init`, which has no convention
  that finds the file by path, so its `paths-ignore` had never applied
  and every analysis also scanned the force-tracked `dist/` bundle. The
  input is now wired in; a `query-filters` entry added here will
  actually take effect.

# Amendment (2026-07-03): superseded the reconcile-daemon approach

This ADR originally expressed the same decisions as `codeql_dismissals`
YAML frontmatter, enforced by a `scripts/reconcile-codeql.ts` daemon
(workflow `codeql-reconcile.yml`) that walked the live alert API and
dismissed/re-opened alerts to match the frontmatter.

That approach keyed each suppression on `file:line` in a registry stored
*outside* the source. Line numbers are the most volatile coordinate a
sink has, so ordinary edits above a sink silently broke the link: the
old dismissal stayed frozen on the old line while CodeQL opened a fresh
alert on the new line, and the reconcile pass — which only ever checked
*dismissed* alerts — reported "in sync" while live alerts sat open. A
separate bug in the re-open path (sending `dismissed_reason: null` with
`state: "open"`) also 422'd and crashed the workflow (fixed in #195).

Inline suppression removes the external key entirely and lets CodeQL's
own analysis do the drift-tracking it is built for, which serves this
ADR's original goal — greppable rationale that survives change — more
simply and more robustly. The frontmatter registry, the reconcile
script, and the `codeql-reconcile.yml` workflow are removed.

# Amendment (2026-07-03): one HTTP mechanism owns token attachment

The six per-service inline suppressions were themselves a symptom: the
authenticated `fetch` call — and the `Authorization` header — was
duplicated across ~13 sites in `src/services/{copilot,github}/*` (plus a
second, un-suppressed sink in `anthropic-proxy.ts`). CodeQL flagged each
because each was a distinct file→HTTP sink.

We collapsed them into a single mechanism, `src/lib/send-request.ts`
(`sendRequest` / `sendRequestJson` / `sendProviderRequest`), with three
properties:

1. **One sink.** Every authenticated request — Copilot completions,
   GitHub auth/discovery, OAuth device flow, direct Anthropic, and
   provider passthrough — funnels through the one `fetch` (`dispatch`).
   That is the only `js/file-access-to-http` suppression for the app.
2. **The mechanism owns credential selection + attachment — the caller
   does not choose.** The rule is *the destination host determines the
   credential*. For the four fixed first-party hosts (Copilot, GitHub
   API, direct Anthropic, and the unauthenticated GitHub OAuth
   endpoints), the caller passes only a URL and `attachHostAuth` maps
   host → token + scheme; there is no credential argument to get wrong.
   The one case a host can't resolve is the config-selected passthrough
   provider (arbitrary user-configured base URL), so its resolved
   `ResolvedProviderConfig` — host + key + scheme bundled — is passed to
   `sendProviderRequest`; that supplies the credential *object*, not a
   label that could mismatch the host. Either way the token is read and
   turned into an `Authorization` / `x-api-key` header on a
   function-local `Headers` that is never returned, and the header
   builders in `api-config.ts` were stripped of their `Authorization`
   lines (now token-free) — a caller cannot obtain the token or the
   finalized request. An unrecognized host gets no credential (safe
   default: a typo'd host fails unauthenticated rather than leaking).
3. **The invariant is enforced, not just documented — on the shapes it
   can see.** An ESLint `no-restricted-syntax` rule (`eslint.config.js`,
   `credential-attachment-single-mechanism`) fails CI if any file outside
   `send-request.ts` hand-builds a `Bearer …` / `token …` auth string by
   interpolation or concatenation, or names an `Authorization` /
   `x-api-key` header in an object literal, in `.set()`/`.append()`, or
   on the left of an assignment. A new endpoint that tries to attach its
   own token in one of those forms cannot merge.

   It is a tripwire, not a proof: a header name held in a variable, or a
   header record assembled elsewhere and spread into `fetch`, needs the
   *value* of an expression rather than its shape and is not statically
   detectable. `eslint.config.js` lists both the covered and the
   uncoverable forms; read it before trusting the guarantee.

   Until 2026-08 the rule matched only two of the six covered shapes, so
   `headers.set("x-api-key", t)` — the form `send-request.ts` itself
   uses — was invisible to it. Widening it surfaced one real second
   attachment site (below).

   Allowlisted, for a stated reason:
   `routes/messages/web-tools/executor.ts` (a separate sandbox key, not
   a GitHub/Copilot token). `setup.ts` was allowlisted for a dummy
   loopback key it no longer sends, and
   `lib/platform/replace-running.ts` for the `--replace` takeover's
   hand-attached inbound key; both entries were removed once the
   attachment they named was deleted (see the 2026-08-05 amendment).

Least-privilege routing (each credential reaches exactly one host; no
host receives two credentials) was already true and is preserved — the
mechanism centralizes it rather than changing it.

Out of scope / follow-ups: the web-tools executor's sandbox credential
is not yet a `Credential` domain.

Update (defect #230): the `GET /token` endpoint (`routes/token/route.ts`)
that returned the raw Copilot token has been DELETED. The claim that it
"returns the Copilot token to the shell by design" was unsupported by
code — no shell code path ever fetched it (the shell reads `/token-usage`
and authenticates with its own key), and it was inherited verbatim from
the vendored upstream fork. Serving the raw upstream secret was
inconsistent with every other token-adjacent read in the repo
(presence-only booleans), so the route was removed rather than gated.

# Amendment (2026-08-05): the `--replace` attachment site is deleted, not folded in

The second attachment site that widening the guard surfaced —
`lib/platform/replace-running.ts`, which set `headers["x-api-key"] =
getConfiguredApiKeys()[0]` on the `--replace` takeover POST to
`http://127.0.0.1:<port>/_internal/shutdown` — has been **removed**. The
request now carries only `content-type`. The `eslint.config.js` allowlist
entry for that file is gone with it; the guard is back to one exception
(`web-tools/executor.ts`).

## Why deletion, and not `sendRequest()`

The header was **inert**. `/_internal/shutdown` has never been key-gated:

1. It is listed in `loopbackOnlyPaths` in `server.ts`, and
   `createAuthMiddleware`'s `shouldBypass` returns `next()` for a loopback
   caller on that path *before* any key is extracted. `alwaysEnforcePrefixes`
   is evaluated only after `shouldBypass`, so it cannot re-arm the check.
2. `routes/internal/route.ts` then re-checks the peer IP itself and returns
   `404` to a non-loopback caller **regardless of a valid key** — the property
   the endpoint exists to have.
3. Both halves key off the same `isLoopbackAddress` predicate, so there is no
   state in which the key flips a rejection into an acceptance, including the
   degraded case where the peer cannot resolve our IP (no bypass — but then
   the handler 404s too).
4. This has been true since the endpoint was introduced (`c712994`, which
   added the route and its `loopbackOnlyPaths` entry in one commit), so no
   shipped version ever required it. Against a peer older than that commit
   the POST simply 404s, and `evictRunning` already ignores the status and
   falls through to the SIGTERM/SIGKILL path.

Its wire contract (`docs/spec/wire/usage-status-wire-prd.md` → _graceful
eviction_) lists an optional JSON body and no credential at all.

Sending it was also a small net liability, in the direction the ADR cares
about. The caller has **not** authenticated the peer: `resolvePort` only
evicts when `probePort` saw the response body `"Server running"`, which any
local process can serve. `probePort` additionally asks
`http://localhost:<port>` while the POST goes to `http://127.0.0.1:<port>`,
so on a dual-stack host the identity check and the credentialed POST can
reach *different* listeners. So the one concrete effect of the header was to
hand the operator's inbound API key to an unauthenticated local peer.

Folding it into `sendRequest()` was considered and rejected on three counts,
recorded here so it is not relitigated:

- **Wrong credential domain.** Every credential `sendRequest` attaches is an
  *outbound* one the proxy holds to authenticate itself to an upstream
  (`state.copilotToken`, `state.githubToken`, `getAnthropicApiKey()`, a
  resolved provider key). The `--replace` key is an *inbound* one — the same
  secret an API client presents to us. Routing it through the single
  file→HTTP sink would put an unrelated credential class through the one
  CodeQL-suppressed line whose stated rationale is "forwards its own token
  upstream", weakening that suppression's meaning.
- **Host inference cannot express it, and the workaround inverts the safe
  default.** `attachHostAuth`'s guarantee is "an unrecognized host gets no
  credential." A `127.0.0.1:*` branch would make the entire loopback space
  credential-bearing, so any future `sendRequest("http://127.0.0.1:<n>/…")`
  would silently leak the inbound key. Loopback is not a trust boundary here.
- **Passing the key as an argument would satisfy the lint rule without
  satisfying the invariant.** A `sendLoopbackRequest(apiKey, url)` moves the
  `.set()` call into `send-request.ts` but leaves *credential selection* with
  the caller — precisely the "credential crossing a boundary as an opaque
  value" shape `eslint.config.js` documents as undetectable. It would also
  require adding a `fetch` injection seam to the auth sink (the eviction path
  is tested through `deps.fetchImpl`), and an injectable `fetch` inside the
  single token-attaching function is itself an exfiltration seam.

Nothing needed a new credential kind, because nothing needed a credential.

## What a reviewer should check if this is ever edited

`requestShutdown` carries the reasoning inline. If someone proposes putting a
credential back on that POST, it is only warranted if **both** of these have
changed:

- `/_internal/shutdown` became reachable off-loopback (removed from
  `loopbackOnlyPaths`, or the handler's `isLoopbackAddress` gate dropped), and
- it grew a real key check that a caller must satisfy.

If that happens, the credential must be selected by the mechanism, not by
`replace-running.ts` — and the peer must be authenticated *before* the key is
sent, which the `"Server running"` probe does not do.

`tests/replace-running.test.ts` pins both properties: the shutdown POST's
header set is asserted whole (not just "no `x-api-key`"), and every URL the
flow touches is asserted to have hostname `127.0.0.1`. That assertion catches
a reattachment under any header name, including via a spread record the
ESLint guard cannot see.

## Manual sweep for sites the guard structurally cannot see

`eslint.config.js` documents which shapes are undetectable. Doing the sweep
those shapes imply — by hand, over all of `src/**` — turned up three places
where a credential reaches the wire outside `send-request.ts`'s attachment
logic. None is a hand-rolled auth header; all three are invisible to any
selector. Recording them so the next sweep starts from a baseline rather than
from zero.

1. **A credential in a request BODY, not a header** —
   `services/github/refresh-access-token.ts`. The OAuth `refresh_token` grant
   puts the `ghr_` refresh token in the JSON body. It *is* routed through
   `sendRequest`, so it shares the one fetch sink and the destination is the
   fixed first-party `${githubBaseUrl}/login/oauth/access_token` — but
   `attachHostAuth` maps `github.com/login/*` to **no** credential, so the
   secret on that wire was supplied by the caller and the mechanism never saw
   it. `send-request.ts`'s comment on that host ("authenticates via a public
   client_id in the body") is true of the device-code flow and understates
   the refresh flow. Not a defect — the grant type requires the token in the
   body — but it means "the mechanism owns every credential that leaves" is
   true of *headers* only.
2. **`Proxy-Authorization`, minted inside a dependency** — `lib/http/proxy.ts`
   passes `getProxyForUrl()`'s raw value to undici's `ProxyAgent`. Corporate
   `HTTPS_PROXY` values routinely carry userinfo (a `user:password@` part
   before the host), and undici turns that into a `Proxy-Authorization:
   Basic …` header on every
   outbound request in the process — including every request through
   `sendRequest`. The file already strips userinfo before logging, so the
   possibility is known. It is the operator's own proxy password rather than
   an app-held token, and it is Node-path only (`initProxyFromEnv` returns
   early under Bun), but it is the single most rule-invisible credential
   header in the repo.
3. **A latent second mechanism on a PUBLISHED surface** — `lib/live/client.ts`
   (`ControlClient`, exported as `@stuffbucket/maximal-core/client`). Its
   `headers` option is documented as *"Auth headers sent on every request
   (e.g. `{ "x-api-key": "…" }`)"* and is spread into four `fetch` calls —
   and at one of them passed as a bare identifier in the `headers` position,
   with no object literal at all. No caller in `src/**`, `tests/**`, or
   `scripts/**` passes credentials to it today, so nothing leaks now. But it
   is the exact "record built elsewhere and spread" shape, on an exported
   SDK, where a downstream consumer attaches a credential with zero lint
   coverage. This is the one to watch.

Also noted while sweeping, adjacent but out of scope for the attachment
invariant: `routes/control/settings-endpoints.ts`'s `GET /control/api-keys`
returns `apiKeyEntries` verbatim, raw `key` values included. That is a
disclosure surface behind the auth middleware, not an attachment site.
