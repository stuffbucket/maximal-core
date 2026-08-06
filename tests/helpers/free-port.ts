/**
 * Ports for tests, obtained from the OS instead of guessed.
 *
 * **Why this exists.** This project has now been bitten three times by a test
 * naming a port and hoping: the fixed-port flakes fixed in #34, the
 * `4143 + random(100)` / `4243 + random(100)` windows that overlapped at their
 * seams (see `spawn-engine.ts` and `spawned-engine-ports.test.ts`), and
 * `41000 + random(1000)` in `start-run-server.test.ts`, which went red on a CI
 * runner while sibling suites were binding ports concurrently. Every one of
 * them was green in isolation and green on a quiet laptop. A guess is not made
 * safe by widening its range.
 *
 * ─── There are four ways to get a port here, and they are not interchangeable ─
 *
 * They differ in **who owns the socket when the assertion runs**, which is the
 * only property that matters. In descending order of strength:
 *
 * 1. **The code under test binds, and reports what it bound.** `Bun.serve({ port:
 *    0 })` then read `server.port` (`tests/setup-smoke.test.ts`,
 *    `tests/live/control-client.test.ts`). Ownership never leaves the process
 *    and no window exists at all. Nothing here can improve on it — do not route
 *    it through this helper.
 * 2. **A spawned child binds, and publishes what it bound.** `--port 0
 *    --control-port 0` plus the ready-line (`tests/helpers/spawn-engine.ts`).
 *    Same guarantee across a process boundary, via a different observation
 *    channel. Also not this helper's business.
 * 3. **`holdPort` — the test binds and keeps the socket.** For when the test
 *    itself must be the occupant (a squatter proving something is *not*
 *    bindable). The OS assigns the port and this process holds it until
 *    `release()`, so no window exists while the assertion runs.
 * 4. **`pickFreePort` — the test binds, reads the number back, and lets go.**
 *    The weakest form, and deliberately last. Ownership passes to whatever binds
 *    it next, so a TOCTOU window is unavoidable. Use it **only** when the API
 *    under test takes a port *number* and binds it later (`runServer({ port })`),
 *    which is the one case forms 1–3 cannot express.
 *
 * The first two are different observation channels for different runtimes, not
 * duplication, and merging them would buy nothing. Only forms 3 and 4 are
 * shared, because only they are the test's own bookkeeping.
 *
 * `listen(0, <ip literal>)` binds synchronously inside Node — the bind syscall
 * happens in `setupListenHandle`, and only the `listening` *event* is deferred —
 * so `address()` is populated on return. `pickFreePort` relies on that;
 * `holdPort` awaits the callback anyway, because a squatter that is not yet
 * listening would make its caller's assertion silently vacuous.
 */
import { createServer } from "node:net"

export interface HeldPort {
  /** An OS-assigned port, held by this process until `release()`. */
  port: number
  /** Close the socket and wait for it to actually be closed. */
  release: () => Promise<void>
}

/**
 * Bind an OS-assigned port on `host` and keep the socket.
 *
 * The returned port cannot be in use by anything else: the OS just handed it to
 * us and we have not let go. Always `release()` in a `finally`.
 */
export async function holdPort(host = "127.0.0.1"): Promise<HeldPort> {
  const socket = createServer()
  const release = (): Promise<void> =>
    new Promise<void>((resolve) => socket.close(() => resolve()))

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject)
    socket.listen(0, host, resolve)
  })

  const address = socket.address()
  const port = typeof address === "object" && address ? address.port : 0
  if (port === 0) {
    await release()
    throw new Error(`could not obtain an ephemeral port on ${host}`)
  }
  return { port, release }
}

/**
 * A port the OS has just confirmed free, released again before returning.
 *
 * **The weakest of the four forms — see the header before reaching for it.**
 * Closing immediately leaves a window, but a microsecond-wide one against a
 * port nothing else is scanning, rather than a guess inside a range anything
 * may hold. Prefer `holdPort`, `Bun.serve({ port: 0 })`, or `startEngine`
 * whenever the shape of the test allows it.
 */
export function pickFreePort(): number {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  const address = probe.address()
  const port = typeof address === "object" && address ? address.port : 0
  probe.close()
  if (port === 0) throw new Error("could not obtain an ephemeral port")
  return port
}
