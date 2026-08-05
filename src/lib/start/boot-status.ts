/**
 * Structured stdout markers the desktop shell reads from the sidecar it spawns.
 *
 * `BOOT_STATUS_MARKER` — boot-phase lines relayed to the splash as live status
 * (so a slow/failed start isn't a blank "Starting…"). `QUIT_REQUEST_MARKER` — the
 * browser-tab UI's way to quit the whole app: a tab has no shell IPC to ask for
 * a quit, so it POSTs the sidecar, which signals the shell over this same channel.
 * `UPDATE_REQUEST_MARKER` — the same pattern for the in-place self-update: the
 * Settings "Upgrade" button POSTs the sidecar, which signals the shell to run the
 * signed download+install+relaunch (the shell owns the updater plugin, a tab can't).
 *
 * All are no-ops for plain CLI users — gated on the parent-pid env the shell sets
 * when it spawns the sidecar — so their terminal never sees a marker. MUST stay in
 * `READY_MARKER` — the structured `{port,pid}` ready-line a supervisor parses to
 * discover an ephemeral port (maximal-core#3); see `emitReadyLine`.
 *
 * All marker constants MUST stay in sync with the supervisor that parses them.
 */

import { z } from "zod"

export const BOOT_STATUS_MARKER = "@@MAXIMAL_STATUS@@"

export function emitBootStatus(message: string): void {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return
  process.stdout.write(`${BOOT_STATUS_MARKER} ${message}\n`)
}

export const READY_MARKER = "@@MAXIMAL_READY@@"

/**
 * Ready-line schema version.
 *
 * Carried in the payload so a parser can *dispatch* on the shape rather than
 * infer it from which keys happen to be present. This line is a published
 * contract consumed outside this repo, and it has already changed once (one
 * port → two); assume it will change again.
 *
 * - **absent** — the original `{ port, pid }`, emitted when a single listener
 *   served both the proxy and the control plane.
 * - **1** — two listeners: `controlPort` + `proxyPort`.
 */
export const READY_LINE_VERSION = 1

const port = z.number().int().min(0).max(65_535)

/**
 * The current ready-line payload.
 *
 * Schema rather than a bare interface because this is a **wire boundary** — the
 * line is read back out of another process's stdout — and because emitter and
 * parser then share one definition instead of two that drift.
 */
export const readyLineSchema = z.object({
  /** Schema version — see `READY_LINE_VERSION`. */
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
  pid: z.number().int(),
})

/**
 * The pre-#10 payload: one listener served both planes.
 *
 * Kept parseable because this parser ships to hosts that may supervise an older
 * engine. Normalised onto the current shape by pointing both ports at the single
 * one, which is exactly what that engine did.
 */
export const readyLineV0Schema = z
  .object({ port, pid: z.number().int() })
  .transform((line) => ({
    v: 0,
    controlPort: line.port,
    proxyPort: line.port,
    pid: line.pid,
  }))

/**
 * Either shape, normalised. v1 is tried first; the two are unambiguous (a v0
 * line has no `controlPort`, a v1 line has no `port`), so order is for clarity
 * rather than correctness.
 */
export const anyReadyLineSchema = z.union([readyLineSchema, readyLineV0Schema])

/** What a supervisor needs to reach and manage a freshly-spawned sidecar. */
export type ReadyLine = z.infer<typeof readyLineSchema>

/**
 * Announce readiness on stdout as a single structured line (maximal-core#3).
 *
 * This exists because a supervised sidecar binds an **ephemeral** port rather
 * than a fixed 4141, so the supervisor cannot know the URL in advance and
 * polling a guessed port is a race. Emitted only once the server is actually
 * accepting connections — a supervisor that connects on this line must not find
 * a closed socket.
 *
 * Gated on the parent-pid env like every other marker, so a plain CLI user's
 * terminal never sees it.
 */
export function emitReadyLine(ready: ReadyLine): boolean {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return false
  process.stdout.write(`${READY_MARKER} ${JSON.stringify(ready)}\n`)
  return true
}

export const QUIT_REQUEST_MARKER = "@@MAXIMAL_QUIT@@"

/**
 * Ask the supervising desktop shell to quit the whole app (shell + sidecar). Returns
 * whether a shell is present to receive the request (false on a plain-CLI run,
 * where there is nothing to quit and the caller should say so).
 */
export function emitQuitRequest(): boolean {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return false
  process.stdout.write(`${QUIT_REQUEST_MARKER}\n`)
  return true
}

export const UPDATE_REQUEST_MARKER = "@@MAXIMAL_UPDATE@@"

/**
 * Ask the supervising desktop shell to run the in-place self-update (download the
 * signed bundle, verify its signature, swap, relaunch). Returns whether a shell is
 * present to receive the request (false on a plain-CLI run, where there is no
 * updatable app bundle — the caller should fall back to the download page).
 */
export function emitUpdateRequest(): boolean {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return false
  process.stdout.write(`${UPDATE_REQUEST_MARKER}\n`)
  return true
}
