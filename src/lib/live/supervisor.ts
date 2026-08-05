/**
 * Sidecar supervision helpers for a host that spawns `maximal start`
 * (stuffbucket/maximal#408).
 *
 * Core owns the ready-line protocol, so it owns the parser. The alternative —
 * every host re-deriving the marker format — is the drift hazard the contract
 * package exists to prevent, and a supervisor that mis-parses the line hangs
 * forever on a sidecar that started fine.
 *
 * Deliberately **no `child_process` dependency**: this takes the already-spawned
 * process's stdout as an async iterable. A host may spawn with `node:child_process`,
 * Electron's `utilityProcess`, Bun.spawn, or a test double, and core has no
 * business dictating which. The boundary is the protocol, not the process model.
 */
import { READY_MARKER, type ReadyLine } from "~/lib/start/boot-status"

/** Thrown when the sidecar never announces readiness. Distinguishes "it died"
 *  from "it is still starting", which a supervisor must report differently. */
export class SidecarReadyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Sidecar did not emit a ready-line within ${timeoutMs}ms`)
    this.name = "SidecarReadyTimeoutError"
  }
}

/** Thrown when stdout closed before a ready-line arrived — the sidecar exited. */
export class SidecarExitedError extends Error {
  constructor() {
    super("Sidecar stdout closed before it emitted a ready-line")
    this.name = "SidecarExitedError"
  }
}

/**
 * Parse one stdout line, returning the ready payload or null for anything else.
 *
 * Returns null rather than throwing on a malformed marker line: a supervisor
 * should keep reading (the real line may follow) instead of aborting a healthy
 * boot over one garbled write.
 */
export function parseReadyLine(line: string): ReadyLine | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(`${READY_MARKER} `)) return null
  try {
    // Declared `unknown` rather than cast: `JSON.parse` returns `any`, and
    // letting that spread would defeat the field checks below.
    const parsed: unknown = JSON.parse(trimmed.slice(READY_MARKER.length + 1))
    const { port, pid } = (parsed ?? {}) as Partial<ReadyLine>
    if (typeof port !== "number" || typeof pid !== "number") return null
    return { port, pid }
  } catch {
    return null
  }
}

export interface AwaitReadyOptions {
  /** Give up after this long. A supervisor needs an upper bound, or a sidecar
   *  wedged before its bind hangs the whole app launch. */
  timeoutMs?: number
  /** Called for every non-ready stdout line — wire to a log or the splash so a
   *  slow boot shows progress instead of a blank window. */
  onLine?: (line: string) => void
}

const DEFAULT_READY_TIMEOUT_MS = 30_000

/** Emit whole lines left in the buffer behind the ready marker. */
function flushTrailing(buffer: string, onLine?: (line: string) => void): void {
  if (!onLine) return
  for (const line of buffer.split("\n")) {
    if (line.trim()) onLine(line)
  }
}

/**
 * Read the sidecar's stdout until it announces readiness.
 *
 * Resolves with the bound port and pid — the port because a supervised sidecar
 * binds an **ephemeral** port and this is the only way to learn it, and the pid
 * because it is the invalidation key for a cached `server/discover`
 * (maximal-core#8).
 *
 * Lines are re-assembled across chunk boundaries: stdout is a byte stream, and a
 * marker can straddle two reads. A supervisor that split on chunks rather than
 * newlines would drop the line intermittently under load, which is exactly the
 * kind of bug that only shows up on a slow machine.
 *
 * **The stream is left open.** Iteration is manual rather than `for await`,
 * because exiting a `for await` calls `iterator.return()`, which destroys a Node
 * Readable — closing the read end of the pipe so the sidecar dies with `EPIPE`
 * on its very next log line. The host keeps ownership and must continue draining
 * stdout after this resolves, or the pipe buffer fills and the child blocks.
 */
export async function awaitReadyLine(
  stdout: AsyncIterable<Uint8Array | string>,
  options: AwaitReadyOptions = {},
): Promise<ReadyLine> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SidecarReadyTimeoutError(timeoutMs)),
      timeoutMs,
    )
  })

  const scan = async (): Promise<ReadyLine> => {
    const decoder = new TextDecoder()
    const iterator = stdout[Symbol.asyncIterator]()
    let buffer = ""
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) throw new SidecarExitedError()
      const chunk = next.value
      buffer +=
        typeof chunk === "string" ? chunk : (
          decoder.decode(chunk, { stream: true })
        )
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const ready = parseReadyLine(line)
        if (ready) {
          // Surface anything already buffered behind the marker so a boot line
          // sharing the chunk isn't silently dropped, then return WITHOUT
          // calling iterator.return() — that would destroy the stream.
          flushTrailing(buffer, options.onLine)
          return ready
        }
        if (line.trim()) options.onLine?.(line)
        newline = buffer.indexOf("\n")
      }
    }
  }

  try {
    return await Promise.race([scan(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Env a host must set when spawning the sidecar. Without the parent pid the
 *  sidecar emits no markers at all (that gate keeps a plain CLI terminal clean),
 *  so a supervisor that forgets it waits forever on a ready-line that will never
 *  come. */
export function sidecarSpawnEnv(parentPid: number = process.pid): {
  MAXIMAL_SIDECAR_PARENT_PID: string
} {
  return { MAXIMAL_SIDECAR_PARENT_PID: String(parentPid) }
}
