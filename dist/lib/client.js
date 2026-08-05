import {
  frameEnvelopeSchema
} from "./chunk-ITKEMUH2.js";

// src/lib/live/client.ts
var ControlRpcError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "ControlRpcError";
    this.code = code;
    this.data = data;
  }
  /** True when the server said the failure is worth re-issuing unprompted. */
  get retryable() {
    return this.data?.retryable === true;
  }
};
var DEFAULT_RECONNECT_MS = 500;
var DEFAULT_MAX_RECONNECT_MS = 15e3;
var ControlClient = class {
  baseUrl;
  controlPath;
  headers;
  fetchImpl;
  reconnectMs;
  maxReconnectMs;
  sleep;
  state = {};
  listeners = /* @__PURE__ */ new Set();
  abort = null;
  closed = false;
  nextId = 0;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.controlPath = options.controlPath ?? "/control";
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.reconnectMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
    this.maxReconnectMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  /** Subscribe to state changes; the callback fires immediately with the
   *  current state and on every subsequent change. Returns an unsubscribe. */
  onState(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getState() {
    return this.state;
  }
  /** Start the resilient stream loop (reconnect with backoff + resume). Runs
   *  until `close()`. Resolves once the loop has ended. */
  async connect() {
    let backoff = this.reconnectMs;
    while (!this.isClosed()) {
      try {
        await this.streamOnce(() => {
          backoff = this.reconnectMs;
        });
      } catch {
      }
      if (this.isClosed()) break;
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, this.maxReconnectMs);
    }
  }
  close() {
    this.closed = true;
    this.abort?.abort();
  }
  // Read through a method so control-flow narrowing doesn't wrongly treat the
  // field as constant across `await` boundaries (it's flipped by close()).
  isClosed() {
    return this.closed;
  }
  url(path) {
    return `${this.baseUrl}${this.controlPath}${path}`;
  }
  /**
   * Invoke a control method and return its result.
   *
   * Every call is self-contained — no session, no handshake. Use
   * `server/discover` to learn the protocol version and the callable method set
   * rather than assuming either.
   */
  async call(method, params) {
    const res = await this.fetchImpl(this.url("/rpc"), {
      method: "POST",
      headers: {
        ...this.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.nextId,
        method,
        ...params === void 0 ? {} : { params }
      })
    });
    const body = await res.json();
    if (body.error) {
      throw new ControlRpcError(
        body.error.code,
        body.error.message,
        body.error.data
      );
    }
    return body.result;
  }
  async streamOnce(onProgress) {
    this.abort = new AbortController();
    const headers = {
      ...this.headers,
      accept: "text/event-stream"
    };
    const res = await this.fetchImpl(this.url("/rpc"), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.nextId,
        method: "subscriptions/listen"
      }),
      signal: this.abort.signal
    });
    if (!res.ok || !res.body) {
      throw new Error(`control stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.isClosed()) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        this.handleBlock(buffer.slice(0, sep));
        onProgress();
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");
      }
    }
  }
  /** Each SSE block carries one JSON-RPC notification on its `data:` line. There
   *  is no `id:` line to track — the transport advertises no resumability. */
  handleBlock(raw) {
    let dataStr;
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) dataStr = line.slice("data:".length).trim();
    }
    if (dataStr === void 0) return;
    const frame = frameEnvelopeSchema.parse(JSON.parse(dataStr));
    const topic = frame.method.startsWith("control/") ? frame.method.slice("control/".length) : frame.method;
    this.applyFrame(topic, frame.params);
  }
  applyFrame(topic, data) {
    if (topic === "snapshot") {
      const payload = data;
      this.state = { ...payload.snapshot };
    } else {
      this.state = { ...this.state, [topic]: data };
    }
    for (const listener of this.listeners) listener(this.state);
  }
  // ── Reads / actions (thin fetch helpers) ──────────────────────────────────
  async request(path, init) {
    const res = await this.fetchImpl(this.url(path), {
      method: init?.method ?? "GET",
      headers: init?.body === void 0 ? this.headers : { ...this.headers, "content-type": "application/json" },
      body: init?.body === void 0 ? void 0 : JSON.stringify(init.body)
    });
    return res.json();
  }
  getAuth() {
    return this.request("/auth");
  }
  getAccounts() {
    return this.request("/accounts");
  }
  getModels() {
    return this.request("/models");
  }
  getUsage() {
    return this.request("/usage");
  }
  switchAccount(key) {
    return this.request("/accounts/switch", { method: "POST", body: { key } });
  }
  removeAccount(key) {
    return this.request("/accounts/remove", { method: "POST", body: { key } });
  }
  quit() {
    return this.request("/quit", { method: "POST" });
  }
  upgrade() {
    return this.request("/upgrade", { method: "POST" });
  }
};
export {
  ControlClient,
  ControlRpcError
};
