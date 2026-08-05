/**
 * Port pre-flight: probe the configured port and decide what to bind, per the
 * configured policy (`server.portPolicy`). Runs before the several seconds of
 * Copilot bootstrap so a conflict surfaces immediately rather than as an
 * EADDRINUSE deep inside srvx.
 *
 * Also: optional eviction of a stale prior maximal instance via `--replace`.
 */

import consola from "consola"
import net from "node:net"

import type { PortPolicy } from "~/lib/config/config"

import { getConfiguredApiKeys } from "~/lib/auth/request-auth"
import { evictRunning } from "~/lib/platform/replace-running"
import { emitBootStatus } from "~/lib/start/boot-status"

/** Wrap evictRunning() with the CLI's error-handling. On failure to
 *  free the port we exit 1 with a readable message rather than dumping
 *  a stack trace. */
export async function maybeEvictRunning(port: number): Promise<void> {
  const keys = getConfiguredApiKeys()
  const apiKey = keys[0] ?? null
  try {
    await evictRunning({ apiKey, port })
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

/** Print a friendly explanation of why the port is held and exit 1.
 *  Diagnostic differentiates "another maximal" from "something else." */
export function reportPortBusyAndExit(
  port: number,
  occupant: "maximal" | "other",
): never {
  if (occupant === "maximal") {
    consola.error(
      [
        `Port ${port} is already in use by another maximal instance.`,
        ``,
        `Options:`,
        `  • Re-run with --replace to evict it.`,
        `  • Stop the other instance and try again.`,
        `  • Pass --port <n> to use a different port.`,
      ].join("\n"),
    )
  } else {
    const lookupHint =
      process.platform === "darwin" || process.platform === "linux" ?
        `lsof -i :${port}`
      : `Get-Process -Id (Get-NetTCPConnection -LocalPort ${port}).OwningProcess`
    consola.error(
      [
        `Port ${port} is in use by another process (not maximal).`,
        ``,
        `Pass --port <n> to use a different port, or stop the other process.`,
        ``,
        `Find the offender with:`,
        `    ${lookupHint}`,
      ].join("\n"),
    )
  }
  process.exit(1)
}

export async function probePort(
  port: number,
): Promise<"free" | "maximal" | "other"> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return "other"
    const text = (await res.text()).trim()
    return text === "Server running" ? "maximal" : "other"
  } catch {
    return "free"
  }
}

/**
 * Addresses a bind test has to try.
 *
 * The *specific* loopback addresses, not just the wildcards, because Node sets
 * `SO_REUSEADDR` and BSD-family kernels then happily let a wildcard bind
 * coexist with a specific-address one. Testing only `0.0.0.0` therefore reports
 * "free" for a port another app already holds on `127.0.0.1` — which is exactly
 * the case this function exists to catch. The wildcard is still worth testing
 * last: it is what the server actually binds.
 */
const BIND_TEST_HOSTS = ["127.0.0.1", "::1", "0.0.0.0"] as const

/** Errors that mean "someone else has this", as opposed to "this address
 *  family is not available on this machine", which is not our problem. */
const IN_USE_CODES = new Set(["EADDRINUSE", "EACCES"])

function tryListen(
  port: number,
  host: string,
): Promise<"free" | "held" | "n/a"> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve(IN_USE_CODES.has(error.code ?? "") ? "held" : "n/a")
    })
    probe.once("listening", () => {
      probe.close(() => {
        resolve("free")
      })
    })
    try {
      probe.listen(port, host)
    } catch {
      resolve("n/a")
    }
  })
}

/**
 * Can we actually bind this port?
 *
 * `probePort` asks "does something answer HTTP here", which is the right
 * question for *naming* an occupant but the wrong one for *choosing* a port. A
 * non-HTTP listener answers nothing and would look free; worse, a listener on
 * one address family is invisible to a probe that resolved the other. That last
 * case is not hypothetical — a port held by another app on `127.0.0.1` probes
 * free over IPv6, and a server that then binds there is unreachable at
 * `127.0.0.1` for every client that resolves IPv4 first.
 *
 * Still a TOCTOU race against the real bind — unavoidable short of keeping the
 * socket — but it collapses the window from "wrong answer" to "briefly stale
 * answer".
 */
export async function isPortBindable(port: number): Promise<boolean> {
  for (const host of BIND_TEST_HOSTS) {
    if ((await tryListen(port, host)) === "held") return false
  }
  return true
}

/**
 * How many ports `next` will try before giving up, counting the requested one.
 *
 * Bounded because an unbounded scan turns "the port is busy" into "the app
 * hangs at startup", which is a worse failure and a harder one to diagnose. A
 * span of 20 clears any plausible pile-up of local instances while still
 * failing fast when something is holding a whole range.
 */
export const PORT_SCAN_LIMIT = 20

/** Highest port there is. The scan never runs past it. */
const MAX_PORT = 65_535

/**
 * Outcome of applying the policy. A *decision*, deliberately not an action:
 * `resolvePort` never calls `process.exit`, so it stays testable without
 * stubbing process globals, and the one place that exits stays obvious.
 */
export type PortResolution =
  | { ok: true; port: number; movedFrom?: number }
  | { ok: false; reason: "busy"; port: number; occupant: "maximal" | "other" }
  | { ok: false; reason: "exhausted"; from: number; through: number }
  | { ok: false; reason: "evict-failed"; port: number }

export interface ResolvePortDeps {
  probe?: (port: number) => Promise<"free" | "maximal" | "other">
  /** Whether the port can actually be bound. Separate from `probe`, which only
   *  answers who is there over HTTP. */
  bindable?: (port: number) => Promise<boolean>
  evict?: (port: number) => Promise<void>
}

/**
 * Decide which port to bind, given the configured policy.
 *
 * Port 0 passes straight through: the caller asked the OS to choose, so there
 * is nothing to probe and no conflict to resolve.
 *
 * A port counts as usable only when nothing answers HTTP there *and* it is
 * actually bindable on both address families. The two checks answer different
 * questions and neither alone is sufficient — see `isPortBindable`.
 */
export async function resolvePort(
  requested: number,
  policy: PortPolicy,
  deps: ResolvePortDeps = {},
): Promise<PortResolution> {
  if (requested === 0) return { ok: true, port: 0 }

  const probe = deps.probe ?? probePort
  const bindable = deps.bindable ?? isPortBindable

  const occupant = await probe(requested)
  if (occupant === "free" && (await bindable(requested))) {
    return { ok: true, port: requested }
  }
  // Something is there even if it never answered HTTP — a non-HTTP listener, or
  // one on the family the probe did not reach. Treat it as a foreign process:
  // it is not ours, so it is not ours to evict.
  const holder = occupant === "free" ? "other" : occupant

  switch (policy) {
    case "fail": {
      return { ok: false, reason: "busy", port: requested, occupant: holder }
    }

    case "replace": {
      // Only ever evict another maximal. A foreign process on this port is not
      // ours to kill, so that degrades to exactly what `fail` would report.
      if (holder !== "maximal") {
        return { ok: false, reason: "busy", port: requested, occupant: holder }
      }
      const evict = deps.evict ?? maybeEvictRunning
      await evict(requested)
      if (!(await bindable(requested))) {
        return { ok: false, reason: "evict-failed", port: requested }
      }
      return { ok: true, port: requested }
    }

    case "next": {
      return scanForNextFree(requested, probe, bindable)
    }

    default: {
      // Exhaustiveness anchor: adding a policy without handling it becomes a
      // compile error rather than a silent fall-through to the requested port.
      const unhandled: never = policy
      throw new Error(`Unhandled port policy: ${String(unhandled)}`)
    }
  }
}

/** Walk upward from `requested` for the first port that is both quiet and
 *  bindable. Split out so `resolvePort` stays under the complexity budget and
 *  the scan's bounds are readable on their own. */
async function scanForNextFree(
  requested: number,
  probe: (port: number) => Promise<"free" | "maximal" | "other">,
  bindable: (port: number) => Promise<boolean>,
): Promise<PortResolution> {
  const through = Math.min(requested + PORT_SCAN_LIMIT - 1, MAX_PORT)
  for (let candidate = requested + 1; candidate <= through; candidate++) {
    if ((await probe(candidate)) !== "free") continue
    if (!(await bindable(candidate))) continue
    return { ok: true, port: candidate, movedFrom: requested }
  }
  return { ok: false, reason: "exhausted", from: requested, through }
}

/**
 * Apply a resolution: announce a move, or explain the failure and exit 1.
 *
 * The move is always announced. A server quietly listening somewhere other than
 * where it was told to is the kind of surprise that costs an hour to unpick.
 */
export function portOrExit(resolution: PortResolution): number {
  if (resolution.ok) {
    if (resolution.movedFrom !== undefined) {
      consola.warn(
        `Port ${resolution.movedFrom} is in use — starting on ${resolution.port} instead.`,
      )
      emitBootStatus(
        `Port ${resolution.movedFrom} busy, using ${resolution.port}…`,
      )
    }
    return resolution.port
  }

  switch (resolution.reason) {
    case "busy": {
      reportPortBusyAndExit(resolution.port, resolution.occupant)
      break
    }
    case "evict-failed": {
      consola.error(
        `Port ${resolution.port} is still held after evicting the maximal instance on it.`,
      )
      process.exit(1)
      break
    }
    case "exhausted": {
      consola.error(
        [
          `Port ${resolution.from} is in use, and so is every port through ${resolution.through}.`,
          ``,
          `Options:`,
          `  • Pass --port <n> to start somewhere else.`,
          `  • Free one of the ports in that range.`,
          `  • Set "server": { "portPolicy": "replace" } in config to evict a maximal instance.`,
        ].join("\n"),
      )
      process.exit(1)
      break
    }
    default: {
      const unhandled: never = resolution
      throw new Error(`Unhandled resolution: ${String(unhandled)}`)
    }
  }
  throw new Error("unreachable: every failure branch exits")
}
