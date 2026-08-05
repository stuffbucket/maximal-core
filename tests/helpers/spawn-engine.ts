/**
 * Spawn the real `start` engine for an integration test and learn the ports it
 * actually bound.
 *
 * **Why this exists.** The tests that spawn a real server used to guess a port
 * — `4143 + random(100)`, `4243 + random(100)`, `4343 + random(100)` — and
 * derive the control port as `port + 1`. Those windows overlap each other at
 * both seams (a proxy port of 4242 takes 4243 for control, which is the bottom
 * of the next test's window), so two files could pick the same socket in the
 * same run and only in the same run. That is the whole of the flake: it passes
 * in isolation because nothing else is running.
 *
 * Guessing is also unnecessary. `--port 0` / `--control-port 0` asks the OS for
 * ephemeral ports — which by construction cannot collide with anything, in this
 * suite or on the developer's machine — and the engine already publishes what it
 * bound on the ready-line (`src/lib/start/boot-status.ts`). This is the same
 * seam `scripts/dev/harness/sidecar.ts` uses for the e2e harnesses; unit-level
 * integration tests now go through it too instead of a second, weaker mechanism.
 *
 * The ready-line is gated on `MAXIMAL_SIDECAR_PARENT_PID`, so `sidecarSpawnEnv`
 * is not optional — without it the engine emits no marker and this waits out its
 * whole timeout.
 *
 * `awaitReadyLine` is deliberately NOT reused here: it takes ownership of an
 * async iterator over stdout and never releases it, and a `ReadableStream` can
 * only be iterated once. A test needs to keep draining after boot (an undrained
 * pipe fills and blocks the child) *and* keep the lines for failure output, so
 * this owns one loop that does both and reuses the exported `parseReadyLine`.
 */
import { fileURLToPath } from "node:url"

import { parseReadyLine, sidecarSpawnEnv } from "~/lib/live/supervisor"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))

const DEFAULT_READY_TIMEOUT_MS = 30_000

export interface Engine {
  proc: ReturnType<typeof Bun.spawn>
  /** Public `/v1` listener, as bound. Never 0, never guessed. */
  proxyPort: number
  /** Private control listener — `/control`, `/_debug/state`. */
  controlPort: number
  proxyUrl: string
  controlUrl: string
  /** Every stdout+stderr line seen, boot and after. Surfaced on failure. */
  logLines: Array<string>
  /** SIGTERM and wait for the child to actually go. */
  stop: () => Promise<void>
}

export interface StartEngineOptions {
  /** `COPILOT_API_HOME` for this engine — always a fresh temp dir, so a test
   *  never reads or writes the developer's real data. */
  home: string
  /** Extra `start` args appended after the two port flags. */
  args?: Array<string>
  /** Extra env, merged last. */
  env?: Record<string, string>
  readyTimeoutMs?: number
}

/** Drain `stream` line-by-line into `sink` forever, ignoring a close/reset —
 *  the child exiting is a normal end of stream, not a test failure. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  sink: Array<string>,
  onLine?: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) {
          sink.push(line)
          onLine?.(line)
        }
        newline = buffer.indexOf("\n")
      }
    }
  } catch {
    /* stream torn down with the child */
  }
  if (buffer.trim()) {
    sink.push(buffer)
    onLine?.(buffer)
  }
}

export async function startEngine(
  options: StartEngineOptions,
): Promise<Engine> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "./src/main.ts",
      "start",
      // Ephemeral on both listeners. The ready-line reports what was bound.
      "--port",
      "0",
      "--control-port",
      "0",
      ...(options.args ?? []),
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...sidecarSpawnEnv(process.pid),
      COPILOT_API_HOME: options.home,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      // Make sure no env-bearer slips in.
      GITHUB_TOKEN: "",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const logLines: Array<string> = []
  const stop = async (): Promise<void> => {
    proc.kill("SIGTERM")
    await proc.exited
  }

  let resolveReady: (ports: { proxyPort: number; controlPort: number }) => void
  const readyPromise = new Promise<{
    proxyPort: number
    controlPort: number
  }>((resolve) => {
    resolveReady = resolve
  })

  // One loop over stdout: it finds the ready-line AND keeps draining after, so
  // the pipe never fills and every line stays available for failure output.
  void drain(proc.stdout, logLines, (line) => {
    const ready = parseReadyLine(line)
    if (ready) {
      resolveReady({
        proxyPort: ready.proxyPort,
        controlPort: ready.controlPort,
      })
    }
  })
  void drain(proc.stderr, logLines)

  const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Engine did not announce a ready-line within ${timeoutMs}ms.\n${logLines.join("\n")}`,
        ),
      )
    }, timeoutMs)
  })

  let ports: { proxyPort: number; controlPort: number }
  try {
    ports = await Promise.race([readyPromise, timeout])
  } catch (error) {
    await stop()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }

  return {
    proc,
    proxyPort: ports.proxyPort,
    controlPort: ports.controlPort,
    proxyUrl: `http://127.0.0.1:${ports.proxyPort}`,
    controlUrl: `http://127.0.0.1:${ports.controlPort}`,
    logLines,
    stop,
  }
}
