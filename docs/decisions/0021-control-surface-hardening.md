---
id: ADR-0021
title: Control-surface hardening (Origin allowlist + mandatory settings-api auth)
status: accepted
date: 2026-07-14
authors:
  - stuffbucket
supersedes: []
links:
  spec: docs/spec/single-window-redesign.md
  server: src/server.ts
  request_auth: src/lib/auth/request-auth.ts
  origin_guard: src/lib/auth/origin-guard.ts
  control_routes: src/routes/control
  internal_route: src/routes/internal/route.ts
  current_behaviour: docs/spec/wire/auth-transport-wire-prd.md
---

# Control-surface hardening (Origin allowlist + mandatory settings-api auth)

## Context

A security audit found the sidecar's control surface is **already CSRF-exposed
today**, independent of the UI shell:

- Auth is **off by default** — `decideAuth` allows every request unless
  `auth.enforce === true`, which the default config never sets
  (`request-auth.ts`). So `/settings/api/*` mutations succeed with no key.
- There is **no `Origin`/`Referer` check** anywhere on those routes.
- `cors()` is the permissive default (`Access-Control-Allow-Origin: *`).
- Loopback gating checks the **source IP only** — a malicious website driving
  the user's local browser originates from `127.0.0.1` and passes it.
- `POST /_internal/shutdown` is loopback-gated + auth-exempt — the **same
  hole class**: a visited web page can shut the sidecar down.

The Tauri webview earns no origin benefit today (same `http://localhost` origin
as the API); its only real protection is the IPC boundary (the `get_shell_api_key`
handoff + uninstall being IPC-only). Browser-tab delivery (ADR-0018) removes
the IPC handoff and makes the hole trivially exploitable from any visited page,
so hardening becomes **mandatory** — but it should be fixed regardless.

## Decision

1. **Origin/Referer allowlist** on `/settings/api/*` **and** `/_internal/*`
   (and read-only `/_debug/state`): reject any request whose `Origin` is
   present and not `http://localhost:<port>` / `http://127.0.0.1:<port>`.
   `Origin` is a **Forbidden header** — page JS cannot forge it — so this
   blocks all browser-driven cross-origin calls. Independent of `enforce`.
2. **Mandatory auth on `/settings/api/*`, decoupled from the `enforce`
   toggle.** The user-facing "block unknown connections" flag continues to
   govern only the proxy surfaces (`/v1/*`, …).
3. **Tighten `cors()`** from `*` to an explicit localhost allowlist (the
   `OPTIONS` preflight is load-bearing — auth bypasses it).
4. **Destructive/irreversible ops stay native/IPC-only** — uninstall already
   is; consider `accounts/remove` + `api-keys/enforce` too.
5. **A minted session token** in the served `/ui` document
   (same-origin-readable only) replaces the Tauri-IPC shell-key handoff a
   browser tab can't reach; the WebSocket (ADR-0019) authenticates with it.

**Invariant — must not regress CLI/plugin clients.** Claude Code, opencode,
and SDK clients send **no `Origin`** and call `/v1/*`, `/responses`,
`/chat/completions`, `/v1/models`, `/embeddings` + the `api claude-code` key
mint — not `/settings/api`. The Origin gate (missing-`Origin` passes), the
`enforce`-decoupled auth (keep honoring `Authorization: Bearer <key>`), and the
narrowed **global** `cors()` must all leave those routes reachable.

## Alternatives considered

- **Rely on obscurity / the status quo.** Already broken; a browser origin
  makes it obvious. Rejected.
- **Loopback-only gating as the defense.** Source-IP loopback does not
  distinguish a legitimate local tab from a malicious-site-driven local
  request. Insufficient.
- **Keep the whole control surface IPC-only.** Impossible under browser
  delivery — there is no Tauri host in the tab.

## Consequences

- Closes a live CSRF hole (sign-out, account-switch/remove, key mgmt,
  enforce-toggle, config writes, sidecar shutdown).
- The read-only `/ui/diagnostics` page needs none of this — it mutates
  nothing and is CSRF-safe by construction.
- The `state.shellApiKey` role changes (ADR-0003): clarify whether it survives
  as the minted token's source or is replaced.

## Implementation status

**Landed (Build Track 1, 2026-07-15) — the live hole is closed:**

- **Origin allowlist (§6.1):** `createOriginGuardMiddleware`
  (`src/lib/auth/origin-guard.ts`) 403s any present, non-localhost `Origin` on
  `/settings/api`, `/_internal` (incl. `/_internal/shutdown`), and `/_debug/state`;
  a missing `Origin` passes (CLI/plugin/SDK invariant, §6.6). Mounted in
  `server.ts` before auth. Port-exact against `state.boundPort` (set by
  `runServer` from `--port`, default 4141).
- **Mandatory `/settings/api` auth (§6.2):** delivered as the
  `alwaysEnforcePrefixes` mode of the existing `createAuthMiddleware`, so the
  `shellApiKey` bypass + client attribution stay single-sourced. Read-only
  `/settings/api/diagnostics` GET is exempt (§1.7/§6.5), CSRF-safe via the Origin
  guard.
- **CORS narrowed (§6.3):** `buildCorsOptions` replaces `cors()`'s `*` with a
  localhost-on-the-bound-port echo (null otherwise), covering the OPTIONS preflight.
- **CLI/plugin non-regression (§6.6):** asserted by
  `tests/security/cli-client-regression.test.ts` (no-Origin `Bearer` on `/v1/*`
  still 200). `origin-guard.ts` mutation score 88%.

**Amendment (2026-08-05) — what the core split changed.** The paragraph above
records the state at landing; three of its specifics no longer hold. Verified
against source and a running engine:

- The guard is port-exact against **`state.controlPort`**, not `state.boundPort`
  (which no longer exists). `src/server.ts` passes `() => state.controlPort` to
  both `createOriginGuardMiddleware` and `buildCorsOptions`, on **both**
  listeners. Consequence: a page served from the *public* port is not an allowed
  origin either.
- `CSRF_GUARDED_PREFIXES` gained **`/control`** — the JSON-RPC surface that
  replaced `/settings/api` and `/ws`.
- **§6.2 is inert.** `/settings/api` was removed with the UI cluster, so
  `MANDATORY_AUTH_PREFIX` and `createAuthMiddleware`'s `alwaysEnforcePrefixes` /
  `requireAuthPrefixes` options survive but are wired by nothing;
  `src/server.ts` passes neither. `/control` is instead in
  `allowUnauthenticatedPrefixes` and is protected by the loopback-only bind, the
  router's own peer-IP 404, and the Origin guard.
- `state.shellApiKey` (`MAXIMAL_SHELL_KEY`) still bypasses the enforce flag in
  `decideAuth`, but core never sets it — it is a desktop-shell affordance.

**Amendment (2026-08-06) — the §6.2 machinery is deleted, and the
route-enumeration test now enumerates.** Two follow-ups to the amendment above.

- **§6.2's remains are gone.** `MANDATORY_AUTH_PREFIX`,
  `alwaysEnforcePrefixes`, and `requireAuthPrefixes` are deleted, along with
  `decideAuth`'s `mandatory` parameter. Unreachable configuration on a security
  path is a liability: it reads as a live control and invites a reviewer to
  assume a gate exists. Nothing published imports them — `package.json`'s
  `exports` map covers only `client`, `contract`, `control-contract`,
  `supervisor`, and `settings-types`, none of which reach `origin-guard.ts` or
  `request-auth.ts` — so this is not a breaking change. Bring one back with the
  caller that needs it. §6.2 itself stays **superseded, not implemented**:
  `/control` is protected by the loopback bind + peer-IP 404 + Origin guard.
- **The route-enumeration test was guarding a fiction.** The test this section
  promised ("walks `app.routes` so a new `/settings/api` route that isn't
  Origin-gated fails by omission") was never written. What shipped as
  `tests/security/origin-guard.test.ts` asserted `/settings/api` membership in
  `CSRF_GUARDED_PREFIXES` and mounted its *own* Hono app on `/settings/api` — so
  it passed while exercising a surface deleted at the core split, and never read
  a route table. It could not have failed, which is how `/control` came to be
  added to the guarded list with nothing checking that the guard reached it.

  It now walks the real `routes` tables of `publicApp` and `controlApp` and
  asserts four things: every route on the control listener falls under a guarded
  prefix; nothing outside `/_internal` is guarded on the public listener (the
  §6.6 CLI/plugin invariant, stated as a property of the route table rather than
  a sample); every guarded prefix is either served or explicitly declared dead
  (`/settings/api` is the one declared-dead entry, and a separate test asserts it
  really is unserved); and every enumerated guarded route 403s `csrf_error` when
  driven through the **real** app with a cross-origin `Origin`. Verified to fail
  on three mutations: a new unguarded `controlApp` route, `/v1` added to
  `CSRF_GUARDED_PREFIXES`, and the guard unmounted from `applyCommonMiddleware`.
- **User-facing strings.** The boot warning and `requireGithubAuth`'s hint both
  sent users to a Settings UI that core does not have. They now name
  `maximal auth` and the `/control` auth flow.
- **The §6.6 citation above overstates its test.** The landing paragraph says
  §6.6 is "asserted by `tests/security/cli-client-regression.test.ts` (no-Origin
  `Bearer` on `/v1/*` still 200)". That test mounts its **own** `Hono` app,
  declares its own `/v1/messages` handler, and mounts only
  `createOriginGuardMiddleware` — it never imports `~/server` and never mounts
  `createAuthMiddleware`, so the `Bearer` header in its request is inert and no
  change to `src/server.ts` or `request-auth.ts` can fail it. The test's own
  docstring says as much ("This checks the middleware in isolation"); the
  citation did not. What is genuinely asserted against the real app is the
  route-table half, in `origin-guard.test.ts` (previous bullet). The
  end-to-end half — a no-Origin `Bearer` request reaching a real `/v1` handler
  through the real middleware stack — is **still not covered by any test**
  (resolved by the 2026-08-07 amendment below).

  `links.spec` in this ADR's frontmatter also points at
  `docs/spec/single-window-redesign.md`, which does not exist in this repo:
  that spec was not carried over at the core split, so the "Spec §6" and
  "spec §10" references below cannot be followed from here.

**Amendment (2026-08-07) — §6.6 now has the end-to-end test it was credited
with.** `tests/security/cli-client-regression.test.ts` no longer builds its own
Hono app. It drives the real `publicApp` from `~/server`, so the full
`applyCommonMiddleware` stack and the real route table are in the path, and
asserts four things: a no-Origin `Bearer` request on `/v1/models` reaches the
real handler (the response carries a seeded model id, so a 200 from some
middleware would not satisfy it); the same request with no credential 401s
`authentication_error`, which is what keeps the first assertion from passing
vacuously if auth were unmounted; a cross-origin request to the guarded
`/_internal/shutdown` 403s `csrf_error` rather than 401ing, pinning the guard's
mount order *ahead* of auth; and the same path with no `Origin` is not refused
by the CSRF gate. Verified to fail on four one-line mutations: inverting
`apiKeyAllowed`, making the auth middleware non-blocking, moving the Origin
guard behind auth in `applyCommonMiddleware`, and flipping `isAllowedOrigin`'s
`origin === null` arm. Adding `/v1` to `CSRF_GUARDED_PREFIXES` is caught by
`origin-guard.test.ts`, which still owns the route-table half.

Current behaviour is documented in
[`docs/spec/wire/auth-transport-wire-prd.md`](../spec/wire/auth-transport-wire-prd.md).

**Pending (later tracks):**

- **Minted WS session token (§6.5)** — superseded in shape: there is no WS
  transport and no Settings UI in core (see ADR-0019 and the control-plane
  section of `docs/architecture.md`). The `shellApiKey`-vs-token question
  (ADR-0003) is moot here and belongs to whatever tier serves a UI.
- **Destructive ops native/IPC-only (§6.4)** — `accounts/remove` and the
  api-keys actions are Origin-gated and loopback-gated on `/control`, but not
  IPC-only.

## Migration

Spec §6. Ship on its own track — independent of the window/nav work, ideally
first (it closes a live hole today).

## Testing

Permanent `tests/security/` suite (spec §10): per-mutation Origin tests
(evil→403, localhost→200); `enforce:off → 401` on `/settings/api`; CORS never
`*`/never-echo + the OPTIONS preflight; IPC-only ops 404 over HTTP; the WS
rejects a missing/wrong token; a **self-extending route-enumeration** test that
walks `app.routes` so a new `/settings/api` route that isn't Origin-gated fails
by omission; a **no-`Origin` `Bearer` `/v1/*` regression** test; and a
mutation-test that kills the "re-couple auth to `enforce`" mutant.

> **As-built (2026-08-06).** The route-enumeration test exists and walks both
> real route tables; see the second amendment above for what it asserts and the
> mutations it was proven against. The `/settings/api` and WS items in the list
> above are moot — neither surface exists in core.

## Out of scope

- Rate limiting / abuse protection on the proxy surface.
- The proxy `/v1/*` auth model (governed by the existing enforce/API-key flow).

## Open questions

- Move `accounts/remove` + `api-keys/enforce` to IPC-only, or keep them HTTP
  behind the Origin + mandatory-auth gate with re-confirmation?
