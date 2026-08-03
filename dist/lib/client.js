import {
  frameEnvelopeSchema
} from "./chunk-CGWNF5TX.js";

// src/lib/live/client.ts
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
  lastEventId = null;
  epoch = null;
  abort = null;
  closed = false;
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
  async streamOnce(onProgress) {
    this.abort = new AbortController();
    const headers = {
      ...this.headers,
      accept: "text/event-stream"
    };
    if (this.lastEventId !== null) headers["last-event-id"] = this.lastEventId;
    const query = this.epoch !== null && this.lastEventId !== null ? `?epoch=${encodeURIComponent(this.epoch)}` : "";
    const res = await this.fetchImpl(this.url(`/events${query}`), {
      headers,
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
  handleBlock(raw) {
    let id;
    let event;
    let dataStr;
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id:")) id = line.slice("id:".length).trim();
      else if (line.startsWith("event:"))
        event = line.slice("event:".length).trim();
      else if (line.startsWith("data:"))
        dataStr = line.slice("data:".length).trim();
    }
    if (event === void 0 || dataStr === void 0) return;
    const frame = frameEnvelopeSchema.parse({
      id: id === void 0 ? void 0 : Number(id),
      event,
      data: JSON.parse(dataStr)
    });
    if (id !== void 0) this.lastEventId = id;
    this.applyFrame(frame.event, frame.data);
  }
  applyFrame(topic, data) {
    if (topic === "snapshot") {
      const payload = data;
      this.epoch = payload.epoch;
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
  ControlClient
};
