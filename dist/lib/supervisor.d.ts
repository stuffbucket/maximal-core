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
 * All are no-ops for plain CLI users — gated on the parent-pid env the shell sets
 * when it spawns the sidecar — so their terminal never sees a marker. MUST stay in
 * `READY_MARKER` — the structured `{port,pid}` ready-line a supervisor parses to
 * discover an ephemeral port (maximal-core#3); see `emitReadyLine`.
 *
 * All marker constants MUST stay in sync with the supervisor that parses them.
 */

/**
 * The current ready-line payload.
 *
 * Schema rather than a bare interface because this is a **wire boundary** — the
 * line is read back out of another process's stdout — and because emitter and
 * parser then share one definition instead of two that drift.
 */
declare const readyLineSchema: z.ZodObject<{
    v: z.ZodNumber;
    controlPort: z.ZodNumber;
    proxyPort: z.ZodNumber;
    pid: z.ZodNumber;
}, z.core.$strip>;
/** What a supervisor needs to reach and manage a freshly-spawned sidecar. */
type ReadyLine = z.infer<typeof readyLineSchema>;

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
 * Validated with the schema the emitter is typed from (`anyReadyLineSchema`),
 * so the two cannot drift — and it accepts both versions, because this parser
 * ships to hosts that may supervise an older or newer engine than themselves:
 *
 * - **v1** — `{v:1, controlPort, proxyPort, pid}`, two listeners.
 * - **v0** (no `v`) — the original `{port, pid}`, normalised by pointing both
 *   ports at it, which is what that engine actually did.
 *
 * Returns null rather than throwing on a malformed marker line: a supervisor
 * should keep reading (the real line may follow) instead of aborting a healthy
 * boot over one garbled write.
 */
declare function parseReadyLine(line: string): ReadyLine | null;
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
declare function awaitReadyLine(stdout: AsyncIterable<Uint8Array | string>, options?: AwaitReadyOptions): Promise<ReadyLine>;
/** Env a host must set when spawning the sidecar. Without the parent pid the
 *  sidecar emits no markers at all (that gate keeps a plain CLI terminal clean),
 *  so a supervisor that forgets it waits forever on a ready-line that will never
 *  come. */
declare function sidecarSpawnEnv(parentPid?: number): {
    MAXIMAL_SIDECAR_PARENT_PID: string;
};

export { type AwaitReadyOptions, SidecarExitedError, SidecarReadyTimeoutError, awaitReadyLine, parseReadyLine, sidecarSpawnEnv };
