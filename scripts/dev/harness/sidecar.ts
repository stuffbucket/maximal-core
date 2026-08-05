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
import type { ChildProcessWithoutNullStreams } from "node:child_process"

import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { awaitReadyLine, sidecarSpawnEnv } from "~/lib/live/supervisor"

export interface Sidecar {
  child: ChildProcessWithoutNullStreams
  port: number
  pid: number
  /** Everything stdout emitted before the ready-line, in order. */
  bootLines: Array<string>
  /** Everything stdout+stderr emits *after* the ready-line, appended live.
   *  A harness that only kept boot lines could not tell an intentional exit
   *  from a coincidental crash. */
  logLines: Array<string>
  /** Base URL of the bound control plane. */
  baseUrl: string
}

export interface StartOptions {
  /** Pid the sidecar's watchdog should watch. Defaults to this harness. Pass a
   *  decoy when the point of the harness is to kill the watched parent without
   *  killing the process that owns the pipes. */
  parentPid?: number
  readyTimeoutMs?: number
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
function launchCommand(): { cmd: string; args: Array<string> } {
  const binary = process.env.MAXIMAL_E2E_BINARY
  if (binary) return { cmd: binary, args: ["start", "--port", "0"] }
  return { cmd: "bun", args: ["src/main.ts", "start", "--port", "0"] }
}

/** What the current run is exercising, for harness output. */
export function launchLabel(): string {
  return process.env.MAXIMAL_E2E_BINARY ?
      `compiled binary (${process.env.MAXIMAL_E2E_BINARY})`
    : "source"
}

/**
 * Spawn the real binary and wait until it announces its bound port.
 *
 * Always `--port 0` and always a fresh temp home: a harness must never read or
 * write the developer's real config, and must never collide with an engine they
 * already have running.
 */
export async function startSidecar(
  options: StartOptions = {},
): Promise<Sidecar> {
  const home = mkdtempSync(join(tmpdir(), "maximal-e2e-"))
  const { cmd, args } = launchCommand()
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...sidecarSpawnEnv(options.parentPid ?? process.pid),
      COPILOT_API_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const bootLines: Array<string> = []
  const ready = await awaitReadyLine(child.stdout, {
    timeoutMs: options.readyTimeoutMs ?? 30_000,
    onLine: (line) => bootLines.push(line),
  })
  // The harness owns both pipes from here. Keep *draining* them — stop and the
  // pipe buffer fills, blocking the sidecar on its next write — but collect
  // rather than discard, so a harness can attribute an exit to a cause.
  const logLines: Array<string> = []
  const collect = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) logLines.push(line)
    }
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)

  return {
    child,
    port: ready.port,
    pid: ready.pid,
    bootLines,
    logLines,
    baseUrl: `http://127.0.0.1:${ready.port}`,
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
      console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(14)} ${detail}`)
    },
    finish: () => {
      console.log("")
      process.exit(failed ? 1 : 0)
    },
  }
}

/** Resolve once the child has exited, or with null if it outlives the deadline. */
export function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((resolve) => {
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
