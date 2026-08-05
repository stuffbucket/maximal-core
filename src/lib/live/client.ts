/**
 * ControlClient — the consumer-side SDK for the /control surface. A UI-server
 * tier or desktop app uses this to read state, drive actions, and stay in sync
 * with the live event stream. Isomorphic (uses `fetch` + ReadableStream, no
 * browser-only APIs), so it runs in a browser, Bun, or Node.
 *
 * Transport is the locked decision (docs/spec/control-api.md): a fetch-based SSE
 * reader, NOT native EventSource — so it can send auth headers, at the cost of
 * re-implementing reconnect/backoff and Last-Event-ID resume here.
 *
 * State model mirrors the server: a `snapshot` frame seeds per-topic state, then
 * full-resource `upsert` deltas overwrite by topic. Heartbeat comments and the
 * cursor/epoch bookkeeping are handled transparently.
 */

import {
  frameEnvelopeSchema,
  type ControlTopic,
  type SnapshotPayload,
} from "~/lib/live/contract"

export interface ControlClientOptions {
  /** Origin the proxy is listening on, e.g. "http://127.0.0.1:4141". */
  baseUrl: string
  /** Mount prefix for the control surface (matches server.ts). */
  controlPath?: string
  /** Auth headers sent on every request (e.g. { "x-api-key": "…" }). */
  headers?: Record<string, string>
  /** Injectable fetch (tests / custom agents). Defaults to global fetch. */
  fetch?: typeof fetch
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
  private readonly fetchImpl: typeof fetch
  private readonly reconnectMs: number
  private readonly maxReconnectMs: number
  private readonly sleep: (ms: number) => Promise<void>

  private state: ControlState = {}
  private readonly listeners = new Set<StateListener>()
  private abort: AbortController | null = null
  private closed = false

  constructor(options: ControlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.controlPath = options.controlPath ?? "/control"
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetch ?? fetch
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

  private async streamOnce(onProgress: () => void): Promise<void> {
    this.abort = new AbortController()
    const headers: Record<string, string> = {
      ...this.headers,
      accept: "text/event-stream",
    }
    // No `Last-Event-ID` / epoch: the feed is not resumable (ADR-0023). A drop
    // reconnects and re-snapshots, which is why this is a plain GET with no
    // resume state to carry.
    const res = await this.fetchImpl(this.url("/events"), {
      headers,
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
      headers:
        init?.body === undefined ?
          this.headers
        : { ...this.headers, "content-type": "application/json" },
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
