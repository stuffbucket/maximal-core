import { z } from 'zod';

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

/**
 * The ready-line payload **as this engine emits it**.
 *
 * Schema rather than a bare interface because this is a **wire boundary** — the
 * line is read back out of another process's stdout — and because emitter and
 * parser then share one definition instead of two that drift: this same object
 * is the current-version branch of `anyReadyLineSchema`, so there is exactly one
 * description of the current shape.
 */
declare const readyLineSchema: z.ZodObject<{
    v: z.ZodNumber;
    controlPort: z.ZodNumber;
    proxyPort: z.ZodNumber;
    pid: z.ZodNumber;
}, z.core.$strip>;
/**
 * Either shape, normalised — what a **parser** accepts, as opposed to what the
 * emitter produces. The current version is tried first; the two are unambiguous
 * (a v0 line has no `controlPort`, a current line has no `port`), so order is
 * for clarity rather than correctness.
 */
declare const anyReadyLineSchema: z.ZodUnion<readonly [z.ZodObject<{
    v: z.ZodNumber;
    controlPort: z.ZodNumber;
    proxyPort: z.ZodNumber;
    pid: z.ZodNumber;
}, z.core.$strip>, z.ZodPipe<z.ZodObject<{
    port: z.ZodNumber;
    pid: z.ZodNumber;
}, z.core.$strip>, z.ZodTransform<{
    v: 0;
    controlPort: number;
    proxyPort: number;
    pid: number;
}, {
    port: number;
    pid: number;
}>>]>;
/**
 * What a supervisor needs to reach and manage a freshly-spawned sidecar, **as
 * emitted** by this engine. `v` is always >= 1; `emitReadyLine` takes this.
 */
type ReadyLine = z.infer<typeof readyLineSchema>;
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
type ParsedReadyLine = z.infer<typeof anyReadyLineSchema>;

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

/** Thrown when the sidecar never announces readiness. Distinguishes "it died"
 *  from "it is still starting", which a supervisor must report differently. */
declare class SidecarReadyTimeoutError extends Error {
    constructor(timeoutMs: number);
}
/** Thrown when stdout closed before a ready-line arrived — the sidecar exited. */
declare class SidecarExitedError extends Error {
    constructor();
}
/**
 * Parse one stdout line, returning the ready payload or null for anything else.
 *
 * Validated with the schema the emitter is typed from (`anyReadyLineSchema`,
 * whose current-version branch *is* `readyLineSchema`), so the two cannot drift
 * — and it accepts both versions, because this parser ships to hosts that may
 * supervise an older or newer engine than themselves:
 *
 * - **v1** — `{v:1, controlPort, proxyPort, pid}`, two listeners. Any higher `v`
 *   carrying those fields parses too: a newer engine must not hang an older host.
 * - **v0** (no `v`) — the original `{port, pid}`, normalised by pointing both
 *   ports at it, which is what that engine actually did.
 *
 * Returns `ParsedReadyLine`, **not** `ReadyLine`: the v0 branch reports `v: 0`,
 * which the emitter's `v >= 1` does not admit. Annotating this `ReadyLine` type-
 * checks (`0` is a `number`) and is exactly the lie this signature avoids.
 * Nothing else changes for a caller — normalisation is total, so the ports and
 * pid are usable without narrowing on `v`.
 *
 * Returns null rather than throwing on a malformed marker line: a supervisor
 * should keep reading (the real line may follow) instead of aborting a healthy
 * boot over one garbled write.
 */
declare function parseReadyLine(line: string): ParsedReadyLine | null;
interface AwaitReadyOptions {
    /** Give up after this long. A supervisor needs an upper bound, or a sidecar
     *  wedged before its bind hangs the whole app launch. */
    timeoutMs?: number;
    /** Called for every non-ready stdout line — wire to a log or the splash so a
     *  slow boot shows progress instead of a blank window. */
    onLine?: (line: string) => void;
}
/**
 * Read the sidecar's stdout until it announces readiness.
 *
 * Resolves with the bound ports and pid — `controlPort` because a supervised
 * sidecar binds an **ephemeral** control port and this is the only way to learn
 * it, `proxyPort` because the public `/v1` port falls back when 4141 is busy
 * (maximal-core#10), and the pid because it is the invalidation key for a cached
 * `server/discover` (maximal-core#8).
 *
 * Resolves with a `ParsedReadyLine`, so an engine older than this host resolves
 * too (`v: 0`, both ports pointing at its single listener). A host that wants to
 * log which protocol version it is supervising narrows on `v`; a host that only
 * wants to connect does not have to.
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
declare function awaitReadyLine(stdout: AsyncIterable<Uint8Array | string>, options?: AwaitReadyOptions): Promise<ParsedReadyLine>;
/** Env a host must set when spawning the sidecar. Without the parent pid the
 *  sidecar emits no markers at all (that gate keeps a plain CLI terminal clean),
 *  so a supervisor that forgets it waits forever on a ready-line that will never
 *  come. */
declare function sidecarSpawnEnv(parentPid?: number): {
    MAXIMAL_SIDECAR_PARENT_PID: string;
};

export { type AwaitReadyOptions, type ParsedReadyLine, type ReadyLine, SidecarExitedError, SidecarReadyTimeoutError, awaitReadyLine, parseReadyLine, sidecarSpawnEnv };
