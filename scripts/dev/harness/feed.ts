/**
 * Raw feed reader for the harnesses.
 *
 * Deliberately does **not** use `ControlClient`: the point is to check the wire
 * against the contract, and a client-driven check passes happily when client and
 * server are wrong in the same way. This parses the bytes the way a third-party
 * consumer would, so the frame shape is verified independently.
 */
export interface RawFrame {
  method: string
  params: unknown
  /** The SSE block verbatim, so a harness can assert on the framing itself
   *  (e.g. the absence of an `id:` line) and not merely the payload. */
  block: string
}

export interface CollectOptions {
  baseUrl: string
  /** Stop as soon as this is satisfied. */
  until: (frames: Array<RawFrame>) => boolean
  timeoutMs: number
  /** Runs once the response headers are in and the stream is open — the window
   *  in which to trigger whatever push the harness expects to observe. */
  onOpen?: () => Promise<void> | void
}

export interface CollectResult {
  frames: Array<RawFrame>
  status: number
  contentType: string | null
  /** Whether the response ever carried an SSE comment heartbeat. */
  sawHeartbeat: boolean
}

/** Parse one SSE block into a frame, or null for a heartbeat/blank. */
function parseBlock(block: string): RawFrame | null {
  let dataStr: string | undefined
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue
    if (line.startsWith("data:")) dataStr = line.slice("data:".length).trim()
  }
  if (dataStr === undefined) return null
  const parsed = JSON.parse(dataStr) as { method?: string; params?: unknown }
  return { method: parsed.method ?? "", params: parsed.params, block }
}

/**
 * Open `subscriptions/listen` and collect notification frames until `until` is
 * satisfied or the deadline passes.
 *
 * The subscription IS a request whose response stream stays open (ADR-0023), so
 * this is a POST that never finishes rather than a GET on a stream endpoint —
 * the endpoint MCP removed in 2026-07-28.
 */
export async function collectFrames(
  options: CollectOptions,
): Promise<CollectResult> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), options.timeoutMs)

  try {
    const res = await fetch(`${options.baseUrl}/control/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "subscriptions/listen",
      }),
      signal: abort.signal,
    })

    const frames: Array<RawFrame> = []
    let sawHeartbeat = false
    if (!res.ok || !res.body) {
      return {
        frames,
        status: res.status,
        contentType: res.headers.get("content-type"),
        sawHeartbeat,
      }
    }

    // Fire the trigger only once the stream is actually open, or the push it
    // provokes can land before there is anyone subscribed to receive it.
    void (async () => {
      await options.onOpen?.()
    })()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!options.until(frames)) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf("\n\n")
      while (sep >= 0) {
        const block = buffer.slice(0, sep)
        if (block.trimStart().startsWith(":")) sawHeartbeat = true
        const frame = parseBlock(block)
        if (frame) frames.push(frame)
        buffer = buffer.slice(sep + 2)
        sep = buffer.indexOf("\n\n")
      }
    }
    // Client close IS the unsubscribe — there is no cancel method to call.
    abort.abort()

    return {
      frames,
      status: res.status,
      contentType: res.headers.get("content-type"),
      sawHeartbeat,
    }
  } finally {
    clearTimeout(timer)
  }
}
