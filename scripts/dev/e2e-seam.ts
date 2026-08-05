/**
 * End-to-end seam check: spawn the real sidecar, drive the real control plane.
 *
 * Not part of `bun test` — it spawns a process, binds a socket, and takes a few
 * seconds, so it is a deliberate `bun run e2e:seam` rather than a gate on every
 * run. It earns its place because it is the only thing that exercises what a
 * host (stuffbucket/maximal#408) actually does, and it has already caught two
 * bugs that every unit test passed straight through:
 *
 *   1. The ready-line reported the *requested* port, so `--port 0` announced
 *      port 0 and a supervisor got EADDRNOTAVAIL — the exact failure the
 *      ready-line exists to prevent.
 *   2. `awaitReadyLine` consumed stdout with `for await`, whose exit calls
 *      `iterator.return()` and destroys the stream — killing the sidecar with
 *      EPIPE on its next log line.
 */
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ControlClient, ControlRpcError } from "~/lib/live/client"
import { awaitReadyLine, sidecarSpawnEnv } from "~/lib/live/supervisor"

const home = mkdtempSync(join(tmpdir(), "maximal-e2e-"))

const child = spawn("bun", ["src/main.ts", "start", "--port", "0"], {
  cwd: process.cwd(),
  // An isolated home so the check never reads or writes the developer's real
  // config, and `--port 0` so it can never collide with a running instance.
  env: { ...process.env, ...sidecarSpawnEnv(), COPILOT_API_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
})

let failed = false
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failed = true
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(12)} ${detail}`)
}

try {
  const bootLines: Array<string> = []
  const ready = await awaitReadyLine(child.stdout, {
    timeoutMs: 30_000,
    onLine: (line) => bootLines.push(line),
  })
  // The host owns stdout from here: stop draining and the pipe buffer fills,
  // blocking the child on its next write.
  child.stdout.resume()
  child.stderr.resume()

  check(
    "ready-line",
    ready.port > 0 && ready.pid > 0,
    `port=${ready.port} (0 requested → ephemeral) pid=${ready.pid}`,
  )
  check("boot lines", bootLines.length > 0, `${bootLines.length} relayed`)

  const client = new ControlClient({
    baseUrl: `http://127.0.0.1:${ready.port}`,
  })

  const discovered = await client.call<{
    protocolVersion: string
    capabilities: { methods: Array<string> }
    identity: { name: string }
  }>("server/discover")
  check(
    "discover",
    discovered.identity.name === "maximal-core"
      && discovered.capabilities.methods.length > 0,
    `v${discovered.protocolVersion} ${discovered.capabilities.methods.length} methods`,
  )

  const health = await client.call<{ ok: boolean }>("health")
  check("health", health.ok, JSON.stringify(health))

  const auth = await client.call<{ state: string }>("auth/status")
  check("auth/status", typeof auth.state === "string", `state=${auth.state}`)

  let rpcError: ControlRpcError | null = null
  try {
    await client.call("nope/missing")
  } catch (error) {
    rpcError = error as ControlRpcError
  }
  check(
    "unknown",
    rpcError?.code === -32601,
    `code=${rpcError?.code ?? "none"} (a JSON-RPC error, not a crash)`,
  )

  check(
    "alive",
    child.exitCode === null,
    "sidecar survived the exchange (no EPIPE)",
  )
} finally {
  child.kill("SIGTERM")
}

process.exit(failed ? 1 : 0)
