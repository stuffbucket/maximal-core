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
/**
 * The value type a credential-bearing header name is given in
 * `NonCredentialHeaders`. Uninhabited, so nothing can be assigned to it — its
 * only job is to make the compiler's message name the reason.
 */
interface CredentialHeaderNotSupported {
    readonly credentialsAreNotSupportedOnTheControlSurface: never;
}
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
type NonCredentialHeaders = Record<string, string> & {
    [K in "api-key" | "API-Key" | "Api-Key" | "authorization" | "Authorization" | "AUTHORIZATION" | "cookie" | "Cookie" | "proxy-authorization" | "Proxy-Authorization" | "x-api-key" | "X-API-KEY" | "X-Api-Key"]?: CredentialHeaderNotSupported;
};
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
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
interface ControlClientOptions {
    /** Origin the proxy is listening on, e.g. "http://127.0.0.1:4141". */
    baseUrl: string;
    /** Mount prefix for the control surface (matches server.ts). */
    controlPath?: string;
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
    headers?: NonCredentialHeaders;
    /** Injectable fetch (tests / custom agents). Defaults to global fetch. */
    fetch?: FetchLike;
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

export { ControlClient, type ControlClientOptions, ControlRpcError, type ControlState, type FetchLike, type NonCredentialHeaders, type StateListener };
