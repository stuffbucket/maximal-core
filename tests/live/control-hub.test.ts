import { describe, expect, test } from "bun:test"

import { frameEnvelopeSchema } from "~/lib/live/contract"
import { ControlHub, type ControlSink } from "~/lib/live/hub"

// Let the microtask + macrotask queues drain so every subscriber's drain loop
// has delivered what's in its queue.
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5))

interface ParsedFrame {
  id?: number
  event: string
  data: unknown
}

function parseSse(block: string): ParsedFrame {
  const parsed: { id?: number; event?: string; data?: unknown } = {}
  for (const line of block.trimEnd().split("\n")) {
    const idx = line.indexOf(":")
    const key = line.slice(0, idx)
    const value = line.slice(idx + 1).trim()
    switch (key) {
      case "id": {
        parsed.id = Number(value)
        break
      }
      case "event": {
        parsed.event = value
        break
      }
      case "data": {
        parsed.data = JSON.parse(value)
        break
      }
      default: {
        break
      }
    }
  }
  // Validate against the shared wire contract while we're here.
  frameEnvelopeSchema.parse({
    id: parsed.id,
    event: parsed.event,
    data: parsed.data,
  })
  return parsed as ParsedFrame
}

async function expectRejects(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    expect((error as Error).message).toMatch(pattern)
    return
  }
  throw new Error("expected the promise to reject, but it resolved")
}

class FakeSink implements ControlSink {
  readonly rawFrames: Array<string> = []
  closedReason: string | null = null
  private gate: Promise<void> | null = null
  private release: (() => void) | null = null
  private readonly failOnWrite: boolean

  constructor(failOnWrite = false) {
    this.failOnWrite = failOnWrite
  }

  async write(frame: string): Promise<void> {
    if (this.failOnWrite) throw new Error("peer gone")
    if (this.gate) await this.gate
    this.rawFrames.push(frame)
  }

  close(reason: string): void {
    this.closedReason = reason
  }

  /** Stall writes to simulate a slow/backgrounded client. */
  block(): void {
    this.gate = new Promise((resolve) => {
      this.release = resolve
    })
  }

  unblock(): void {
    this.release?.()
    this.gate = null
    this.release = null
  }

  get frames(): Array<ParsedFrame> {
    return this.rawFrames.map((raw) => parseSse(raw))
  }
}

const snapshotBuilder =
  (value: unknown = { ok: true }) =>
  (): Promise<unknown> =>
    Promise.resolve(value)

describe("ControlHub — connect + fan-out", () => {
  test("every subscriber gets snapshot-first, then deltas in monotonic order", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder({ v: 0 }) })
    const sinks = [new FakeSink(), new FakeSink(), new FakeSink()]
    await Promise.all(sinks.map((s) => hub.subscribe(s)))

    // A burst of deltas while all three are connected.
    for (let i = 0; i < 5; i++) hub.emit("auth", { n: i })
    await settle()

    for (const sink of sinks) {
      const frames = sink.frames
      expect(frames[0].event).toBe("snapshot")
      expect(frames[0].id).toBe(0)
      const deltas = frames.slice(1)
      expect(deltas.map((f) => f.event)).toEqual([
        "auth",
        "auth",
        "auth",
        "auth",
        "auth",
      ])
      // Strictly increasing cursors, no gaps, no interleave.
      expect(deltas.map((f) => f.id)).toEqual([1, 2, 3, 4, 5])
    }
    expect(hub.stats.subscribers).toBe(3)
  })

  test("the same delta is serialized once and shared across subscribers", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const a = new FakeSink()
    const b = new FakeSink()
    await hub.subscribe(a)
    await hub.subscribe(b)
    hub.emit("config", { theme: "dark" })
    await settle()
    // Byte-identical frame string for the same event.
    const aDelta = a.rawFrames.at(-1)
    const bDelta = b.rawFrames.at(-1)
    expect(aDelta).toBe(bDelta)
  })
})

describe("ControlHub — resume", () => {
  test("in-window Last-Event-ID replays exactly the gap, no snapshot", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const a = new FakeSink()
    await hub.subscribe(a)
    hub.emit("auth", { n: 1 })
    hub.emit("auth", { n: 2 })
    hub.emit("auth", { n: 3 })
    await settle()

    const resumed = new FakeSink()
    await hub.subscribe(resumed, {
      lastEventId: 1,
      epoch: hub.stats.epoch,
    })
    await settle()

    const frames = resumed.frames
    expect(frames.map((f) => f.event)).toEqual(["auth", "auth"])
    expect(frames.map((f) => f.id)).toEqual([2, 3])
    // A subsequent live delta continues the sequence.
    hub.emit("auth", { n: 4 })
    await settle()
    expect(resumed.frames.at(-1)?.id).toBe(4)
  })

  test.each([
    ["evicted cursor (past the ring)", { lastEventId: 1 }],
    ["future cursor", { lastEventId: 999 }],
    ["non-numeric cursor", { lastEventId: "not-a-number" }],
  ])("forces a re-snapshot on %s", async (_label, resume) => {
    // Ring holds only the last 2 deltas.
    const hub = new ControlHub({
      buildSnapshot: snapshotBuilder(),
      ringCapacity: 2,
    })
    const warm = new FakeSink()
    await hub.subscribe(warm)
    for (let i = 1; i <= 5; i++) hub.emit("auth", { n: i })
    await settle()

    const sink = new FakeSink()
    await hub.subscribe(sink, { ...resume, epoch: hub.stats.epoch })
    await settle()
    expect(sink.frames[0].event).toBe("snapshot")
  })

  test("epoch mismatch forces a re-snapshot", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const warm = new FakeSink()
    await hub.subscribe(warm)
    hub.emit("auth", { n: 1 })
    await settle()

    const sink = new FakeSink()
    await hub.subscribe(sink, { lastEventId: 0, epoch: "stale-epoch" })
    await settle()
    expect(sink.frames[0].event).toBe("snapshot")
  })
})

describe("ControlHub — idempotent upserts + edge-only frames", () => {
  test("edge-only frames carry no id and are never replayed", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const live = new FakeSink()
    await hub.subscribe(live)

    hub.emit("auth", { state: "authenticated" }) // cursor 1, ringed
    hub.emitEdge("auth", { notify_on_reconnect: true }) // edge, no cursor
    await settle()

    const liveFrames = live.frames
    const edge = liveFrames.at(-1)
    expect(edge?.event).toBe("auth")
    expect(edge?.id).toBeUndefined()

    // A client resuming from before the edge only replays the ringed upsert.
    const replay = hub.replayFrom(0, hub.stats.epoch)
    expect(replay).not.toBeNull()
    expect(replay).toHaveLength(1)
    expect(replay?.[0].cursor).toBe(1)
  })

  test("coalesced usage flushes at most one frame and never enters the ring", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const sink = new FakeSink()
    await hub.subscribe(sink)

    hub.recordUsage({ tokens: 10 })
    hub.recordUsage({ tokens: 20 })
    hub.recordUsage({ tokens: 30 })
    hub.flushUsage()
    hub.flushUsage() // no-op, nothing dirty
    await settle()

    const usageFrames = sink.frames.filter((f) => f.event === "usage")
    expect(usageFrames).toHaveLength(1)
    expect(usageFrames[0].data).toEqual({ tokens: 30 })
    expect(usageFrames[0].id).toBeUndefined()
    expect(hub.stats.ringSize).toBe(0) // usage never ringed
  })
})

describe("ControlHub — backpressure + cleanup", () => {
  test("a slow client overflows and is dropped; others are unaffected", async () => {
    const hub = new ControlHub({
      buildSnapshot: snapshotBuilder(),
      queueCapacity: 2,
    })
    const slow = new FakeSink()
    const healthy = new FakeSink()
    slow.block() // stalls on the snapshot write, so deltas pile up
    await hub.subscribe(slow)
    await hub.subscribe(healthy)

    // Emit spread across event-loop turns so the healthy client drains each
    // frame; the blocked client's queue fills past capacity and it is dropped.
    for (let i = 1; i <= 4; i++) {
      hub.emit("auth", { n: i })
      await settle()
    }

    expect(slow.closedReason).toBe("overflow")
    expect(hub.stats.subscribers).toBe(1) // only healthy remains
    // The healthy client got everything.
    const healthyDeltas = healthy.frames.filter((f) => f.event === "auth")
    expect(healthyDeltas.map((f) => f.id)).toEqual([1, 2, 3, 4])

    slow.unblock()
    await settle()
  })

  test("client unsubscribe removes the subscriber and closes the sink", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const sink = new FakeSink()
    const unsubscribe = await hub.subscribe(sink)
    expect(hub.stats.subscribers).toBe(1)
    unsubscribe()
    await settle()
    expect(hub.stats.subscribers).toBe(0)
    expect(sink.closedReason).toBe("client_close")
  })

  test("a write failure (half-open peer) tears the subscriber down", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const dead = new FakeSink(true) // throws on first write
    await hub.subscribe(dead)
    await settle()
    expect(hub.stats.subscribers).toBe(0)
    expect(dead.closedReason).toBe("drain_end")
  })

  test("a failed snapshot build does not leak the subscriber", async () => {
    const hub = new ControlHub<unknown>({
      buildSnapshot: () => Promise.reject(new Error("registry unavailable")),
    })
    const sink = new FakeSink()
    await expectRejects(() => hub.subscribe(sink), /registry unavailable/)
    expect(hub.stats.subscribers).toBe(0)
    expect(sink.closedReason).toBe("snapshot_failed")
  })
})
