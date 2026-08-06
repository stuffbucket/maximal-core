# Control API + live event stream (v1 — ARCHIVED)

> **This describes protocol v1, which no longer exists.**
>
> Everything below — the `{id, event, data}` envelope, `GET /control/events`, and
> the cursor / ring / epoch / `Last-Event-ID` resume machinery — was **removed**
> when the control plane moved to stateless JSON-RPC 2.0 under ADR-0023
> (`stuffbucket/maximal`, `docs/decisions/0023-…`). MCP deleted resumable streams
> and protocol-level sessions in spec revision 2026-07-28 for the same reason, so
> v1's mechanism has no conformant form: it was not adjusted, it was deleted.
>
> **Do not build a client against this document.** For the current surface see
> the *Control API* section of [`docs/architecture.md`](../../architecture.md);
> for the wire types, `src/lib/live/contract.ts` (published as
> `./contract`) and `src/lib/jsonrpc/contract.ts` (published as
> `./control-contract`); for the callable method set, call `server/discover` at
> runtime — it is generated from the live registry and so cannot under-report.
>
> Kept only as the record of what v1 was, for anyone reading a client written
> against it.

Status: **superseded** — was "design (vetted)" for the v1 surface.
Audience: historical.

## Context

The UI cluster (`routes/ui`, `routes/settings`, `routes/ws`, `lib/ws`) was removed when
`maximal-core` was split out (commit that dropped all UI surfaces). Core is now a headless
proxy: CLI-authenticated, no browser sign-in, no live feed. This spec defines the surface a
decoupled UI (and third-party consumers) use to read state, drive actions, and receive live
updates — designed for **multiple simultaneous clients** (several tabs / the desktop app / the
CLI, all at once).

It replaces two deleted things: the `/settings/api/*` request API and the `/ws` live-feed. It is
**not** a port of them — the old `/ws` was built around a single privileged tab
(presence-registry, tray dedup, view-restore); that machinery is a native-host concern and is
deliberately **not** recreated here.

## Prior art and honest framing

Anchored on Tailscale's LocalAPI watch, but be precise about what comes from where:

- **From Tailscale** (kept): one long-lived streaming GET per client; a **per-subscriber
  buffered channel**; **drop-slow-client-then-disconnect** backpressure; atomic
  initial-state-under-lock; and **rate-limit coalescing** of a noisy producer
  (`mergeBoringNotifies` / `NotifyRateLimit`).
- **From Kubernetes list-watch** (kept): the **resumable monotonic cursor + replay ring**.
  Tailscale's bus has *no* cursor — a reconnecting client always re-lists. Our `Last-Event-ID`
  resume is K8s `resourceVersion` semantics, and it owns its own eviction/off-by-one edge cases
  (addressed below). Don't attribute the ring to Tailscale.

## Architecture: library-first hub, thin SSE adapter

A single `ControlHub` (`src/lib/live/hub.ts`) owns cursor, ring, epoch, bus subscriptions, and
fan-out. The SSE route and any embedder both drive the same API:

```
ControlHub
  .getSnapshot(): Promise<ControlSnapshot>     // full current state (backfill)
  .subscribe(sink): Unsubscribe                // sink = { enqueue(frameString), close(reason) }
  .replayFrom(cursor, epoch): Frame[] | null   // null => caller must re-snapshot
  start(): void                                // subscribe to producer buses ONCE
```

HTTP is a ~40-line adapter over this. So the UI-server tier talks to it over loopback SSE, and a
future in-process embedder imports the hub directly.

## The event stream — `GET /control/events` (SSE)

### Frame envelope

```
id: <cursor>            # SSE id, monotonic per-process integer; absent on edge-only frames
event: <topic>          # "snapshot" | "auth" | "accounts" | "apps" | "models" | "clients" | "usage" | "config" | "boot"
data: <json>            # for state topics: the FULL resource, byte-identical to the matching GET body
```

Two invariants make the whole thing safe:

1. **Deltas are full-resource upserts, never field patches.** Re-applying a resource is
   idempotent, so snapshot/delta double-delivery and ring replay are harmless. A client keyed on
   topic just overwrites its copy.
2. **A state topic's `data` equals its GET body.** One representation per resource; a client can
   render from a GET or an event interchangeably.

### Connect handshake (single-consumer drain — no mode switch)

The naive "flush queued deltas then go live" reorders under load. Instead:

1. Create the subscriber with **one FIFO queue** and register it with the hub (now buffering).
2. Register `onAbort` / teardown **before** any await (a failed snapshot build must not leak the
   subscriber into the fan-out set).
3. `await hub.getSnapshot()`; **unshift** it as the `snapshot` frame at the head of the queue
   (cursor = the baseline captured at step 1).
4. Start **one drain loop** — the sole writer for the connection's life. Bus fan-out only ever
   **appends** to the tail.

Monotonic by construction: every frame for a connection flows through one ordered queue.

### Cursor, ring, epoch, resume

- **Cursor:** a single per-process monotonic integer. `++cursor` and `ring.push` happen in one
  **synchronous** block at the top of emit, before any await. Every registered projector must be
  synchronous (assert it) — else two concurrent emits can ring out of order.
- **Ring:** last N frames (start N = 512, tunable). **Coalesced usage does not enter the ring**
  (see below) so a usage burst can't evict resumable control frames.
- **Epoch:** a per-process random token, sent on the snapshot frame. Resume is only valid within
  the same epoch (a hub restart invalidates all cursors).
- **Resume:** on reconnect the client sends `Last-Event-ID`. Server validation:
  - parse to non-negative int; on `NaN`, on `sinceCursor > currentCursor` (future cursor), or on
    epoch mismatch → **force a fresh snapshot**.
  - gap-free iff `sinceCursor + 1 >= ring.oldest.cursor`; else re-snapshot.
  - Never silently go live believing you're caught up — that's the dangerous case.

### Transient / edge-only frames

`emitAuthChangedWithReconnect()` already exists and rides an `auth.changed` carrying a transient
`notify_on_reconnect: true` (fires an OS toast). **Rule: only pure-state upserts get a cursor and
enter the ring.** Anything that triggers a client side effect is emitted **live-edge only** — no
`id:`, never replayed — so a gap-free reconnect can't re-fire the toast. Strip
`notify_on_reconnect` before the frame is cursored.

### Fan-out, backpressure, cleanup

- **Serialize once.** Each delta is `JSON.stringify`'d a single time; the string is shared across
  all subscriber queues. The hub is on the proxy's event loop — do not re-serialize per subscriber
  (N tabs × per-request usage would tax in-flight proxied requests).
- **Bounded per-subscriber queue** (start 256). Non-blocking enqueue; on overflow → emit a
  terminal error frame + disconnect. The client auto-reconnects into a fresh snapshot. The
  producer is never blocked (no in-process-no-disconnect path over the wire — Tailscale's rule).
- **Cleanup on every exit:** wrap heartbeat + drain writes in try/catch → on any write failure
  (the detector for half-open/slept peers) `hub.remove` + stop drain + `clearInterval(heartbeat)`.
  `hub.remove` also in a `finally`. Subscribe to producer buses **once at `hub.start()`**, not
  per connection.
- **Heartbeat:** a 15s SSE comment keeps intermediaries open and surfaces dead peers via write
  failure.

## Mutation serialization (required)

"Server-authoritative" does **not** hold without this. `activateAccount(X)` does a network
`preflightCopilotError` await before swapping the in-memory token trio and `writeDefaultRegistry`;
a concurrent `signOut()` interleaves in that window, and the two lock-free registry writes race —
leaving the in-memory trio (used by the proxy) divergent from the on-disk active key (reported by
the snapshot). Broadcast *order* converges; underlying *state* does not.

**Every state-mutating action serializes through one process-wide async mutex/queue** (switch,
sign-out, remove, api-key CRUD, app toggle). An action holds the lock across its full await chain
(preflight → trio swap → registry write → emit) so no two mutations interleave. Only then is "the
resulting delta is the truth."

## Request / action endpoints

Loopback + origin-gated (see Security). Each read pairs a GET with a live topic sharing one type.

| Method | Path | Backing (surviving unless noted) |
|---|---|---|
| GET | `/control/events` | ControlHub (new) |
| GET | `/control/auth` | `getAuthStatus()` — auth-controller.ts:240 |
| GET | `/control/accounts` | `buildAccountsList()` — **re-home** from deleted settings/accounts.ts:36 |
| POST | `/control/accounts/activate` | new `activateAccount(key)` (gap 1) — under the mutex |
| POST | `/control/accounts/signout` `/remove` | `github-token-store` — under the mutex |
| GET | `/control/apps` | `buildAppsList()` — **re-home** from deleted settings/apps.ts:59 |
| GET | `/control/models` | `buildModelsList()`+`toSummary()` — **re-home** from deleted settings/models.ts |
| GET | `/control/usage` | `getTokenUsageSummary(period)` — store.ts:597 |
| GET | `/control/config` | `getConfig()` — config.ts:326 |
| GET | `/control/clients` | `listActiveClients()` — active-clients.ts:54 |
| POST | `/control/quit` `/upgrade` | `emitQuitRequest`/`emitUpdateRequest` (gap 2) + belt-and-suspenders loopback re-check |

## Contract (the real API)

`src/lib/live/contract.ts` replaces the deleted `feed-types.ts`. A **versioned zod schema** is the
single source of truth, imported by both the hub (producer) and the UI (consumer). Reuse the
surviving `settings-types` schemas; only the envelope + `usage`/`clients`/`boot` types are new.
The `SettingsEventMap` grows from `auth.changed`-only to the full producer set
(`accounts`/`apps`/`apikeys`/`models`/`clients`/`upstream`/`boot`) via the existing
projector-indirection pattern, so every read endpoint has a matching live delta.

## Usage coalescing (required, not optional)

`token_usage.recorded` fires **per proxied request** on the separate `tokenUsageEventBus`
(`onTokenUsageRecorded`, index.ts:174). Coalesce/rate-limit it (Tailscale's mechanism) to at most
one `usage` delta per tick, and keep usage **out of the resume ring** so a request storm can't
evict `auth`/`apps`/`config` frames. This is the Tailscale mechanism that actually protects the
design under load; it is not a nice-to-have.

## Re-homing checklist (into `lib/`)

Pull these out of the deleted routes/ws into reusable `lib/` functions:
`buildSnapshot` → `buildControlSnapshot` (was lib/ws/live-feed.ts:210), `buildAccountsList`
(settings/accounts.ts:36), `buildAppsList` (settings/apps.ts:59), `buildModelsList`+`toSummary`
(settings/models.ts), the usage wire-adapters `toUsageSnapshot`/`toUsageLastEvent`
(lib/ws/live-feed.ts:163/188). The primitives they wrap all survived
(`readDefaultRegistry`+`listAccounts`, `getAllApps`, `state.models`+`getModelsLoadedAtMs`,
`getTokenUsageSummary`).

## Security wiring

Reuse the surviving stack unchanged: add a `/control` prefix to `CSRF_GUARDED_PREFIXES`
(origin-guard.ts:47 — drop the dead `/ws` while there) and to the auth-middleware options; loopback
gating via `isLoopbackAddress`/`defaultGetRequestIp` (request-auth.ts). Header auth via
`createAuthMiddleware` untouched. The `/quit`/`/upgrade` actions re-check loopback inside the
handler (internalRoutes precedent) — `loopbackOnlyPaths` relaxes auth, it does not block remote
callers.

## Client transport (locked: fetch-reader)

Native `EventSource` gives free reconnect + `Last-Event-ID`, but **cannot set auth headers** →
token-in-URL, which was deliberately removed. So the client is a **`fetch()` + ReadableStream
reader**: keeps header auth and reuses `createAuthMiddleware` verbatim, at the cost of
re-implementing reconnect/backoff and re-sending the cursor as an explicit `Last-Event-ID` request
header (~40 lines in the UI-server tier). The stream shape is identical either way.

## Locked decisions

1. **Transport:** fetch-reader (header auth). Flip cost: native EventSource needs a minted query
   token.
2. **Account switch:** in-core `activateAccount` (keeps every client's SSE alive). Flip cost:
   sidecar reboot tears down all connections — the thing multi-client exists to avoid.
3. **Usage coalescing:** required.
4. **Prefix:** fresh `/control` (clean wiring), rename in scope with the Electron migration.

Still tunable: ring depth (512), per-subscriber queue (256), heartbeat interval (15s), whether the
connect snapshot carries the running usage tally vs. usage-as-pure-delta.

## Implementation phases

1. `src/lib/live/contract.ts` (zod envelope + resource types; grow `SettingsEventMap`).
2. Re-home the aggregators into `lib/` (checklist above); prove with unit tests.
3. `src/lib/live/hub.ts` — cursor/ring/epoch, single-drain subscriber, once-serialized fan-out,
   coalesced usage, resume validation. This is where the hard correctness lives; test it in
   isolation (see below) before any HTTP.
4. Mutation mutex + `activateAccount`; route every write through it.
5. `src/routes/control/route.ts` — GET/POST adapters + the SSE endpoint; wire security prefixes;
   mount in `server.ts`.
6. UI-server tier: the fetch-reader client with reconnect + `Last-Event-ID` resend.

## Test plan (multi-client correctness — the failure classes the review found)

- Snapshot→delta ordering: 3 clients connect during a burst; assert each sees a monotonic,
  gap-free cursor sequence with no interleave.
- `Last-Event-ID` resume: in-window replays exactly the gap; evicted/`NaN`/future/epoch-mismatch
  force a re-snapshot (never a silent live-with-stale-state).
- Idempotent upsert: snapshot then a delta for the same resource leaves one consistent copy;
  `notify_on_reconnect` never appears on a replayed frame.
- Conflicting writes: interleaved switch vs sign-out under the mutex converge in-memory trio ==
  on-disk active key == final broadcast.
- Backpressure: a stalled subscriber overflows its queue → terminal frame + disconnect, other
  subscribers unaffected; no listener/timer leak after disconnect or failed snapshot build.
