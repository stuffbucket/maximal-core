import { describe, expect, test } from "bun:test"

import type { PortPolicy } from "~/lib/config/config"

import { DEFAULT_PORT_POLICY } from "~/lib/config/config"
import { PORT_SCAN_LIMIT, isPortBindable, resolvePort } from "~/lib/start/port"

type Occupant = "free" | "maximal" | "other"

/** Fails the test if called: proves a code path never evicts. */
const refuseToEvict = (): Promise<void> => {
  throw new Error("must not evict a process that is not maximal")
}

/** Claims to have evicted but frees nothing. */
const evictThatDoesNothing = (): Promise<void> => Promise.resolve()

/** Probe backed by a map: any port not named is free. Bindability defaults to
 *  "yes wherever HTTP says free", so tests opt in to the divergence explicitly. */
function probeFrom(
  held: Record<number, Occupant>,
  unbindable: Array<number> = [],
) {
  const seen: Array<number> = []
  const probe = (port: number): Promise<Occupant> => {
    seen.push(port)
    return Promise.resolve(held[port] ?? "free")
  }
  const bindable = (port: number): Promise<boolean> =>
    Promise.resolve(
      !unbindable.includes(port) && (held[port] ?? "free") === "free",
    )
  return { probe, bindable, seen }
}

describe("resolvePort — the default policy", () => {
  test("the default is to move on, not to refuse to start", () => {
    // The whole point of the policy: a second instance starting is far more
    // common than a port being sacred, and failing to launch is the worse
    // outcome. If this default ever flips, it should be a deliberate act.
    expect(DEFAULT_PORT_POLICY).toBe("next")
  })

  test("a free port is used as-is, whatever the policy", async () => {
    for (const policy of ["next", "fail", "replace"] as Array<PortPolicy>) {
      const { probe, bindable } = probeFrom({})
      expect(await resolvePort(4141, policy, { probe, bindable })).toEqual({
        ok: true,
        port: 4141,
      })
    }
  })

  test("port 0 is passed through without probing — the OS is choosing", async () => {
    const { probe, bindable, seen } = probeFrom({ 0: "other" })
    expect(await resolvePort(0, "fail", { probe, bindable })).toEqual({
      ok: true,
      port: 0,
    })
    // Probing port 0 would be meaningless, and treating it as busy would break
    // every supervised sidecar, which always asks for an ephemeral port.
    expect(seen).toEqual([])
  })
})

describe("resolvePort — next", () => {
  test("moves to the following port when the requested one is held", async () => {
    const { probe, bindable } = probeFrom({ 4141: "maximal" })
    expect(await resolvePort(4141, "next", { probe, bindable })).toEqual({
      ok: true,
      port: 4142,
      movedFrom: 4141,
    })
  })

  test("skips a run of busy ports rather than stopping at the first", async () => {
    const { probe, bindable } = probeFrom({
      4141: "maximal",
      4142: "maximal",
      4143: "other",
    })
    expect(await resolvePort(4141, "next", { probe, bindable })).toEqual({
      ok: true,
      port: 4144,
      movedFrom: 4141,
    })
  })

  test("moves regardless of who holds the port", async () => {
    // Unlike `replace`, this never touches the occupant — so a foreign process
    // is just as movable-past as another maximal.
    const { probe, bindable } = probeFrom({ 4141: "other" })
    const result = await resolvePort(4141, "next", { probe, bindable })
    expect(result).toMatchObject({ ok: true, port: 4142 })
  })

  test("gives up after a bounded scan instead of hanging", async () => {
    // An unbounded scan would turn "port busy" into "app hangs at startup",
    // which is a worse failure and a harder one to diagnose.
    const held: Record<number, Occupant> = {}
    for (let p = 4141; p < 4141 + PORT_SCAN_LIMIT + 5; p++) held[p] = "other"
    const { probe, bindable, seen } = probeFrom(held)

    expect(await resolvePort(4141, "next", { probe, bindable })).toEqual({
      ok: false,
      reason: "exhausted",
      from: 4141,
      through: 4141 + PORT_SCAN_LIMIT - 1,
    })
    expect(seen).toHaveLength(PORT_SCAN_LIMIT)
  })

  test("does not scan past the last port that exists", async () => {
    const { probe, bindable, seen } = probeFrom({ 65_535: "other" })
    const result = await resolvePort(65_535, "next", { probe, bindable })
    expect(result).toEqual({
      ok: false,
      reason: "exhausted",
      from: 65_535,
      through: 65_535,
    })
    expect(seen).toEqual([65_535])
  })

  test("skips a port that answers no HTTP but cannot be bound", async () => {
    // Regression, found by running two engines for real. An app holding
    // 127.0.0.1:P is invisible to an HTTP probe that resolves ::1, so the scan
    // picked a port it could only bind on one family — leaving the engine
    // unreachable at 127.0.0.1 for any client that resolves IPv4 first.
    // "Nothing answered HTTP" is not the same question as "I can bind this".
    const { probe, bindable } = probeFrom({ 4141: "maximal" }, [4142])
    expect(await resolvePort(4141, "next", { probe, bindable })).toEqual({
      ok: true,
      port: 4143,
      movedFrom: 4141,
    })
  })

  test("an unbindable requested port is treated as held by a foreign process", async () => {
    // It is not ours, so `replace` must not try to evict it.
    const { probe, bindable } = probeFrom({}, [4141])
    expect(await resolvePort(4141, "fail", { probe, bindable })).toEqual({
      ok: false,
      reason: "busy",
      port: 4141,
      occupant: "other",
    })
  })
})

describe("resolvePort — fail", () => {
  test("reports the occupant rather than moving", async () => {
    const { probe, bindable } = probeFrom({ 4141: "maximal" })
    expect(await resolvePort(4141, "fail", { probe, bindable })).toEqual({
      ok: false,
      reason: "busy",
      port: 4141,
      occupant: "maximal",
    })
  })

  test("distinguishes a foreign process from another maximal", async () => {
    // The two cases get different remediation, so the distinction has to
    // survive as far as the message.
    const { probe, bindable } = probeFrom({ 4141: "other" })
    expect(await resolvePort(4141, "fail", { probe, bindable })).toMatchObject({
      occupant: "other",
    })
  })
})

describe("resolvePort — replace", () => {
  test("evicts a maximal instance and keeps the port", async () => {
    const held: Record<number, Occupant> = { 4141: "maximal" }
    const probe = (port: number): Promise<Occupant> =>
      Promise.resolve(held[port] ?? "free")
    const bindable = (port: number): Promise<boolean> =>
      Promise.resolve((held[port] ?? "free") === "free")
    const evicted: Array<number> = []
    const evict = (port: number): Promise<void> => {
      evicted.push(port)
      // Freed rather than removed: same observable result, and the linter
      // rightly dislikes deleting a computed key.
      held[port] = "free"
      return Promise.resolve()
    }

    expect(
      await resolvePort(4141, "replace", { probe, bindable, evict }),
    ).toEqual({
      ok: true,
      port: 4141,
    })
    expect(evicted).toEqual([4141])
  })

  test("never evicts a foreign process", async () => {
    // Killing something that merely happens to share a port would be a
    // destructive act on a process we know nothing about.
    const { probe, bindable } = probeFrom({ 4141: "other" })

    expect(
      await resolvePort(4141, "replace", {
        probe,
        bindable,
        evict: refuseToEvict,
      }),
    ).toEqual({
      ok: false,
      reason: "busy",
      port: 4141,
      occupant: "other",
    })
  })

  test("reports failure when the port is still held after eviction", async () => {
    const { probe, bindable } = probeFrom({ 4141: "maximal" })

    expect(
      await resolvePort(4141, "replace", {
        probe,
        bindable,
        evict: evictThatDoesNothing,
      }),
    ).toEqual({
      ok: false,
      reason: "evict-failed",
      port: 4141,
    })
  })
})

describe("isPortBindable — against real sockets", () => {
  test("a port nothing holds is bindable, and stays bindable after checking", async () => {
    // The check must not leave its own probe socket behind, or the first call
    // would poison every call after it.
    const port = 45_871
    expect(await isPortBindable(port)).toBe(true)
    expect(await isPortBindable(port)).toBe(true)
  })

  test("a port held on IPv4 loopback only is reported unbindable", async () => {
    // The exact shape of the bug this exists for: another app on 127.0.0.1:P
    // answers no HTTP and is invisible to a probe that resolved ::1.
    const net = await import("node:net")
    const port = 45_872
    const squatter = net.createServer()
    await new Promise<void>((resolve) =>
      squatter.listen(port, "127.0.0.1", resolve),
    )
    try {
      expect(await isPortBindable(port)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
    }
    // Released again once the squatter is gone.
    expect(await isPortBindable(port)).toBe(true)
  })
})
