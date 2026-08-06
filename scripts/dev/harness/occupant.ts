/**
 * A stand-in process that holds a port, for the `--replace` harness.
 *
 * **Harness scaffolding, not a product surface.** Nothing here ships.
 *
 * `evictRunning` decides whether to terminate whatever is listening on a port.
 * Both halves of that decision need a *counterparty a harness controls*: one
 * that answers the identity probe like maximal and reports exactly what the
 * eviction request carried, and one that plainly is not maximal and must be
 * left alone. A real second engine can do the first job and neither the second
 * nor the observation, which is the whole reason this exists.
 *
 * ## Why a child process rather than a listener inside the harness
 *
 * The safety property under test is "the evictor does not signal a process that
 * is not ours". If it regressed, an in-process listener would mean the *harness*
 * receives the SIGTERM/SIGKILL — the run would die mid-way with no report line,
 * which is a red build for a reason nobody can read. A separate process makes
 * the same regression an ordinary `FAIL` with the pid and the signal on it.
 *
 * ## Why `Bun.serve` inside `--eval`
 *
 * Same argument as the lifecycle harness's decoy parent: `process.execPath` is
 * the Bun already interpreting this file, so it is present by construction on
 * any machine that can run the harness at all — no PATH lookup, no `.exe`
 * suffix, no shell, and therefore nothing POSIX-only. `--eval` keeps it to one
 * process and avoids a temp file whose path would end up in the occupant's
 * command line, which matters: `evictRunning`'s last-resort branch reads the
 * listener's command line through `ps` and treats anything matching
 * `/(?:^|\/)maximal(?:\s|$)/` as ours. The interpolations below are all
 * `JSON.stringify`'d harness constants, so nothing in this argv can drift into
 * looking like a maximal invocation and make the guard pass for the wrong
 * reason.
 */
import type { ChildProcess } from "node:child_process"

import { spawn } from "node:child_process"

import { waitForLine } from "./sidecar"

/** Printed once the listener is bound, followed by the port it got. */
const READY = "occupant-ready"
/** Printed when `POST /_internal/shutdown` arrives, followed by its headers as
 *  JSON. The line is emitted whether or not the occupant obeys — "was it even
 *  asked" and "did it comply" are separate questions. */
const ASKED = "occupant-asked-to-shut-down"

const START_MS = 10_000
/** Longer than any run of this harness. Occupants are always killed explicitly;
 *  this only bounds a leak if the harness itself dies mid-run. */
const IDLE_MS = 600_000
/** Enough for Bun to flush the 202 before the process goes. Mirrors the 250ms
 *  the real `/_internal/shutdown` handler waits for the same reason. */
const DRAIN_MS = 50

export interface OccupantOptions {
  /** Body served at `/`. `probePort` treats exactly `Server running` as "another
   *  maximal" and everything else as a foreign process, so this one string is
   *  what makes an occupant evictable or not. */
  identity: string
  /** Whether `POST /_internal/shutdown` releases the port. A real maximal does;
   *  a foreign server has no such endpoint and 404s. */
  obeys: boolean
}

export interface Occupant {
  child: ChildProcess
  /** The ephemeral port it bound. Never a fixed one — the suite has been bitten
   *  by port contention before. */
  port: number
  /** stdout+stderr, live-appended. Carries the `ASKED` line. */
  lines: Array<string>
  /** Headers of the shutdown POST it received, or null if it was never asked. */
  shutdownHeaders: () => Record<string, string> | null
  kill: () => void
}

function source(options: OccupantOptions): string {
  return `
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname
    if (req.method === "POST" && path === "/_internal/shutdown") {
      console.log(${JSON.stringify(ASKED)} + " " + JSON.stringify(Object.fromEntries(req.headers)))
      if (!${JSON.stringify(options.obeys)}) return new Response("not found", { status: 404 })
      setTimeout(() => { process.exit(0) }, ${DRAIN_MS})
      return new Response(JSON.stringify({ ok: true, draining: true }), { status: 202 })
    }
    if (path === "/") return new Response(${JSON.stringify(options.identity)})
    return new Response("not found", { status: 404 })
  },
})
console.log(${JSON.stringify(READY)} + " " + server.port)
setTimeout(() => { process.exit(1) }, ${IDLE_MS})
`
}

/** Spawn an occupant and resolve once it has announced a bound port. Waiting
 *  for the announcement is load-bearing: a listener that failed to bind would
 *  otherwise hand back a port nobody holds, and every check below it would go
 *  green for the wrong reason. */
export async function startOccupant(
  options: OccupantOptions,
): Promise<Occupant> {
  const child = spawn(process.execPath, ["--eval", source(options)], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const lines: Array<string> = []
  const collect = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) lines.push(line)
    }
  }
  child.stdout?.on("data", collect)
  child.stderr?.on("data", collect)

  const ready = await waitForLine(
    lines,
    (line) => line.startsWith(`${READY} `),
    START_MS,
  )
  if (!ready) {
    child.kill("SIGKILL")
    throw new Error(
      `occupant never bound a port within ${START_MS}ms: ${lines.join(" / ") || "(silent)"}`,
    )
  }
  const port = Number.parseInt(ready.slice(READY.length + 1).trim(), 10)
  if (!Number.isInteger(port) || port <= 0) {
    child.kill("SIGKILL")
    throw new Error(`occupant announced an unusable port: ${ready}`)
  }

  return {
    child,
    port,
    lines,
    shutdownHeaders: () => {
      const line = lines.find((l) => l.startsWith(`${ASKED} `))
      if (line === undefined) return null
      try {
        return JSON.parse(line.slice(ASKED.length + 1)) as Record<string, string>
      } catch {
        return null
      }
    },
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
      }
    },
  }
}
