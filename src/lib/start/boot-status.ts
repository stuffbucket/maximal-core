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

export const BOOT_STATUS_MARKER = "@@MAXIMAL_STATUS@@"

export function emitBootStatus(message: string): void {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return
  process.stdout.write(`${BOOT_STATUS_MARKER} ${message}\n`)
}

export const READY_MARKER = "@@MAXIMAL_READY@@"

/** What a supervisor needs to reach and manage a freshly-spawned sidecar. */
export interface ReadyLine {
  /** The port actually bound. Load-bearing: a supervisor asks for port 0 to get
   *  an ephemeral port, so this is the only way it learns where to connect. */
  port: number
  /** The sidecar's pid — the key a client uses to invalidate cached
   *  `server/discover` results when the process is replaced (maximal-core#8). */
  pid: number
}

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
