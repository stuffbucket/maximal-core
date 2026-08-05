/**
 * Harness: the request/response seam, against a real spawned sidecar.
 *
 * **A harness, not a test head and not a product surface.** Run it with
 * `bun run e2e:seam`.
 *
 * It earns its place because it is the only thing that exercises what a host
 * (stuffbucket/maximal#408) actually does, and it has already caught two bugs
 * that every unit test passed straight through:
 *
 *   1. The ready-line reported the *requested* port, so `--port 0` announced
 *      port 0 and a supervisor got EADDRNOTAVAIL — the exact failure the
 *      ready-line exists to prevent.
 *   2. `awaitReadyLine` consumed stdout with `for await`, whose exit calls
 *      `iterator.return()` and destroys the stream — killing the sidecar with
 *      EPIPE on its next log line.
 *
 * The live feed is covered by its sibling, `e2e:feed`; process lifecycle by
 * `e2e:lifecycle`.
 */
import { ControlClient, ControlRpcError } from "~/lib/live/client"

import { createReporter, startSidecar } from "./harness/sidecar"

const report = createReporter("e2e:seam — control plane over a real sidecar")
const sidecar = await startSidecar()

try {
  report.check(
    "ready-line",
    sidecar.port > 0 && sidecar.pid > 0,
    `port=${sidecar.port} (0 requested → ephemeral) pid=${sidecar.pid}`,
  )
  report.check(
    "boot lines",
    sidecar.bootLines.length > 0,
    `${sidecar.bootLines.length} relayed`,
  )

  // ── Two listeners, actually separated (maximal-core#10) ──────────────────
  // The whole point of the split is that the sensitive surface is not on the
  // port third-party tools call. Asserting the two ports differ is not enough —
  // check that each app really refuses the other's routes, because a mounting
  // mistake would leave both reachable on both and nobody would notice.
  report.check(
    "two listeners",
    sidecar.port !== sidecar.proxyPort
      && sidecar.port > 0
      && sidecar.proxyPort > 0,
    `control=${sidecar.port} proxy=${sidecar.proxyPort} (distinct)`,
  )

  const v1OnControl = await fetch(`${sidecar.baseUrl}/v1/models`)
  report.check(
    "no /v1 on control",
    v1OnControl.status === 404,
    `${v1OnControl.status} — the data plane is not mounted on the private port`,
  )

  const rpcOnProxy = await fetch(`${sidecar.proxyUrl}/control/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health" }),
  })
  report.check(
    "no control on proxy",
    rpcOnProxy.status === 404,
    `${rpcOnProxy.status} — the control plane is not on the well-known port`,
  )

  const identity = await fetch(`${sidecar.proxyUrl}/`)
  report.check(
    "identity probe",
    (await identity.text()).trim() === "Server running",
    "the public port answers the probe `resolvePort` uses to spot another maximal",
  )

  const client = new ControlClient({ baseUrl: sidecar.baseUrl })

  const discovered = await client.call<{
    protocolVersion: string
    capabilities: { methods: Array<string> }
    identity: { name: string }
  }>("server/discover")
  report.check(
    "discover",
    discovered.identity.name === "maximal-core"
      && discovered.capabilities.methods.length > 0,
    `v${discovered.protocolVersion} ${discovered.capabilities.methods.length} methods`,
  )

  // Discovery must not under-report: a host builds its callable surface from
  // this list, so a method that dispatches but is not advertised is invisible.
  const dispatches = await Promise.all(
    discovered.capabilities.methods.map(async (method) => {
      const res = await fetch(`${sidecar.baseUrl}/control/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
      })
      // Any answer but "method not found" means it is really wired up.
      if (method === "subscriptions/listen") return true
      const body = (await res.json()) as { error?: { code?: number } }
      return body.error?.code !== -32601
    }),
  )
  report.check(
    "advertised",
    dispatches.every(Boolean),
    `${dispatches.filter(Boolean).length}/${dispatches.length} advertised methods actually dispatch`,
  )

  const health = await client.call<{ ok: boolean }>("health")
  report.check("health", health.ok, JSON.stringify(health))

  const auth = await client.call<{ state: string }>("auth/status")
  report.check("auth/status", typeof auth.state === "string", `state=${auth.state}`)

  let rpcError: ControlRpcError | null = null
  try {
    await client.call("nope/missing")
  } catch (error) {
    rpcError = error as ControlRpcError
  }
  report.check(
    "unknown",
    rpcError?.code === -32601,
    `code=${rpcError?.code ?? "none"} (a JSON-RPC error, not a crash)`,
  )

  // A notification has no id and expects no body — a host that fires one must
  // not sit waiting for a response that is never coming.
  const notified = await fetch(`${sidecar.baseUrl}/control/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "health" }),
  })
  report.check(
    "notification",
    notified.status === 202 && (await notified.text()) === "",
    `${notified.status} with an empty body`,
  )

  report.check(
    "alive",
    sidecar.child.exitCode === null,
    "sidecar survived the exchange (no EPIPE)",
  )
} finally {
  sidecar.child.kill("SIGTERM")
}

report.finish()
