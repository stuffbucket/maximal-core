/**
 * Per-boot startup logger + user-facing "ready" banner.
 *
 * The boot logger writes to `~/.local/share/maximal/logs/startup-<date>.log`
 * via the same handler-logger machinery as `/v1/messages`. The first write
 * creates the logs directory so "Reveal logs in Finder" lands somewhere
 * even on first boot, and the per-restart record gives operators an audit
 * trail stdout alone can't answer.
 *
 * The banner is a one-shot human-facing summary printed at "about to bind"
 * time — lists the URL surfaces and hints at the faster `app:ui` HMR loop
 * for HTML/CSS/TS work.
 */

import consola from "consola"

import { createHandlerLogger } from "~/lib/platform/logger"
import { shortSha, type GitVersion } from "~/lib/update/version"

interface BootLoggerOptions {
  port: number
  accountType: string
}

export function initBootLogger(
  git: GitVersion,
  options: BootLoggerOptions,
): ReturnType<typeof createHandlerLogger> {
  const logger = createHandlerLogger("startup")
  logger.info(
    `maximal start pid=${process.pid} `
      + `version=${git.sha ? shortSha(git.sha) : "unknown"} `
      + `branch=${git.branch || "unknown"} port=${options.port} `
      + `account=${options.accountType}`,
  )
  return logger
}

export function printReadyBanner(proxyPort: number, controlPort: number): void {
  const proxyUrl = `http://localhost:${proxyPort}`
  const controlUrl = `http://127.0.0.1:${controlPort}`
  consola.box(
    [
      `Proxy:   ${proxyUrl}/v1`,
      `Status:  ${proxyUrl}/status`,
      `Control: ${controlUrl}/control/rpc`,
      ``,
      `Core is headless — point a client at the proxy, or drive it over`,
      `the control plane. The control port is separate and loopback-only`,
      `(maximal-core#10); it is ephemeral unless you pass --control-port,`,
      `so this line is the only place a CLI user can read it.`,
    ].join("\n"),
  )
}
