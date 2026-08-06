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

import { createReporter, probeIdentity, startSidecar, tcpAccepts } from "./harness/sidecar"

const report = createReporter("e2e:seam — control plane over a real sidecar")
const sidecar = await startSidecar()
// Connect before anything else is awaited: the subject is what is true at the
// instant the ready-line arrives, and any work in between would give a late
// listener time to catch up.
const listeners = [
  ["proxy", sidecar.proxyPort],
  ["control", sidecar.port],
] as const
const accepting = await Promise.all(
  listeners.map(async ([label, port]) => ({
    label,
    port,
    ...(await tcpAccepts(port)),
  })),
)

try {
  report.check(
    "ready-line",
    sidecar.port > 0 && sidecar.pid > 0,
    `port=${sidecar.port} (0 requested → ephemeral) pid=${sidecar.pid}`,
  )

  // The ready-line is a published contract: the shell and stuffbucket/maximal
  // connect the instant they read one. So assert the sockets are accepting
  // *now* — a line emitted between the bind and the listen would make every
  // consumer race it, and through `fetch` that is indistinguishable from a busy
  // process. A bare connect tells the two apart.
  report.check(
    "accepting",
    accepting.every((a) => a.accepted),
    accepting
      .map((a) => `${a.label} :${a.port} ${a.observed} in ${a.elapsedMs}ms`)
      .join(", "),
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
  const distinct =
    sidecar.port !== sidecar.proxyPort
    && sidecar.port > 0
    && sidecar.proxyPort > 0
  report.check(
    "two listeners",
    distinct,
    distinct ?
      `control=${sidecar.port} proxy=${sidecar.proxyPort} (distinct)`
    : `control=${sidecar.port} proxy=${sidecar.proxyPort} — not two usable, separate listeners`,
  )

  const v1OnControl = await fetch(`${sidecar.baseUrl}/v1/models`)
  report.check(
    "no /v1 on control",
    v1OnControl.status === 404,
    v1OnControl.status === 404 ?
      "404 — the data plane is not mounted on the private port"
    : `/v1/models answered ${v1OnControl.status} on the control port — the data plane is mounted there`,
  )

  const rpcOnProxy = await fetch(`${sidecar.proxyUrl}/control/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health" }),
  })
  report.check(
    "no control on proxy",
    rpcOnProxy.status === 404,
    rpcOnProxy.status === 404 ?
      "404 — the control plane is not on the well-known port"
    : `/control/rpc answered ${rpcOnProxy.status} on the public port — the control plane is exposed there`,
  )

  const identity = await probeIdentity(sidecar.proxyPort)
  report.check(
    "identity probe",
    identity.body === "Server running",
    identity.body === "Server running" ?
      "the public port answers the probe `resolvePort` uses to spot another maximal"
    : `the public port answered ${identity.observed} — \`resolvePort\` would not recognise this as a maximal`,
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
    `${JSON.stringify(discovered.identity.name)} v${discovered.protocolVersion} ${discovered.capabilities.methods.length} methods`,
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
      if (method === "subscriptions/listen") return { method, ok: true }
      const body = (await res.json()) as { error?: { code?: number } }
      return { method, ok: body.error?.code !== -32601 }
    }),
  )
  const missing = dispatches.filter((d) => !d.ok).map((d) => d.method)
  report.check(
    "advertised",
    missing.length === 0,
    missing.length === 0 ?
      `${dispatches.length}/${dispatches.length} advertised methods actually dispatch`
    : `${missing.length}/${dispatches.length} advertised but not dispatchable (-32601): ${missing.join(", ")}`,
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
  const notifiedBody = await notified.text()
  report.check(
    "notification",
    notified.status === 202 && notifiedBody === "",
    notified.status === 202 && notifiedBody === "" ?
      "202 with an empty body"
    : `${notified.status} with ${notifiedBody === "" ? "an empty body" : JSON.stringify(notifiedBody)} — a host firing a notification would wait on a reply`,
  )

  report.check(
    "alive",
    sidecar.child.exitCode === null,
    sidecar.child.exitCode === null ?
      "sidecar survived the exchange (no EPIPE)"
    : `sidecar exited code=${sidecar.child.exitCode} during the exchange`,
  )
} finally {
  sidecar.child.kill("SIGTERM")
}

report.finish()
