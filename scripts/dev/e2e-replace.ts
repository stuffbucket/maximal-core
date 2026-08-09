/**
 * Harness: `--replace` takes a port from another maximal, and from nothing else.
 *
 * **A harness, not a test head and not a product surface.** Run it with
 * `bun run e2e:replace`.
 *
 * Why this exists: eviction is the one place maximal deliberately terminates
 * another running process. Everything about it is cross-process by
 * construction — one engine POSTs to a second engine's socket and then waits
 * for a third thing, the OS, to release the port — so the unit suite can only
 * ever test the pieces with the process boundary stubbed out. Until this file
 * existed, `bun run e2e` did not mention `--replace` at all, and the last change
 * to the eviction path (#42, which removed a credential from the shutdown POST)
 * was verified by driving a takeover by hand.
 *
 * The path, as the code actually runs it:
 *
 *   runServer --replace -> maybeEvictRunning -> evictRunning
 *     -> requestShutdown: GET /setup-status, then POST /_internal/shutdown
 *     -> poll the port until the connect is refused
 *     -> [if still held] pidfile -> SIGTERM -> SIGKILL, then the lsof'd
 *        listener pid, guarded by `looksLikeMaximalCommand`
 *   ...and only then the ordinary resolvePort/bind.
 *
 * Note the order, because it is easy to read the wrong story off `port.ts`:
 * the **flag** evicts *before* any probe. `probePort`'s `"Server running"`
 * identity gate is what protects a foreign occupant under the
 * `portPolicy: "replace"` *config*, and it is not consulted on the `--replace`
 * path at all. What protects a foreign occupant there is the sum of three
 * things — a shutdown POST it does not implement, a pidfile that is not its,
 * and the `ps` command-line guard on the lsof branch. The "foreign occupant"
 * block below is aimed at that sum, which is why it asserts on the occupant
 * still being *alive and bound* rather than on any decision inside the evictor.
 *
 * ## Portability
 *
 * No POSIX assumption, and nothing gated. Every process here is spawned as
 * `process.execPath` (the Bun already running this file) or the engine under
 * test; the eviction itself is an HTTP POST and a TCP poll, which behave the
 * same on both platforms.
 *
 * Two things read as POSIX-only and are not. `evictRunning`'s escalation branch
 * is Unix-shaped (`lsof`, `ps`) and `defaultListenerPid` returns null outright
 * on win32 — but that branch is the *fallback*, and the checks below assert on
 * the graceful path plus the outcome of the fallback, never on the mechanism
 * inside it. And the graceful exit is `process.exit(0)` from the engine's own
 * `/_internal/shutdown` handler, i.e. userspace, so unlike SIGTERM in
 * `e2e:lifecycle` it really is exercised on Windows.
 *
 * Ports are ephemeral throughout: the incumbent binds `--port 0` and this
 * harness reads the bound port off the ready-line, occupants bind port 0 and
 * announce it. Nothing here hardcodes a port (maximal-core#34).
 *
 * The "without the flag" block additionally carries the concurrency acceptance
 * for maximal-core#2: two engines with distinct `COPILOT_API_HOME`s and
 * ephemeral ports run at the same time, one is stopped, and the other is asked
 * again. Coexistence alone was never the property worth having — a pidfile,
 * token store or sqlite handle keyed OUTSIDE the home only shows itself when
 * one of the two goes away.
 *
 * Not part of `bun test`: six real boots and a drain poll, several seconds each.
 */
import type { ChildProcess } from "node:child_process"

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Occupant } from "./harness/occupant"

import { startOccupant } from "./harness/occupant"
import {
  awaitIdentity,
  collectLines,
  createReporter,
  spawnEngine,
  startSidecar,
  waitForExit,
  waitForLine,
} from "./harness/sidecar"

/** The body `probePort` keys off to tell another maximal from a stranger. */
const MAXIMAL_IDENTITY = "Server running"
/** Anything but the above. A foreign HTTP service on the port maximal wants. */
const FOREIGN_IDENTITY = "not maximal"

/** The incumbent should be gone the moment the successor is up — this only
 *  bounds a successor that bound the port while the incumbent somehow lived. */
const EVICT_MS = 5000
/** A refusal is fast (a 3s drain poll, then the escalation branch), but give it
 *  room on a loaded runner before calling a clean exit-1 a hang. */
const REFUSAL_MS = 30_000
/** The engine logs its shutdown reason as it drains; the exit races the flush. */
const LOG_FLUSH_MS = 3000
/** Budget for an ordinary SIGTERM drain, matching `e2e:lifecycle`'s. Longer
 *  than `EVICT_MS`, which bounds an eviction that has already happened. */
const SIGTERM_GRACE_MS = 10_000

/** A key no other check could produce by accident, so finding it on the wire is
 *  unambiguous. CLI-safe charset, per `API_KEY_VALUE_PATTERN`. */
const SENTINEL_KEY = "e2e-replace-sentinel-key-do-not-send"
/** Header names that would carry it. Compared case-insensitively; `Headers`
 *  lowercases on the way in, but the occupant reports whatever it was given. */
const CREDENTIAL_HEADERS = ["x-api-key", "authorization", "proxy-authorization"]

const spawned: Array<ChildProcess> = []
/** Last-resort cleanup. Registered on `exit` rather than done only in a
 *  `finally` so a throw, or `report.finish()`'s `process.exit`, still reaps
 *  every child — an orphaned engine holds a port and keeps refreshing tokens. */
process.on("exit", () => {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
    }
  }
})

function track<T extends { child: ChildProcess }>(thing: T): T {
  spawned.push(thing.child)
  return thing
}

/** A temp `COPILOT_API_HOME` with `config.json` already written. Config is read
 *  during boot, so seeding it afterwards would be too late. */
function homeWithConfig(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "maximal-e2e-replace-"))
  writeFileSync(join(home, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  })
  return home
}

const report = createReporter(
  "e2e:replace — a takeover evicts another maximal, and nothing else",
)

// ── The takeover ───────────────────────────────────────────────────────────
// Two real engines. The successor is told to take the port the incumbent is
// already serving on, and the incumbent has to be gone by its own hand.
{
  const incumbent = track(await startSidecar())
  const port = incumbent.proxyPort
  // Bounded retry rather than one shot: this is the first HTTP request the
  // harness makes, and on a cold Windows runner that round-trip has taken
  // longer than a single attempt allows. `observed` names every attempt that
  // missed, so a slow answer is reported rather than silently absorbed.
  const identity = await awaitIdentity(port, MAXIMAL_IDENTITY)
  report.check(
    "incumbent",
    identity.body === MAXIMAL_IDENTITY,
    identity.body === MAXIMAL_IDENTITY ?
      `pid=${incumbent.pid} holds :${port} and answered — ${identity.observed}`
    : `pid=${incumbent.pid} announced :${port} but the identity probe never got ${JSON.stringify(MAXIMAL_IDENTITY)} in ${identity.elapsedMs}ms over ${identity.attempts} attempt(s): ${identity.observed}`,
  )

  const successor = track(
    await startSidecar({ proxyPort: port, replace: true }),
  )
  report.check(
    "took over",
    successor.proxyPort === port,
    successor.proxyPort === port ?
      `pid=${successor.pid} bound :${port} — the port it was told to take`
    : `asked for :${port} but settled for :${successor.proxyPort} — it fell back instead of evicting`,
  )

  const exit = await waitForExit(incumbent.child, EVICT_MS)
  report.check(
    "evicted",
    exit !== null,
    exit ?
      `incumbent exited code=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`
    : `incumbent SURVIVED the takeover — two engines now believe they own :${port}`,
  )

  // Exiting is not enough, and neither is exit code 0: the SIGTERM path drains
  // through `initiateShutdown` and also exits 0. The endpoint's own log line is
  // the only thing that separates "asked politely and complied" from "was
  // signalled" — which is the entire difference between eviction and a kill.
  const drained = await waitForLine(
    incumbent.logLines,
    (line) => line.includes("/_internal/shutdown"),
    LOG_FLUSH_MS,
  )
  report.check(
    "graceful",
    drained !== null && exit?.code === 0 && exit.signal === null,
    drained !== null && exit?.code === 0 ?
      drained.trim()
    : `exited code=${exit?.code ?? "null"} signal=${exit?.signal ?? "none"} without reaching its shutdown endpoint — it was killed, not evicted`,
  )
  const signalled = incumbent.logLines.some((line) =>
    line.includes("received SIGTERM"),
  )
  report.check(
    "not signalled",
    !signalled,
    signalled ?
      "the escalation branch fired — the graceful POST did not free the port in time"
    : "the escalation branch never fired: no SIGTERM was sent",
  )

  const served = await awaitIdentity(port, MAXIMAL_IDENTITY)
  const successorAlive = successor.child.exitCode === null
  report.check(
    "serving",
    served.body === MAXIMAL_IDENTITY && successorAlive,
    served.body === MAXIMAL_IDENTITY && successorAlive ?
      `:${port} — ${served.observed} — and it can only be the successor`
    : `:${port} — ${served.observed}; successor is ${successorAlive ? "running" : `code=${successor.child.exitCode}`}`,
  )

  successor.child.kill("SIGTERM")
}

// ── Without the flag, nothing is evicted ───────────────────────────────────
// The property that keeps a dev instance from taking a production one's port.
// A regression here is silent: the second engine still starts, just on top of
// the first one's corpse.
//
// This block doubles as the concurrency acceptance for maximal-core#2: two
// engines, two DISTINCT `COPILOT_API_HOME`s, ephemeral ports, running at the
// same time — and then one of them is stopped and the other is asked again.
// The homes are passed explicitly rather than left to `spawnEngine`'s default
// temp dir, so "distinct" is a property this harness asserts rather than one it
// inherits from a helper that could change.
{
  const homeA = mkdtempSync(join(tmpdir(), "maximal-e2e-home-a-"))
  const homeB = mkdtempSync(join(tmpdir(), "maximal-e2e-home-b-"))

  const incumbent = track(await startSidecar({ home: homeA }))
  const port = incumbent.proxyPort

  const successor = track(
    await startSidecar({ proxyPort: port, home: homeB }),
  )
  report.check(
    "deferred",
    successor.proxyPort !== port && successor.proxyPort > 0,
    successor.proxyPort === port ?
      `bound :${port} WITHOUT --replace — the flag is not what gates eviction`
    : `asked for :${port}, took :${successor.proxyPort} instead (portPolicy "next")`,
  )

  const stillThere = await awaitIdentity(port, MAXIMAL_IDENTITY)
  report.check(
    "incumbent alive",
    incumbent.child.exitCode === null && stillThere.body === MAXIMAL_IDENTITY,
    incumbent.child.exitCode === null ?
      `pid=${incumbent.pid} still serving :${port} — ${stillThere.observed}`
    : `incumbent exited code=${incumbent.child.exitCode} — an unflagged start evicted it`,
  )

  // The strongest form of "did not evict": it was never even asked. A successor
  // that POSTed and was refused would satisfy the two checks above.
  const asked = incumbent.logLines.some((line) =>
    line.includes("/_internal/shutdown"),
  )
  report.check(
    "not asked",
    !asked,
    asked ?
      "the incumbent received a shutdown request it never should have seen"
    : "no shutdown request reached the incumbent",
  )

  // Both engines are up right now. Each one should have seeded ITS OWN home and
  // nothing in the other's — the mechanical form of "all state is confined
  // under the home it was given".
  const wrote = (home: string): Array<string> =>
    readdirSync(home).filter((entry) => entry !== ".DS_Store")
  const [wroteA, wroteB] = [wrote(homeA), wrote(homeB)]
  const isolated =
    homeA !== homeB
    && wroteA.includes("config.json")
    && wroteB.includes("config.json")
  report.check(
    "isolated homes",
    isolated,
    isolated ?
      `each engine seeded only its own home — ${homeA} has [${wroteA.sort().join(" ")}], ${homeB} has [${wroteB.sort().join(" ")}]`
    : `homes did not come out independent — ${homeA} has [${wroteA.sort().join(" ")}], ${homeB} has [${wroteB.sort().join(" ")}]`,
  )

  // Stopping one must not disturb the other. This is the assertion the block
  // was missing: it proved two engines could COEXIST, never that either one
  // survives the other's exit. A shared pidfile, token store or sqlite handle
  // outside the home would surface exactly here and nowhere else.
  successor.child.kill("SIGTERM")
  const successorExit = await waitForExit(successor.child, SIGTERM_GRACE_MS)
  report.check(
    "one stopped",
    successorExit !== null,
    successorExit ?
      `successor on :${successor.proxyPort} exited code=${successorExit.code ?? "null"} signal=${successorExit.signal ?? "none"}`
    : `successor on :${successor.proxyPort} ignored SIGTERM within ${SIGTERM_GRACE_MS}ms — the survivor check below would prove nothing`,
  )

  const survivor = await awaitIdentity(port, MAXIMAL_IDENTITY)
  const survivorAlive =
    incumbent.child.exitCode === null && incumbent.child.signalCode === null
  report.check(
    "other healthy",
    survivorAlive && survivor.body === MAXIMAL_IDENTITY,
    survivorAlive && survivor.body === MAXIMAL_IDENTITY ?
      `pid=${incumbent.pid} still answers on :${port} after the other instance was stopped — ${survivor.observed}`
    : `pid=${incumbent.pid} is code=${incumbent.child.exitCode ?? "null"} signal=${incumbent.child.signalCode ?? "none"} on :${port} — ${survivor.observed}; stopping the OTHER instance took it down with it`,
  )

  incumbent.child.kill("SIGTERM")
}

// ── A foreign occupant is never evicted ────────────────────────────────────
// The worst failure mode in the whole path: killing an unrelated process
// because it happened to hold the port. Failing to start is the correct
// outcome here; taking the port would not be.
{
  const foreign: Occupant = track(
    await startOccupant({ identity: FOREIGN_IDENTITY, obeys: false }),
  )
  const held = await awaitIdentity(foreign.port, FOREIGN_IDENTITY)
  report.check(
    "foreign occupant",
    held.body === FOREIGN_IDENTITY,
    held.body === FOREIGN_IDENTITY ?
      `pid=${foreign.child.pid} holds :${foreign.port} and answers ${JSON.stringify(held.body)}, not ${JSON.stringify(MAXIMAL_IDENTITY)}`
    : `pid=${foreign.child.pid} on :${foreign.port} — ${held.observed}; the guard below would be aimed at the wrong occupant`,
  )

  // `spawnEngine` rather than `startSidecar`: this boot is supposed to fail, so
  // there is no ready-line to await and a timeout would be the only thing
  // `startSidecar` could report.
  const child = spawnEngine({ proxyPort: foreign.port, replace: true })
  spawned.push(child)
  const lines = collectLines(child)
  const exit = await waitForExit(child, REFUSAL_MS)
  report.check(
    "refused",
    exit !== null && exit.code !== 0,
    exit === null ?
      `still alive after ${REFUSAL_MS}ms — it did not give up the port to its rightful holder`
    : `exited code=${exit.code ?? "null"}: ${
        lines.find((l) => l.includes("Could not free"))?.trim()
        ?? "no explanation on stderr"
      }`,
  )

  const survived = await awaitIdentity(foreign.port, FOREIGN_IDENTITY)
  report.check(
    "left alone",
    foreign.child.exitCode === null
      && foreign.child.signalCode === null
      && survived.body === FOREIGN_IDENTITY,
    survived.body === FOREIGN_IDENTITY ?
      `still bound and still answering (it was ${foreign.shutdownHeaders() ? "asked to shut down and 404'd it" : "never asked"}, and never signalled)`
    : `pid=${foreign.child.pid} is code=${foreign.child.exitCode ?? "null"} signal=${foreign.child.signalCode ?? "none"} — ${survived.observed}`,
  )

  foreign.kill()
}

// ── The eviction request carries no credential ─────────────────────────────
// `/_internal/shutdown` is loopback-gated, never key-gated (#42). Attaching the
// operator's inbound key was inert on the receiving side and handed it to an
// unauthenticated local peer on the sending side — and the peer is
// unauthenticated by construction, since anything can serve "Server running".
// So the occupant here impersonates maximal and reports what it was sent.
{
  const impostor: Occupant = track(
    await startOccupant({ identity: MAXIMAL_IDENTITY, obeys: true }),
  )
  const home = homeWithConfig({
    auth: { apiKeys: [SENTINEL_KEY], enforce: true },
  })
  const successor = track(
    await startSidecar({ proxyPort: impostor.port, replace: true, home }),
  )
  report.check(
    "impostor",
    successor.proxyPort === impostor.port,
    successor.proxyPort === impostor.port ?
      `served ${JSON.stringify(MAXIMAL_IDENTITY)} on :${impostor.port}, obeyed the POST, and the successor took the port`
    : `the successor settled for :${successor.proxyPort} rather than the impostor's :${impostor.port} — no shutdown POST was sent, so there is nothing to observe below`,
  )

  // Non-vacuity. "No key on the wire" proves nothing if the engine had no key
  // to send, so make it demonstrate that it loaded this one: with
  // `auth.enforce`, an unknown path 401s without a key and 404s with it.
  const probe = async (headers: Record<string, string>): Promise<number> =>
    (await fetch(`${successor.proxyUrl}/_e2e-auth-probe`, { headers })).status
  const without = await probe({})
  const withKey = await probe({ "x-api-key": SENTINEL_KEY })
  report.check(
    "key loaded",
    without === 401 && withKey !== 401,
    without === 401 && withKey !== 401 ?
      `unknown path: ${without} without the key, ${withKey} with it — the sentinel is live in this engine's config`
    : `unknown path: ${without} without the key, ${withKey} with it — expected 401 then anything else; the sentinel is not gating, so "no credential" below proves nothing`,
  )

  const sent = impostor.shutdownHeaders()
  const offenders = Object.entries(sent ?? {}).filter(
    ([name, value]) =>
      CREDENTIAL_HEADERS.includes(name.toLowerCase())
      || value.includes(SENTINEL_KEY),
  )
  report.check(
    "no credential",
    sent !== null && offenders.length === 0,
    sent === null ?
      "the impostor was never asked to shut down — nothing was observed"
    : offenders.length > 0 ?
      `the shutdown POST leaked ${offenders.map(([n]) => n).join(", ")} to an unauthenticated local peer`
    : `${Object.keys(sent).length} headers, none of them a credential: ${Object.keys(sent).sort().join(" ")}`,
  )

  successor.child.kill("SIGTERM")
  impostor.kill()
}

report.finish()
