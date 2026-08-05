/**
 * `runServer` — the boot orchestrator for `maximal start`.
 *
 * Each phase is a single line of intent: port preflight, config merge,
 * boot logger, secrets, upstream bootstrap, claude-code helper, bind,
 * pidfile, post-bind reconcile, shutdown handlers. Implementation lives
 * in sibling modules (port.ts, boot-io.ts, bootstrap.ts, shutdown.ts,
 * claude-code-flow.ts) so this file reads as a checklist.
 */

import consola from "consola"
import { serve } from "srvx"

import { removeLegacyShimIfPresent } from "~/apps/claude-code/detect"
import { reconcileClaudeCodeOnBoot } from "~/apps/claude-code/reconcile"
import { type AccountType } from "~/lib/auth/auth-types"
import {
  DEFAULT_PORT_POLICY,
  getConfig,
  mergeConfigWithDefaults,
} from "~/lib/config/config"
import { initProxyFromEnv } from "~/lib/http/proxy"
import { ensureCliSymlink } from "~/lib/platform/cli-path"
import { initOpencodeVersion } from "~/lib/platform/opencode"
import { ensurePaths } from "~/lib/platform/paths"
import { writePidfile } from "~/lib/platform/replace-running"
import {
  cacheMacMachineId,
  cacheVsCodeDeviceId,
  cacheVsCodeSessionId,
  cacheVSCodeVersion,
} from "~/lib/platform/utils"
import { hasGithubToken, state } from "~/lib/runtime-state/state"
import { startTokenUsageRetention } from "~/lib/token-usage"
import { getGitVersion, shortSha } from "~/lib/update/version"

import { initBootLogger, printReadyBanner } from "./boot-io"
import {
  emitBootStatus,
  emitReadyLine,
  READY_LINE_VERSION,
} from "./boot-status"
import { bootSecrets, bootstrapUpstream } from "./bootstrap"
import { runClaudeCodeFlow } from "./claude-code-flow"
import { maybeEvictRunning, portOrExit, resolvePort } from "./port"
import {
  markSessionRunning,
  staleSessionMarkerPresent,
} from "./session-sentinel"
import { installShutdownHandlers } from "./shutdown"

// Injectable server binder. Defaults to srvx's real `serve()`; tests swap it
// via `__setServeForTests` to avoid binding a port. This is a module-local
// seam ON PURPOSE — the alternative, `mock.module("srvx", …)`, forward-leaks
// the stub into sibling files that need the REAL srvx (the real-port WS
// handshake test), and Bun does not reset module mocks between files. See
// docs/dev/testing-strategy.md §5 + the mockModuleLeakGuard eslint rule.
type ServeFn = typeof serve
let serveImpl: ServeFn = serve

/** Test-only: swap the srvx `serve` binder. Pass `null` to restore the real one. */
export function __setServeForTests(fn: ServeFn | null): void {
  serveImpl = fn ?? serve
}

export interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: AccountType
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  /** Evict any running instance on :4141 before binding. Optional —
   *  test fixtures + non-CLI callers can omit; treated as false. */
  replace?: boolean
  /** Port for the private control plane (maximal-core#10). Defaults to 0 —
   *  ephemeral — because nothing external is meant to find it; a supervisor
   *  learns the bound value from the ready-line. */
  controlPort?: number
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // Work around unjs/consola#357 until a release includes PR #359.
  consola.options.throttle = 0

  // Print something immediately so users know `maximal start` is
  // doing something. The next ~3-5s are spent on Copilot bootstrap
  // (token exchange, model fetch, machine-id + session-id caching),
  // and without this line the terminal just sits silent.
  consola.start("Starting maximal…")

  // If --replace was passed, try to take over the port from a
  // running instance before the regular probe. An explicit flag outranks the
  // configured policy — the user said what they wanted on this run.
  if (options.replace) {
    emitBootStatus(`Taking over port ${options.port}…`)
    await maybeEvictRunning(options.port)
  }

  // Ensure config is merged with defaults at startup. Ahead of the port
  // decision because that decision now reads `server.portPolicy` from it.
  mergeConfigWithDefaults()

  // Resolve the port we will actually bind. Default policy moves to the next
  // free port rather than refusing to start; `fail` restores the old behaviour.
  // Port 0 passes through untouched — the OS is choosing.
  const port = portOrExit(
    await resolvePort(
      options.port,
      getConfig().server?.portPolicy ?? DEFAULT_PORT_POLICY,
    ),
  )

  // The control plane is ephemeral by default, so there is nothing to contend
  // for and no policy to apply — 0 goes straight through to the OS. A caller
  // that pins it explicitly gets the same policy treatment as the public port.
  const controlPortRequested = await resolveControlPort(options.controlPort)

  const git = getGitVersion()
  consola.info(
    `Source revision: ${shortSha(git.sha)}${git.branch ? ` (${git.branch})` : ""}`,
  )

  const bootLogger = initBootLogger(git, options)

  await initOpencodeVersion()

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.verbose = options.verbose
  if (options.verbose) {
    // Module-scope mutation, but runServer runs once at startup —
    // no concurrent caller exists.
    // eslint-disable-next-line require-atomic-updates
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  // Record the port we're about to bind so the control-surface Origin guard +
  // CORS (server.ts) know which localhost origin is "us" (§6). Set before the
  // bind since the server module reads it lazily, per-request.
  state.proxyPort = port
  state.controlPort = controlPortRequested

  await ensurePaths()
  bootSecrets()

  // Crash-detection: did the previous run exit ungracefully (skipped
  // initiateShutdown AND the `exit` safety net — i.e. SIGKILL, power
  // loss, OS-level kill)? If so AND the Claude Code base URL is still
  // ours from before, the user has likely been hitting "connection
  // refused" in `claude` since then. We can't auto-recover the
  // inter-session window (an external watchdog would be needed), but
  // we can at least surface the cause so the symptom isn't mysterious.
  // The reconcileClaudeCodeOnBoot() call below will re-apply the URL
  // for the new session; that ends the broken-window.
  const staleSession = staleSessionMarkerPresent()
  if (staleSession) {
    consola.warn(
      "Previous maximal session ended ungracefully (likely a crash, "
        + "force-quit, or system shutdown). If `claude` produced "
        + "connection-refused errors since then, that was why — your "
        + "Claude Code config still pointed at this proxy. Routing is "
        + "being re-applied now and will work again.",
    )
  }

  // One-shot cleanup of the pre-v0.4.13 ~/.local/share/maximal/shims/claude
  // wrapper, which is now orphaned (we route via ~/.claude/settings.json
  // instead). The shim emits 'maximal: the claude binary this shim wrapped
  // is gone' when its hard-coded versioned target disappears on Claude
  // auto-update, which breaks `claude` invocations until manually removed.
  // Idempotent; only deletes a file carrying the SHIM_MARKER.
  const removedShim = removeLegacyShimIfPresent()
  if (removedShim) {
    consola.info(`Removed legacy Claude Code shim at ${removedShim}`)
  }

  // First-launch CLI shim (macOS .dmg only). The .app bundle's CLI
  // lives at …/Maximal.app/Contents/MacOS/maximal, off every default
  // PATH; symlink it into ~/.local/bin so `maximal` works in a
  // terminal. Idempotent + best-effort — never blocks boot. No-op for
  // Homebrew/dev launches (not an .app bundle). See lib/platform/cli-path.ts.
  const link = ensureCliSymlink()
  if (link.linked) {
    consola.info(`Linked CLI onto PATH: ${link.symlinkPath} → ${link.target}`)
    if (link.pathBlockAdded) {
      consola.info(
        "Added ~/.local/bin to PATH in ~/.zprofile (open a new terminal to pick it up).",
      )
    }
  }

  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  await bootstrapUpstream(options.githubToken)

  const executorName =
    process.env.OLLAMA_API_KEY ?
      "OllamaWebExecutor"
    : "InProcessFetchExecutor (search disabled; set OLLAMA_API_KEY)"
  consola.info(`Web-tools executor: ${executorName}`)

  const serverUrl = `http://localhost:${port}`

  if (options.claudeCode) {
    if (state.models) {
      await runClaudeCodeFlow(serverUrl)
    } else {
      consola.warn(
        "--claude-code requires an authenticated session; skipping helper.",
      )
    }
  }

  emitBootStatus("Starting the server…")

  logListening(bootLogger, serverUrl, executorName)

  const { proxyServer, controlServer } = await bindListeners(
    port,
    controlPortRequested,
  )

  finalizeBoot({
    proxyServer,
    proxyRequested: port,
    controlServer,
    controlRequested: controlPortRequested,
  })
}

/** One structured line the boot log is grepped for after the fact. */
function logListening(
  bootLogger: ReturnType<typeof initBootLogger>,
  serverUrl: string,
  executorName: string,
): void {
  bootLogger.info(
    `listening url=${serverUrl} `
      + `executor=${executorName.split(" ")[0]} `
      + `auth=${hasGithubToken() ? "authenticated" : "unauthenticated"}`,
  )
}

/**
 * Bind both listeners (maximal-core#10).
 *
 * The public one carries `/v1` on a well-known port third-party tools hardcode.
 * The control one carries the JSON-RPC surface on an ephemeral port only the
 * supervisor learns, bound **loopback-only** — the router enforces that too (a
 * remote caller gets 404), but binding to the loopback interface means a remote
 * packet never reaches the router at all.
 *
 * Two `serve()` calls rather than one app with a path filter: the separation is
 * the point, and a filter is something a later edit can quietly regress.
 */
async function bindListeners(
  proxyPort: number,
  controlPort: number,
): Promise<{
  proxyServer: ReturnType<ServeFn>
  controlServer: ReturnType<ServeFn>
}> {
  const { publicApp, controlApp } = await import("~/server")
  return {
    proxyServer: serveImpl({
      fetch: publicApp.fetch,
      port: proxyPort,
      bun: { idleTimeout: 0 },
    }),
    controlServer: serveImpl({
      fetch: controlApp.fetch,
      port: controlPort,
      hostname: "127.0.0.1",
      bun: { idleTimeout: 0 },
    }),
  }
}

/**
 * Decide the control-plane port.
 *
 * A non-integer covers both "omitted" and a caller that handed us
 * `Number.parseInt(undefined)`. Either way the answer is the same: let the OS
 * choose. Silently binding NaN would surface much later as an unreachable
 * control plane rather than as a startup error.
 *
 * An explicitly pinned port gets the same policy treatment as the public one,
 * so `--control-port 9000` against a busy 9000 moves aside instead of failing.
 */
async function resolveControlPort(
  requested: number | undefined,
): Promise<number> {
  if (
    requested === undefined
    || !Number.isInteger(requested)
    || requested < 0
  ) {
    return 0
  }
  return portOrExit(
    await resolvePort(
      requested,
      getConfig().server?.portPolicy ?? DEFAULT_PORT_POLICY,
    ),
  )
}

/**
 * The port actually bound.
 *
 * With `--port 0` the caller asked for an ephemeral port, so `options.port` is
 * `0` and useless — the real one is only knowable after the bind. A supervisor
 * that trusted the requested port would try to connect to port 0 and get
 * EADDRNOTAVAIL, which is the exact failure the ready-line exists to prevent.
 */
function boundPort(httpServer: ReturnType<ServeFn>, requested: number): number {
  const url = (httpServer as { url?: string }).url
  if (!url) return requested
  const parsed = Number(new URL(url).port)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : requested
}

/**
 * Post-bind finalization — order is load-bearing: record the PID, re-apply the
 * Claude Code base URL (self-heals a URL a prior crash stranded over a dead
 * proxy; ownership-guarded, no-op when routing is off), then drop the
 * "session running" sentinel ONLY after that URL is in place (a
 * present-on-next-boot sentinel means the last exit was ungraceful — see the
 * `staleSession` check), then install the shutdown handlers.
 */
interface FinalizeBootArgs {
  proxyServer: ReturnType<ServeFn>
  proxyRequested: number
  controlServer: ReturnType<ServeFn>
  controlRequested: number
}

function finalizeBoot({
  proxyServer,
  proxyRequested,
  controlServer,
  controlRequested,
}: FinalizeBootArgs): void {
  // Re-record both bound ports now that they are knowable: under `--port 0` the
  // pre-bind value was 0, which would make the Origin guard compare every
  // localhost origin against the wrong port and reject the UI. The control port
  // is *always* ephemeral under a supervisor, so this is not an edge case there.
  const proxyPort = boundPort(proxyServer, proxyRequested)
  const controlPort = boundPort(controlServer, controlRequested)
  state.proxyPort = proxyPort
  state.controlPort = controlPort

  // Emitted here, after both binds and never before: a supervisor treats this
  // line as "connectable now" and would otherwise race a socket that is not
  // listening yet.
  emitReadyLine({
    v: READY_LINE_VERSION,
    controlPort,
    proxyPort,
    pid: process.pid,
  })

  // After the binds, not before: the control port is ephemeral by default, so a
  // banner printed earlier could only have shown 0 — and this banner is the one
  // place a CLI user can discover it.
  printReadyBanner(proxyPort, controlPort)

  void writePidfile()
  reconcileClaudeCodeOnBoot()
  markSessionRunning()
  startTokenUsageRetention()
  installShutdownHandlers(proxyServer, controlServer)
}
