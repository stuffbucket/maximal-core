import { ControlTopic } from './contract.js';
import 'zod';

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
 * A fetch-based SSE reader, NOT native EventSource — so it can send auth headers
 * and issue the subscription as a POST, at the cost of re-implementing
 * reconnect/backoff here.
 *
 * State model mirrors the server: a `control/snapshot` notification seeds
 * per-topic state, then `control/<topic>` notifications overwrite by topic.
 * Heartbeat comments are skipped transparently. There is no resume bookkeeping —
 * a dropped feed reconnects and re-snapshots.
 */

/** Thrown when a method answers with a JSON-RPC error object. Carries the code
 *  and the `data` discriminant so a caller switches on the payload, never on an
 *  HTTP status (ADR-0023). */
declare class ControlRpcError extends Error {
    readonly code: number;
    readonly data: unknown;
    constructor(code: number, message: string, data: unknown);
    /** True when the server said the failure is worth re-issuing unprompted. */
    get retryable(): boolean;
}
interface ControlClientOptions {
    /** Origin the proxy is listening on, e.g. "http://127.0.0.1:4141". */
    baseUrl: string;
    /** Mount prefix for the control surface (matches server.ts). */
    controlPath?: string;
    /** Auth headers sent on every request (e.g. { "x-api-key": "…" }). */
    headers?: Record<string, string>;
    /** Injectable fetch (tests / custom agents). Defaults to global fetch. */
    fetch?: typeof fetch;
    /** Initial reconnect backoff and its ceiling. */
    reconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    /** Sleep helper (injectable so tests don't wait real time). */
    sleep?: (ms: number) => Promise<void>;
}
type ControlState = Partial<Record<ControlTopic, unknown>>;
type StateListener = (state: ControlState) => void;
declare class ControlClient {
    private readonly baseUrl;
    private readonly controlPath;
    private readonly headers;
    private readonly fetchImpl;
    private readonly reconnectMs;
    private readonly maxReconnectMs;
    private readonly sleep;
    private state;
    private readonly listeners;
    private abort;
    private closed;
    private nextId;
    constructor(options: ControlClientOptions);
    /** Subscribe to state changes; the callback fires immediately with the
     *  current state and on every subsequent change. Returns an unsubscribe. */
    onState(listener: StateListener): () => void;
    getState(): ControlState;
    /** Start the resilient stream loop (reconnect with backoff + resume). Runs
     *  until `close()`. Resolves once the loop has ended. */
    connect(): Promise<void>;
    close(): void;
    private isClosed;
    private url;
    /**
     * Invoke a control method and return its result.
     *
     * Every call is self-contained — no session, no handshake. Use
     * `server/discover` to learn the protocol version and the callable method set
     * rather than assuming either.
     */
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
    private streamOnce;
    /** Each SSE block carries one JSON-RPC notification on its `data:` line. There
     *  is no `id:` line to track — the transport advertises no resumability. */
    private handleBlock;
    private applyFrame;
    private request;
    getAuth(): Promise<unknown>;
    getAccounts(): Promise<unknown>;
    getModels(): Promise<unknown>;
    getUsage(): Promise<unknown>;
    switchAccount(key: string): Promise<unknown>;
    removeAccount(key: string): Promise<unknown>;
    quit(): Promise<unknown>;
    upgrade(): Promise<unknown>;
}

export { ControlClient, type ControlClientOptions, ControlRpcError, type ControlState, type StateListener };
