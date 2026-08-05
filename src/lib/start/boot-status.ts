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
 * `READY_MARKER` — the structured, versioned ready-line a supervisor parses to
 * discover the ephemeral ports it must connect to (maximal-core#3); see
 * `emitReadyLine`.
 *
 * All are no-ops for plain CLI users — gated on the parent-pid env the shell sets
 * when it spawns the sidecar — so their terminal never sees a marker.
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
 * Ready-line schema version, as stamped by *this* engine.
 *
 * Carried in the payload so a parser can *dispatch* on the shape rather than
 * infer it from which keys happen to be present. This line is a published
 * contract consumed outside this repo, and it has already changed once (one
 * port → two); assume it will change again.
 *
 * - **absent on the wire** — the original `{ port, pid }`, emitted when a single
 *   listener served both the proxy and the control plane. A parser normalises it
 *   and reports `v: 0`, a value no engine ever emits.
 * - **1** — two listeners: `controlPort` + `proxyPort`.
 *
 * A parser accepts *any* `v >= 1` whose fields still validate: `v` is
 * informational, not a gate. A newer engine that adds a field must not hang an
 * older host, and the fields a host actually needs are the ones it validates.
 */
export const READY_LINE_VERSION = 1

const port = z.number().int().min(0).max(65_535)

/**
 * The ready-line payload **as this engine emits it**.
 *
 * Schema rather than a bare interface because this is a **wire boundary** — the
 * line is read back out of another process's stdout — and because emitter and
 * parser then share one definition instead of two that drift: this same object
 * is the current-version branch of `anyReadyLineSchema`, so there is exactly one
 * description of the current shape.
 */
export const readyLineSchema = z.object({
  /**
   * Schema version — see `READY_LINE_VERSION`. Always **>= 1**: a running engine
   * always states its version, and this bound is what keeps the synthesised
   * `v: 0` of a normalised legacy line from validating as a current one.
   *
   * Do **not** widen this to `min(0)` to make a parser's return type fit. Emit
   * and parse are different contracts — `ParsedReadyLine` is the one with the
   * wider version — and widening here would let the engine emit a `v: 0` line
   * that means "I am a pre-split engine", which is a lie on the wire rather than
   * just in a type.
   */
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
 * The pre-#14 payload: one listener served both planes.
 *
 * Kept parseable because this parser ships to hosts that may supervise an older
 * engine. Normalised onto the current shape by pointing both ports at the single
 * one, which is exactly what that engine did — so **normalisation is total**: a
 * host reaches the control plane on `controlPort` and advertises `proxyPort`
 * against a v0 engine exactly as it would against a v1 one, with no branch.
 *
 * `v: 0` is a literal rather than a plain number so a host that wants to *report*
 * "supervising a pre-split engine" can narrow on it, and so this shape is a
 * distinct member of `ParsedReadyLine` rather than being folded into the
 * emitter's type.
 */
export const readyLineV0Schema = z
  .object({ port, pid: z.number().int() })
  .transform((line) => ({
    v: 0 as const,
    controlPort: line.port,
    proxyPort: line.port,
    pid: line.pid,
  }))

/**
 * Either shape, normalised — what a **parser** accepts, as opposed to what the
 * emitter produces. The current version is tried first; the two are unambiguous
 * (a v0 line has no `controlPort`, a current line has no `port`), so order is
 * for clarity rather than correctness.
 */
export const anyReadyLineSchema = z.union([readyLineSchema, readyLineV0Schema])

/**
 * What a supervisor needs to reach and manage a freshly-spawned sidecar, **as
 * emitted** by this engine. `v` is always >= 1; `emitReadyLine` takes this.
 */
export type ReadyLine = z.infer<typeof readyLineSchema>

/**
 * What a parser returns: the same four fields, but `v` may also be `0`.
 *
 * Deliberately a *different* type from `ReadyLine`, because the parser is
 * strictly more permissive than the emitter — it accepts a legacy line and any
 * future version. Annotating a parse result with `ReadyLine` is the schema
 * lying about itself: it hands a caller that trusts "v >= 1" a `v: 0` with
 * nothing to warn it.
 *
 * The two are not collapsed into one widened type, and the union is not made
 * one a consumer *must* narrow, for the same reason: there is nothing a host
 * does differently between a v0 and a v1 engine. Every field is usable without
 * narrowing (see `readyLineV0Schema`), so `v` is for reporting and feature
 * gating only.
 */
export type ParsedReadyLine = z.infer<typeof anyReadyLineSchema>

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
