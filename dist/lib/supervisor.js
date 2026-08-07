// src/lib/start/boot-status.ts
import { z } from "zod";
var BOOT_STATUS_MARKER = "@@MAXIMAL_STATUS@@";
var READY_MARKER = "@@MAXIMAL_READY@@";
var port = z.number().int().min(0).max(65535);
var readyLineSchema = z.object({
  /**
   * Schema version — see `READY_LINE_VERSION`. Always **>= 1**: a running engine
   * always states its version, and this bound is what keeps the synthesised
   * `v: 0` of a normalised legacy line from validating as a current one.
   *
   * Do **not** widen this to `min(0)` to make a parser's return type fit. Emit
   * and parse are different contracts — `ParsedReadyLine` is the one with the
   * wider version — and widening here would let the engine emit a `v: 0` line
   * that means "I am a pre-split engine", which is a lie on the wire rather than
   * just in a type.
   */
  v: z.number().int().min(1),
  /** The **control plane** port: JSON-RPC, subscriptions, config, auth. This is
   *  what a supervising host connects to. Load-bearing: a supervisor asks for
   *  port 0, so this is the only way it learns where to connect. */
  controlPort: port,
  /** The **public data plane** port serving `/v1` for third-party tools. Not
   *  necessarily the requested 4141 — a busy port falls back (maximal-core#10),
   *  so a host that wants to advertise this URL must read it here. */
  proxyPort: port,
  /** The sidecar's pid — the key a client uses to invalidate cached
   *  `server/discover` results when the process is replaced (maximal-core#8). */
  pid: z.number().int()
});
var readyLineV0Schema = z.object({ port, pid: z.number().int() }).transform((line) => ({
  v: 0,
  controlPort: line.port,
  proxyPort: line.port,
  pid: line.pid
}));
var anyReadyLineSchema = z.union([readyLineSchema, readyLineV0Schema]);
var QUIT_REQUEST_MARKER = "@@MAXIMAL_QUIT@@";
var UPDATE_REQUEST_MARKER = "@@MAXIMAL_UPDATE@@";

// src/lib/live/supervisor.ts
function withOutput(message, output) {
  const trimmed = output?.trim();
  return trimmed ? `${message}
${trimmed}` : message;
}
var SidecarReadyTimeoutError = class extends Error {
  constructor(timeoutMs, output) {
    super(
      withOutput(
        `Sidecar did not emit a ready-line within ${timeoutMs}ms`,
        output
      )
    );
    this.name = "SidecarReadyTimeoutError";
  }
};
var SidecarExitedError = class extends Error {
  constructor(output) {
    super(
      withOutput(
        "Sidecar stdout closed before it emitted a ready-line",
        output
      )
    );
    this.name = "SidecarExitedError";
  }
};
function parseReadyLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${READY_MARKER} `)) return null;
  try {
    const parsed = anyReadyLineSchema.safeParse(
      JSON.parse(trimmed.slice(READY_MARKER.length + 1))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function parseBootStatus(line) {
  const withoutTerminator = line.replace(/\r?\n$/u, "");
  const prefix = `${BOOT_STATUS_MARKER} `;
  if (!withoutTerminator.startsWith(prefix)) return null;
  return withoutTerminator.slice(prefix.length);
}
var DEFAULT_READY_TIMEOUT_MS = 3e4;
function flushTrailing(buffer, onLine) {
  if (!onLine) return;
  for (const line of buffer.split("\n")) {
    if (line.trim()) onLine(line);
  }
}
async function awaitReadyLine(stdout, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SidecarReadyTimeoutError(timeoutMs)),
      timeoutMs
    );
  });
  const scan = async () => {
    const decoder = new TextDecoder();
    const iterator = stdout[Symbol.asyncIterator]();
    let buffer = "";
    for (; ; ) {
      const next = await iterator.next();
      if (next.done === true) throw new SidecarExitedError();
      const chunk = next.value;
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const ready = parseReadyLine(line);
        if (ready) {
          flushTrailing(buffer, options.onLine);
          return ready;
        }
        if (line.trim()) options.onLine?.(line);
        newline = buffer.indexOf("\n");
      }
    }
  };
  try {
    return await Promise.race([scan(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function sidecarSpawnEnv(parentPid = process.pid) {
  return { MAXIMAL_SIDECAR_PARENT_PID: String(parentPid) };
}
export {
  BOOT_STATUS_MARKER,
  QUIT_REQUEST_MARKER,
  SidecarExitedError,
  SidecarReadyTimeoutError,
  UPDATE_REQUEST_MARKER,
  awaitReadyLine,
  parseBootStatus,
  parseReadyLine,
  sidecarSpawnEnv
};
