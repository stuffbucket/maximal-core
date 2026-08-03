import { ControlTopic } from './contract.js';
import 'zod';

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
    private lastEventId;
    private epoch;
    private abort;
    private closed;
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
    private streamOnce;
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

export { ControlClient, type ControlClientOptions, type ControlState, type StateListener };
