/**
 * Shared scaffolding for the end-to-end harnesses in `scripts/dev/`.
 *
 * **This is a harness, not a product surface and not a test head.** Nothing here
 * ships, nothing here is exported from the package, and no runtime code imports
 * it. It exists so the harnesses that spawn a real sidecar agree on how to do
 * so — a second copy of the spawn-and-await dance is exactly the drift this
 * repo avoids elsewhere.
 *
 * Why these run outside `bun test`: each one binds a socket and spends seconds
 * of wall clock waiting on a real process. They are deliberate `bun run`
 * invocations. Their value is that they exercise what a host actually does, and
 * every bug they have caught so far was invisible to the unit suite — the
 * ready-line reporting the requested port instead of the bound one, and
 * `awaitReadyLine` destroying stdout and killing the sidecar with EPIPE.
 */
import type { ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"

import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ParsedReadyLine } from "~/lib/live/supervisor"

import {
  awaitReadyLine,
  parseReadyLine,
  SidecarExitedError,
  SidecarReadyTimeoutError,
  sidecarSpawnEnv,
} from "~/lib/live/supervisor"

/**
 * What `spawn` actually returns here. The sidecar is spawned with
 * `stdio: ["ignore", "pipe", "pipe"]`, so `stdin` is `null` at runtime. The
 * previous declaration (`ChildProcessWithoutNullStreams`) typed it as a live
 * `Writable` — a lie no compiler caught, because `scripts/**` was outside every
 * tsconfig until now. Both pipes stay non-null, which is what the harness reads.
 */
type SidecarChild = ChildProcessByStdio<null, Readable, Readable>

export interface Sidecar {
  child: SidecarChild
  /** Control plane — JSON-RPC, subscriptions. Ephemeral (maximal-core#10). */
  port: number
  /** Public data plane — `/v1`. A separate listener on a separate port. */
  proxyPort: number
  pid: number
  /** Everything both pipes emitted before the ready-line, in arrival order. */
  bootLines: Array<string>
  /** Everything stdout+stderr emits *after* the ready-line, appended live.
   *  A harness that only kept boot lines could not tell an intentional exit
   *  from a coincidental crash. */
  logLines: Array<string>
  /** Base URL of the bound control plane. */
  baseUrl: string
  /** Base URL of the public `/v1` listener. */
  proxyUrl: string
}

export interface StartOptions {
  /** Pid the sidecar's watchdog should watch. Defaults to this harness. Pass a
   *  decoy when the point of the harness is to kill the watched parent without
   *  killing the process that owns the pipes. */
  parentPid?: number
  readyTimeoutMs?: number
  /** Public `/v1` port to request. Defaults to 0 — let the OS choose, which is
   *  what every harness wants unless contention *is* the subject. Pass a port
   *  something else already holds to exercise the port policy or `--replace`.
   *  The control port stays ephemeral either way. */
  proxyPort?: number
  /** Pass `--replace`: evict whatever holds `proxyPort` before binding. */
  replace?: boolean
  /** `COPILOT_API_HOME` for this engine. Defaults to a fresh temp dir. Pass one
   *  you made yourself when the engine has to boot with a seeded `config.json`
   *  — config is read during boot, so it cannot be written afterwards. */
  home?: string
}

/**
 * How to launch the engine under test.
 *
 * Defaults to running from source. Set `MAXIMAL_E2E_BINARY` to a compiled
 * binary's path and every harness runs against *that* instead — same checks,
 * different artifact. That matters because the shipped artifact is the compiled
 * one, and `--compile` is its own execution environment: bundled asset
 * resolution, `--define` substitution, and embedded-runtime behaviour all differ
 * from a source run. A regression that only appears once compiled would
 * otherwise reach a signed DMG unnoticed.
 */
function launchCommand(options: StartOptions): {
  cmd: string
  args: Array<string>
} {
  const args = [
    "start",
    "--port",
    String(options.proxyPort ?? 0),
    "--control-port",
    "0",
    ...(options.replace === true ? ["--replace"] : []),
  ]
  const binary = process.env.MAXIMAL_E2E_BINARY
  if (binary) return { cmd: binary, args }
  return { cmd: "bun", args: ["src/main.ts", ...args] }
}

/** What the current run is exercising, for harness output. */
export function launchLabel(): string {
  return process.env.MAXIMAL_E2E_BINARY ?
      `compiled binary (${process.env.MAXIMAL_E2E_BINARY})`
    : "source"
}

/**
 * Spawn the engine and hand back the process, without waiting for anything.
 *
 * Split out of `startSidecar` for the harnesses whose subject is a boot that
 * *fails* — an engine that refuses to evict a foreign occupant never emits a
 * ready-line, so `startSidecar` can only report that as a timeout.
 *
 * The caller owns both pipes from the moment this returns and must consume
 * *both* immediately: either `startSidecar` (which drains from spawn) or
 * `collectLines`. Leave a pipe undrained and its buffer fills, blocking the
 * child on its next write.
 *
 * Always a fresh temp home unless one is supplied: a harness must never read or
 * write the developer's real config, and must never collide with an engine they
 * already have running.
 */
export function spawnEngine(options: StartOptions = {}): SidecarChild {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "maximal-e2e-"))
  const { cmd, args } = launchCommand(options)
  return spawn(cmd, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...sidecarSpawnEnv(options.parentPid ?? process.pid),
      COPILOT_API_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/** Which pipe a line arrived on. Only a failure report distinguishes them: the
 *  reason a sidecar died is on stderr, and a transcript that does not say so
 *  reads as if the engine printed its own crash to stdout. */
type Pipe = "stdout" | "stderr"

/** How long to wait for a dead child's pipes to close before giving up on the
 *  rest of its output. stdout EOF and the final stderr chunk are independent
 *  events, so the transcript is incomplete at the instant a boot fails — and
 *  the last stderr line is the one worth having. */
const STREAM_FLUSH_MS = 2000

/**
 * Reassemble a byte stream into whole lines.
 *
 * `TextDecoder` rather than `String(chunk)` because a chunk boundary can fall
 * inside a multi-byte character, and `flush` emits the unterminated remainder
 * at EOF — where a crash message written without a trailing newline lives.
 */
function lineSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer) => void
  flush: () => void
} {
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    push: (chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        onLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
    },
    flush: () => {
      const rest = buffer
      buffer = ""
      if (rest.trim()) onLine(rest)
    },
  }
}

/** Attach a line drain to both pipes, now. Every caller must do this the moment
 *  it has a child: an undrained pipe fills and blocks the child on its next
 *  write, and output nobody read cannot explain anything afterwards. */
function drainBothPipes(
  child: SidecarChild,
  onLine: (pipe: Pipe, line: string) => void,
): void {
  for (const pipe of ["stdout", "stderr"] as const) {
    const stream = child[pipe]
    const splitter = lineSplitter((line) => {
      if (line.trim()) onLine(pipe, line)
    })
    stream.on("data", splitter.push)
    stream.on("end", splitter.flush)
  }
}

/**
 * Drain stdout+stderr into a live-appended buffer and return it.
 *
 * Collect rather than discard, so a harness can attribute an exit to a cause —
 * and drain rather than ignore, because a full pipe buffer blocks the child.
 */
export function collectLines(child: SidecarChild): Array<string> {
  const lines: Array<string> = []
  drainBothPipes(child, (_pipe, line) => lines.push(line))
  return lines
}

/**
 * An async iterable fed by pushes.
 *
 * `awaitReadyLine` consumes stdout as an async iterable, and that is the only
 * way to reach the parser that owns the ready-line protocol. But it must not be
 * handed `child.stdout` directly: an iterator and a `data` listener on the same
 * Readable are the documented way to lose chunks, and the harness needs the
 * `data` listener from the moment of spawn. So the harness owns the stream and
 * replays stdout through this.
 */
function chunkQueue(): {
  push: (chunk: Buffer) => void
  end: () => void
  iterable: AsyncIterable<Buffer>
} {
  const pending: Array<Buffer> = []
  let ended = false
  let wake: (() => void) | undefined
  const notify = (): void => {
    const resume = wake
    wake = undefined
    resume?.()
  }
  return {
    push: (chunk) => {
      pending.push(chunk)
      notify()
    },
    end: () => {
      ended = true
      notify()
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Buffer, undefined>> => {
          for (;;) {
            const chunk = pending.shift()
            if (chunk !== undefined) return { done: false, value: chunk }
            if (ended) return { done: true, value: undefined }
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
        },
      }),
    },
  }
}

interface Pipes {
  bootLines: Array<string>
  logLines: Array<string>
  /** stdout, replayed for `awaitReadyLine`. */
  stdout: AsyncIterable<Buffer>
  /** Everything seen so far, stream-tagged, for a boot-failure message. */
  transcript: () => string
  /** Resolves when the child has exited *and* both pipes have closed — the
   *  point at which the transcript is actually complete. */
  closed: Promise<void>
}

/**
 * Drain both pipes from the moment of spawn, splitting what arrives at the
 * ready-line.
 *
 * Both drains are attached before anything is awaited, so no window exists in
 * which stderr goes unread. The sink flips synchronously, inside the data event
 * carrying the ready-line, so pre- and post-ready output cannot be misfiled by
 * a scheduling accident — which a switch driven off the resolved promise would
 * be exposed to.
 */
function drainPipes(child: SidecarChild): Pipes {
  const bootLines: Array<string> = []
  const logLines: Array<string> = []
  const tagged: Array<string> = []
  let sink = bootLines

  const queue = chunkQueue()
  child.stdout.on("data", queue.push)
  child.stdout.on("end", queue.end)
  child.stdout.on("error", queue.end)
  // A spawn that never started (ENOENT) destroys the stdio streams without an
  // `end`, so without this the reader would sit out the whole ready timeout to
  // report a child that was never there.
  child.once("close", queue.end)

  drainBothPipes(child, (pipe, line) => {
    tagged.push(`  ${pipe}  ${line}`)
    // The ready-line is the boundary, not part of either side of it.
    if (pipe === "stdout" && parseReadyLine(line)) sink = logLines
    else sink.push(line)
  })

  return {
    bootLines,
    logLines,
    stdout: queue.iterable,
    transcript: () =>
      tagged.length === 0 ?
        "The sidecar wrote nothing to stdout or stderr."
      : `Sidecar output (${tagged.length} lines):\n${tagged.join("\n")}`,
    closed: new Promise((resolve) => child.once("close", () => resolve())),
  }
}

/**
 * Turn a failed boot into something a CI log can be diagnosed from.
 *
 * Rethrows the same error class — hosts and harnesses narrow on it — with the
 * child's own output appended to the message. Waits for the pipes to close
 * first so the transcript includes the dying words, and reaps the child either
 * way: a boot that failed must not leave an engine holding a port, and nothing
 * can track a process whose `startSidecar` threw.
 */
async function bootFailure(
  child: SidecarChild,
  pipes: Pipes,
  timeoutMs: number,
  error: unknown,
): Promise<unknown> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    pipes.closed,
    new Promise((resolve) => {
      timer = setTimeout(resolve, STREAM_FLUSH_MS)
    }),
  ])
  clearTimeout(timer)
  const transcript = pipes.transcript()
  if (error instanceof SidecarReadyTimeoutError) {
    return new SidecarReadyTimeoutError(timeoutMs, transcript)
  }
  if (error instanceof SidecarExitedError) {
    return new SidecarExitedError(transcript)
  }
  return error
}

/**
 * Spawn the real binary and wait until it announces its bound port.
 */
export async function startSidecar(
  options: StartOptions = {},
): Promise<Sidecar> {
  const child = spawnEngine(options)
  const pipes = drainPipes(child)
  const timeoutMs = options.readyTimeoutMs ?? 30_000

  let ready: ParsedReadyLine
  try {
    ready = await awaitReadyLine(pipes.stdout, { timeoutMs })
  } catch (error) {
    throw await bootFailure(child, pipes, timeoutMs, error)
  }

  return {
    child,
    port: ready.controlPort,
    proxyPort: ready.proxyPort,
    pid: ready.pid,
    bootLines: pipes.bootLines,
    logLines: pipes.logLines,
    baseUrl: `http://127.0.0.1:${ready.controlPort}`,
    proxyUrl: `http://127.0.0.1:${ready.proxyPort}`,
  }
}

export interface Reporter {
  check: (label: string, ok: boolean, detail: string) => void
  /** Exit the process with 1 if anything failed, 0 otherwise. */
  finish: () => never
}

/** One-line-per-assertion reporter. Deliberately plain: the output is read in a
 *  terminal and in CI logs, not parsed. */
export function createReporter(title: string): Reporter {
  console.log(`\n${title}  [${launchLabel()}]\n`)
  let failed = false
  return {
    check: (label, ok, detail) => {
      if (!ok) failed = true
      console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(18)} ${detail}`)
    },
    finish: () => {
      console.log("")
      process.exit(failed ? 1 : 0)
    },
  }
}

/** Resolve once the child has exited, or with null if it outlives the deadline.
 *
 *  Answers immediately for a child that has *already* exited. Node emits `exit`
 *  exactly once, so a listener attached afterwards never fires — a caller that
 *  only learns it should look after the fact (e.g. an eviction, which is
 *  complete by the time the evicting process is up) would otherwise sit out the
 *  whole timeout and report a live process as a survivor. */
export function waitForExit(
  child: SidecarChild,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timer = setTimeout(() => resolve(null), timeoutMs)
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

/** Poll a live-appended log buffer for a matching line. Returns it, or null on
 *  timeout. Polled rather than event-driven so a caller can watch a buffer that
 *  is already partly populated. */
export async function waitForLine(
  lines: Array<string>,
  match: (line: string) => boolean,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = lines.find(match)
    if (found !== undefined) return found
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
