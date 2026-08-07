/**
 * Downstream consumer of `@stuffbucket/maximal-core/client`.
 *
 * `./client` is the one published entrypoint that ships a CLASS a consumer
 * constructs, so its options object is a contract in a way the pure-type
 * entrypoints are not: a narrowed option type is a compile error in consumer
 * code, and a widened one is a silently-accepted mistake. It was uncovered here
 * until the `headers` option was hardened — which is precisely the change this
 * fixture exists to catch at the source.
 *
 * Two things are asserted, in order of importance:
 *
 * 1. **A credential cannot be passed as a literal header.** The reason is
 *    ADR-0001: credentials attach in exactly one place inside the engine, and
 *    the control surface takes none at all. The `@ts-expect-error`s below are
 *    the consumer-side half of that invariant — the repo's ESLint guard lints
 *    `src/**` only and can never see a consumer's call site.
 * 2. **The known gap is pinned as a gap.** A `Record<string, string>` built
 *    elsewhere still compiles (its `keyof` is `string`, which matches no
 *    literal key), so the type is a tripwire and not a proof. That case is
 *    asserted to COMPILE here on purpose: if it ever stops, the type grew teeth
 *    it was not documented to have, and the runtime check in the constructor —
 *    which is what actually covers it — is pinned by
 *    `tests/live/control-client.test.ts`, not by tsc.
 */
import type {
  ControlClientOptions,
  ControlState,
  FetchLike,
  NonCredentialHeaders,
  StateListener,
} from "@stuffbucket/maximal-core/client"

import {
  ControlClient,
  ControlRpcError,
} from "@stuffbucket/maximal-core/client"

import { expectAssignable } from "./assert.js"

// --- construction -----------------------------------------------------------
// The minimum a consumer must supply. Every other option staying optional is
// part of the contract: adding a required option is breaking.
export const minimal = new ControlClient({ baseUrl: "http://127.0.0.1:4141" })

const fullOptions: ControlClientOptions = {
  baseUrl: "http://127.0.0.1:4141",
  controlPath: "/control",
  headers: { "x-trace-id": "trace-1" },
  fetch: globalThis.fetch,
  reconnectDelayMs: 500,
  maxReconnectDelayMs: 15_000,
  sleep: (ms: number) => Promise.resolve(void ms),
}
export const configured = new ControlClient(fullOptions)

// --- the injectable fetch actually accepts a stub ---------------------------
// The option is documented as "injectable fetch (tests / custom agents)", so a
// plain function has to be assignable to it. It is typed `FetchLike` rather than
// `typeof fetch` precisely because `typeof fetch` carries implementation extras
// (Bun's types put `preconnect` on it) that a stub does not have.
const stub: FetchLike = (url, init) =>
  Promise.resolve(new Response(JSON.stringify({ url, method: init?.method })))
export const stubbed = new ControlClient({
  baseUrl: "http://127.0.0.1:4141",
  fetch: stub,
})
// The real thing stays assignable too — narrowing must not have excluded it.
expectAssignable<FetchLike>(globalThis.fetch)

// --- the headers option is not an auth hook ---------------------------------
// Non-credential metadata: allowed, and the whole reason the option survives.
expectAssignable<NonCredentialHeaders>({ "x-trace-id": "trace-1" })
expectAssignable<NonCredentialHeaders>({})

// @ts-expect-error `x-api-key` is a credential header — the control surface
// takes no credential, and attaching one here would bypass the single-mechanism
// invariant (ADR-0001).
expectAssignable<NonCredentialHeaders>({ "x-api-key": "secret" })

// @ts-expect-error same header, the casing a consumer is most likely to type.
expectAssignable<NonCredentialHeaders>({ "X-Api-Key": "secret" })

// @ts-expect-error `authorization` is a credential header.
expectAssignable<NonCredentialHeaders>({ authorization: "Bearer secret" })

// @ts-expect-error capitalised spelling of the same header.
expectAssignable<NonCredentialHeaders>({ Authorization: "Bearer secret" })

// Rejected at the constructor's own option, not only via the standalone type
// alias — the option is what a consumer actually types.
export const credentialed = new ControlClient({
  baseUrl: "http://127.0.0.1:4141",
  // @ts-expect-error `x-api-key` is a credential header.
  headers: { "x-api-key": "secret" },
})

/**
 * The documented gap, asserted as a gap.
 *
 * This COMPILES, and must keep compiling for the comment above to stay honest.
 * A record whose key type is `string` satisfies no literal-key constraint, so
 * the type cannot see the credential; the constructor throws `TypeError` on it
 * at runtime instead.
 */
export function headersBuiltElsewhere(
  built: Record<string, string>,
): ControlClientOptions {
  return { baseUrl: "http://127.0.0.1:4141", headers: built }
}

// --- the surface a consumer drives ------------------------------------------
expectAssignable<Promise<void>>(minimal.connect())
expectAssignable<void>(minimal.close())
expectAssignable<ControlState>(minimal.getState())
expectAssignable<() => void>(minimal.onState((state) => void state))

const listener: StateListener = (state) => {
  // Per-topic state is deliberately `unknown` — a consumer validates it with the
  // schemas from `./contract` rather than trusting a shape from the wire.
  expectAssignable<unknown>(state.auth)
}
expectAssignable<() => void>(minimal.onState(listener))

// `call` is generic with an `unknown` default, so a consumer can either parse
// the result itself or name the type it expects.
expectAssignable<Promise<unknown>>(minimal.call("server/discover"))
expectAssignable<Promise<unknown>>(minimal.call("accounts/switch", { key: "k" }))
expectAssignable<Promise<{ protocolVersion: string }>>(
  minimal.call<{ protocolVersion: string }>("server/discover"),
)

expectAssignable<Promise<unknown>>(minimal.getAuth())
expectAssignable<Promise<unknown>>(minimal.getAccounts())
expectAssignable<Promise<unknown>>(minimal.getModels())
expectAssignable<Promise<unknown>>(minimal.getUsage())
expectAssignable<Promise<unknown>>(minimal.switchAccount("alice@github.com"))
expectAssignable<Promise<unknown>>(minimal.removeAccount("alice@github.com"))
expectAssignable<Promise<unknown>>(minimal.quit())
expectAssignable<Promise<unknown>>(minimal.upgrade())

// --- the error a consumer branches on ---------------------------------------
// `retryable` is the client's whole retry decision procedure; it must stay a
// readable boolean on the exported class, not something only the engine can see.
export function isWorthRetrying(error: unknown): boolean {
  if (error instanceof ControlRpcError) {
    expectAssignable<number>(error.code)
    expectAssignable<string>(error.message)
    expectAssignable<unknown>(error.data)
    return error.retryable
  }
  return false
}
