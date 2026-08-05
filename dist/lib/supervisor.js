// src/lib/start/boot-status.ts
var READY_MARKER = "@@MAXIMAL_READY@@";

// src/lib/live/supervisor.ts
var SidecarReadyTimeoutError = class extends Error {
  constructor(timeoutMs) {
    super(`Sidecar did not emit a ready-line within ${timeoutMs}ms`);
    this.name = "SidecarReadyTimeoutError";
  }
};
var SidecarExitedError = class extends Error {
  constructor() {
    super("Sidecar stdout closed before it emitted a ready-line");
    this.name = "SidecarExitedError";
  }
};
function parseReadyLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${READY_MARKER} `)) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(READY_MARKER.length + 1));
    const { port, pid } = parsed ?? {};
    if (typeof port !== "number" || typeof pid !== "number") return null;
    return { port, pid };
  } catch {
    return null;
  }
}
var DEFAULT_READY_TIMEOUT_MS = 3e4;
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
    let buffer = "";
    for await (const chunk of stdout) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, {
        stream: true
      });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const ready = parseReadyLine(line);
        if (ready) return ready;
        if (line.trim()) options.onLine?.(line);
        newline = buffer.indexOf("\n");
      }
    }
    throw new SidecarExitedError();
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
  SidecarExitedError,
  SidecarReadyTimeoutError,
  awaitReadyLine,
  parseReadyLine,
  sidecarSpawnEnv
};
