/**
 * ControlClient — the consumer-side SDK for the /control surface. A UI-server
 * tier or desktop app uses this to read state, drive actions, and stay in sync
 * with the live event stream. Isomorphic (uses `fetch` + ReadableStream, no
 * browser-only APIs), so it runs in a browser, Bun, or Node.
 *
 * Speaks the stateless JSON-RPC 2.0 control plane (ADR-0023): `call()` for
 * request/response, and a `subscriptions/listen` stream for push. Both go to the
 * one `POST /control/rpc` endpoint.
 *
 * A fetch-based SSE reader, NOT native EventSource — the subscription IS a POST
 * (`subscriptions/listen` to the one `/control/rpc` endpoint) and EventSource is
 * GET-only and browser-only, at the cost of re-implementing reconnect/backoff
 * here. It is NOT "so it can send auth headers": this client sends no
 * credential, and the surface it talks to accepts none (see
 * `ControlClientOptions.headers`).
 *
 * State model mirrors the server: a `control/snapshot` notification seeds
 * per-topic state, then `control/<topic>` notifications overwrite by topic.
 * Heartbeat comments are skipped transparently. There is no resume bookkeeping —
 * a dropped feed reconnects and re-snapshots.
 */

import {
  frameEnvelopeSchema,
  PROTOCOL_VERSION_HEADER,
  SUPPORTED_PROTOCOL_VERSION,
  type ControlTopic,
  type SnapshotPayload,
} from "~/lib/live/contract"

/** Thrown when a method answers with a JSON-RPC error object. Carries the code
 *  and the `data` discriminant so a caller switches on the payload, never on an
 *  HTTP status (ADR-0023). */
export class ControlRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data: unknown) {
    super(message)
    this.name = "ControlRpcError"
    this.code = code
    this.data = data
  }

  /** True when the server said the failure is worth re-issuing unprompted. */
  get retryable(): boolean {
    return (this.data as { retryable?: boolean } | null)?.retryable === true
  }
}

/**
 * The value type a credential-bearing header name is given in
 * `NonCredentialHeaders`. Uninhabited, so nothing can be assigned to it — its
 * only job is to make the compiler's message name the reason.
 */
interface CredentialHeaderNotSupported {
  readonly credentialsAreNotSupportedOnTheControlSurface: never
}

/**
 * The header names this client refuses to send, lowercased.
 *
 * The first two are the only names the sidecar's own `extractRequestApiKey`
 * ever reads, so they are the ones a caller would reach for; the rest are the
 * remaining standard credential-bearing request headers plus the common
 * misspelling of `x-api-key`. Matched case-insensitively — HTTP header names
 * are case-insensitive, so `Authorization` and `AUTHORIZATION` are the same
 * header and must be rejected the same way.
 */
const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "cookie",
])

/**
 * Request headers that are NOT credentials — tracing ids, content negotiation,
 * a correlation header a dev proxy needs. Credential-bearing names are typed as
 * an uninhabited sentinel, so `{ "x-api-key": key }` is a compile error at the
 * call site rather than a request that silently ships a secret.
 *
 * This is a tripwire, not a proof, and for exactly the reason `eslint.config.js`
 * gives for the repo-side guard: it decides on the SHAPE of the key, so it
 * catches literal spellings (including a `const` holding an object literal) and
 * cannot catch a `Record<string, string>` assembled elsewhere and passed in —
 * `keyof` that is `string`, which matches no literal. The constructor's runtime
 * check is what closes that half, and it is case-insensitive where this type
 * can only enumerate spellings.
 */
export type NonCredentialHeaders = Record<string, string> & {
  [K in
    | "api-key"
    | "API-Key"
    | "Api-Key"
    | "authorization"
    | "Authorization"
    | "AUTHORIZATION"
    | "cookie"
    | "Cookie"
    | "proxy-authorization"
    | "Proxy-Authorization"
    | "x-api-key"
    | "X-API-KEY"
    | "X-Api-Key"]?: CredentialHeaderNotSupported
}

/**
 * Validate and copy the caller's headers into the record this client actually
 * sends.
 *
 * Copying is not incidental. The caller keeps a reference to the object it
 * passed, so validating in place would leave it free to add a credential after
 * construction and have every later request pick it up; the copy makes the
 * check hold for the client's whole life.
 *
 * @throws TypeError if any header name is credential-bearing.
 */
function toRequestHeaders(
  headers: NonCredentialHeaders | undefined,
): Record<string, string> {
  const copied: Record<string, string> = {}
  if (headers === undefined) return copied
  // Keys + index access, not `Object.entries`: entries widens the value to the
  // union that includes the rejection sentinel, while indexing by a `string`
  // resolves through the record's index signature and stays `string`.
  for (const name of Object.keys(headers)) {
    if (CREDENTIAL_HEADER_NAMES.has(name.trim().toLowerCase())) {
      throw new TypeError(
        `ControlClient: refusing to send the credential header "${name}". `
          + "The control surface is loopback-only and takes no credential — the "
          + "server never reads a key off a /control request, so this one would "
          + "be inert on the wire and a leak if `baseUrl` were ever wrong. "
          + "Pass non-credential headers only. See ADR-0001.",
      )
    }
    copied[name] = headers[name]
  }
  return copied
}

/**
 * The shape of the injectable `fetch`.
 *
 * Narrowed on purpose rather than `typeof fetch`, mirroring
 * `lib/update/update-check.ts`: `typeof fetch` carries implementation extras
 * (Bun's types put `preconnect` on it), so a plain stub function is NOT
 * assignable to it and the "injectable fetch (tests / custom agents)" seam did
 * not actually accept one. This signature is what the real `fetch` and a plain
 * stub are both assignable to. It only widens what callers may pass — a value
 * that satisfied `typeof fetch` still satisfies this.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ControlClientOptions {
  /** Origin the proxy is listening on, e.g. "http://127.0.0.1:4141". */
  baseUrl: string
  /** Mount prefix for the control surface (matches server.ts). */
  controlPath?: string
  /**
   * Extra NON-CREDENTIAL headers sent on every request — tracing/correlation
   * ids and the like. This is not an auth hook, and there is no auth hook:
   *
   * - The control surface takes **no** credential. `/control` is listed in the
   *   auth middleware's `allowUnauthenticatedPrefixes`, and `shouldBypass`
   *   returns before a key is ever extracted, so a key sent here is not merely
   *   optional — it is never read. The surface is protected by being
   *   loopback-only (the control router 404s a remote caller itself) on an
   *   ephemeral port, behind an Origin allowlist (ADR-0021).
   * - Credentials that DO leave this project attach in exactly one place,
   *   `src/lib/http/send-request.ts`, which picks the credential from the
   *   destination host so a caller cannot choose the wrong one (ADR-0001). A
   *   credential passed through here would bypass that mechanism entirely, and
   *   `baseUrl` is caller-supplied — so a misconfigured origin would put the
   *   operator's key on a wire it was never meant to reach.
   *
   * Credential-bearing names are therefore rejected: at compile time by the
   * type for literal spellings, and at construction time by a case-insensitive
   * check that also covers a record built elsewhere. Passing one throws
   * `TypeError`.
   */
  headers?: NonCredentialHeaders
  /** Injectable fetch (tests / custom agents). Defaults to global fetch. */
  fetch?: FetchLike
  /** Initial reconnect backoff and its ceiling. */
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
  /** Sleep helper (injectable so tests don't wait real time). */
  sleep?: (ms: number) => Promise<void>
}

export type ControlState = Partial<Record<ControlTopic, unknown>>
export type StateListener = (state: ControlState) => void

const DEFAULT_RECONNECT_MS = 500
const DEFAULT_MAX_RECONNECT_MS = 15_000

export class ControlClient {
  private readonly baseUrl: string
  private readonly controlPath: string
  private readonly headers: Record<string, string>
  /** `headers` plus the pinned wire version — what every request but
   *  `server/discover` is sent with (maximal-core#8). */
  private readonly versionedHeaders: Record<string, string>
  private readonly fetchImpl: FetchLike
  private readonly reconnectMs: number
  private readonly maxReconnectMs: number
  private readonly sleep: (ms: number) => Promise<void>

  private state: ControlState = {}
  private readonly listeners = new Set<StateListener>()
  private abort: AbortController | null = null
  private closed = false
  private nextId = 0

  constructor(options: ControlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.controlPath = options.controlPath ?? "/control"
    // Validated + copied once, here, rather than checked at each send: the
    // record is fixed for the client's life, so one check covers every request.
    this.headers = toRequestHeaders(options.headers)
    // Built once alongside them: the version this client speaks is fixed for its
    // life, so there is nothing to recompute per request (maximal-core#8).
    this.versionedHeaders = {
      ...this.headers,
      [PROTOCOL_VERSION_HEADER]: SUPPORTED_PROTOCOL_VERSION,
    }
    // BOUND, not bare. The field is invoked as `this.fetchImpl(...)`, so an
    // unbound `fetch` receives the ControlClient instance as its receiver.
    // Node and Bun tolerate that; a browser or Electron renderer does not —
    // `window.fetch` demands `window` and throws `TypeError: Illegal
    // invocation` otherwise. Every renderer-side consumer therefore failed on
    // its FIRST call, and the default path (no `options.fetch`) is the broken
    // one, so it was the common case rather than an edge (maximal-core#104).
    //
    // The unit suites cannot see it: the receiver rule is browser-only, so
    // Node and Bun both pass a bare `fetch` happily. `client.test.ts` asserts
    // the receiver instead — a check that fails without a browser.
    //
    // An injected fetch is left exactly as given: the caller already owns its
    // binding, and re-binding someone else's function would change what an
    // arrow capturing `this` resolves to.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.reconnectMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS
    this.maxReconnectMs =
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS
    this.sleep =
      options.sleep
      ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Subscribe to state changes; the callback fires immediately with the
   *  current state and on every subsequent change. Returns an unsubscribe. */
  onState(listener: StateListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState(): ControlState {
    return this.state
  }

  /** Start the resilient stream loop (reconnect with backoff + resume). Runs
   *  until `close()`. Resolves once the loop has ended. */
  async connect(): Promise<void> {
    let backoff = this.reconnectMs
    while (!this.isClosed()) {
      try {
        await this.streamOnce(() => {
          backoff = this.reconnectMs // reset on any delivered frame
        })
      } catch {
        // Connection dropped / failed — fall through to backoff + retry.
      }
      if (this.isClosed()) break
      await this.sleep(backoff)
      backoff = Math.min(backoff * 2, this.maxReconnectMs)
    }
  }

  close(): void {
    this.closed = true
    this.abort?.abort()
  }

  // Read through a method so control-flow narrowing doesn't wrongly treat the
  // field as constant across `await` boundaries (it's flipped by close()).
  private isClosed(): boolean {
    return this.closed
  }

  private url(path: string): string {
    return `${this.baseUrl}${this.controlPath}${path}`
  }

  /**
   * Invoke a control method and return its result.
   *
   * Every call is self-contained — no session, no handshake. Use
   * `server/discover` to learn the protocol version and the callable method set
   * rather than assuming either.
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.url("/rpc"), {
      method: "POST",
      headers: {
        // Every request pins the wire version EXCEPT `server/discover` — the
        // one call a client makes to LEARN that version. Pinning it there would
        // be circular, and the server's allowance for an absent header exists
        // for exactly that case; this is its client half (maximal-core#8).
        ...(method === "server/discover" ?
          this.headers
        : this.versionedHeaders),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.nextId,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    })
    const body = (await res.json()) as {
      result?: T
      error?: { code: number; message: string; data?: unknown }
    }
    if (body.error) {
      throw new ControlRpcError(
        body.error.code,
        body.error.message,
        body.error.data,
      )
    }
    return body.result as T
  }

  private async streamOnce(onProgress: () => void): Promise<void> {
    this.abort = new AbortController()
    const headers: Record<string, string> = {
      ...this.versionedHeaders,
      accept: "text/event-stream",
    }
    // The subscription IS a request: its response stream stays open and carries
    // notifications. No `Last-Event-ID` — the feed is not resumable (ADR-0023),
    // so a drop reconnects and re-snapshots with no resume state to carry.
    const res = await this.fetchImpl(this.url("/rpc"), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.nextId,
        method: "subscriptions/listen",
      }),
      signal: this.abort.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`control stream failed: ${res.status}`)
    }

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!this.isClosed()) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf("\n\n")
      while (sep >= 0) {
        this.handleBlock(buffer.slice(0, sep))
        onProgress()
        buffer = buffer.slice(sep + 2)
        sep = buffer.indexOf("\n\n")
      }
    }
  }

  /** Each SSE block carries one JSON-RPC notification on its `data:` line. There
   *  is no `id:` line to track — the transport advertises no resumability. */
  private handleBlock(raw: string): void {
    let dataStr: string | undefined
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue // heartbeat comment
      if (line.startsWith("data:")) dataStr = line.slice("data:".length).trim()
    }
    if (dataStr === undefined) return
    const frame = frameEnvelopeSchema.parse(JSON.parse(dataStr))
    const topic =
      frame.method.startsWith("control/") ?
        frame.method.slice("control/".length)
      : frame.method
    this.applyFrame(topic as ControlTopic, frame.params)
  }

  private applyFrame(topic: ControlTopic, data: unknown): void {
    if (topic === "snapshot") {
      const payload = data as SnapshotPayload<Record<string, unknown>>
      // The snapshot's resource keys are themselves topics.
      this.state = { ...(payload.snapshot as ControlState) }
    } else {
      this.state = { ...this.state, [topic]: data }
    }
    for (const listener of this.listeners) listener(this.state)
  }

  // ── Reads / actions (thin fetch helpers) ──────────────────────────────────

  private async request(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> {
    const res = await this.fetchImpl(this.url(path), {
      method: init?.method ?? "GET",
      // Spread rather than handing `this.headers` over as-is: the client's copy
      // is the one thing that has been validated, and an injected `fetch` (or a
      // polyfill) that mutates the record it is given must not be able to reach
      // it. Also keeps every send site an object literal, which is the shape a
      // reader — and `eslint.config.js`'s guard — can actually inspect.
      headers:
        init?.body === undefined ?
          { ...this.versionedHeaders }
        : { ...this.versionedHeaders, "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return res.json()
  }

  getAuth(): Promise<unknown> {
    return this.request("/auth")
  }
  getAccounts(): Promise<unknown> {
    return this.request("/accounts")
  }
  getModels(): Promise<unknown> {
    return this.request("/models")
  }
  getUsage(): Promise<unknown> {
    return this.request("/usage")
  }
  switchAccount(key: string): Promise<unknown> {
    return this.request("/accounts/switch", { method: "POST", body: { key } })
  }
  removeAccount(key: string): Promise<unknown> {
    return this.request("/accounts/remove", { method: "POST", body: { key } })
  }
  quit(): Promise<unknown> {
    return this.request("/quit", { method: "POST" })
  }
  upgrade(): Promise<unknown> {
    return this.request("/upgrade", { method: "POST" })
  }
}
