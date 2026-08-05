import { describe, expect, test } from "bun:test"

import { frameEnvelopeSchema } from "~/lib/live/contract"
import { ControlHub, type ControlSink } from "~/lib/live/hub"

// Let the microtask + macrotask queues drain so every subscriber's drain loop
// has delivered what's in its queue.
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5))

/** A feed frame is a JSON-RPC notification on the `data:` line — no `id:`, no
 *  `event:`. Those were the v1 envelope and the resume mechanism it implied. */
interface ParsedFrame {
  jsonrpc: string
  method: string
  params?: unknown
}

function parseSse(block: string): ParsedFrame {
  let dataStr: string | undefined
  for (const line of block.trimEnd().split("\n")) {
    if (line.startsWith("data:")) dataStr = line.slice("data:".length).trim()
  }
  if (dataStr === undefined) throw new Error(`no data line in block: ${block}`)
  // Validate against the shared wire contract while we're here.
  return frameEnvelopeSchema.parse(JSON.parse(dataStr))
}

/** Topic a frame carries, with the `control/` namespace stripped. */
function topicOf(frame: ParsedFrame): string {
  return frame.method.replace(/^control\//, "")
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
      expect(topicOf(frames[0])).toBe("snapshot")
      const deltas = frames.slice(1)
      expect(deltas.map((f) => topicOf(f))).toEqual([
        "auth",
        "auth",
        "auth",
        "auth",
        "auth",
      ])
      // Order is still guaranteed — the per-subscriber queue is FIFO and the
      // drain loop is the sole writer. It just isn't expressed as a cursor any
      // more, so assert it on the payloads the producer emitted.
      expect(deltas.map((f) => (f.params as { n: number }).n)).toEqual([
        0, 1, 2, 3, 4,
      ])
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

describe("ControlHub — statelessness", () => {
  test("a reconnecting subscriber re-snapshots; there is no replay path", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder({ n: 1 }) })
    const first = new FakeSink()
    const un = await hub.subscribe(first)
    hub.emit("auth", { a: 1 })
    await settle()
    un()

    // Reconnect. A v1 client would have sent Last-Event-ID here and expected the
    // gap replayed; there is deliberately nothing to send and nothing to replay.
    const second = new FakeSink()
    await hub.subscribe(second)
    await settle()

    const topics = second.frames.map((f) => topicOf(f))
    expect(topics[0]).toBe("snapshot")
    // The delta emitted while it was away is gone — the fresh snapshot is the
    // only source of truth, which is the whole point of dropping the ring.
    expect(topics).not.toContain("auth")
    hub.dispose()
  })

  test("frames carry no SSE id, so a client cannot advertise a resume it won't get", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const sink = new FakeSink()
    await hub.subscribe(sink)
    hub.emit("auth", { a: 1 })
    await settle()
    for (const raw of sink.rawFrames) {
      expect(raw.startsWith("id:")).toBe(false)
      expect(raw).not.toContain("\nid:")
    }
    hub.dispose()
  })

  test("every frame is a JSON-RPC notification — no id, method names the topic", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const sink = new FakeSink()
    await hub.subscribe(sink)
    hub.emit("accounts", { list: [] })
    await settle()
    const parsed = sink.frames
    expect(parsed.every((f) => f.jsonrpc === "2.0")).toBe(true)
    // A notification must never carry an id: the server expects no reply.
    expect(parsed.every((f) => !("id" in f))).toBe(true)
    expect(parsed.at(-1)?.method).toBe("control/accounts")
    hub.dispose()
  })

  test("coalesced usage still flushes at most one frame", async () => {
    const hub = new ControlHub({ buildSnapshot: snapshotBuilder() })
    const sink = new FakeSink()
    await hub.subscribe(sink)
    hub.recordUsage({ t: 1 })
    hub.recordUsage({ t: 2 })
    hub.recordUsage({ t: 3 })
    hub.flushUsage()
    hub.flushUsage() // nothing dirty
    await settle()
    const usage = sink.frames.filter((f) => topicOf(f) === "usage")
    expect(usage).toHaveLength(1)
    // Coalescing was always about volume, not resume — the latest wins.
    expect(usage[0].params).toEqual({ t: 3 })
    hub.dispose()
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
    const healthyDeltas = healthy.frames.filter((f) => topicOf(f) === "auth")
    expect(healthyDeltas.map((f) => (f.params as { n: number }).n)).toEqual([
      1, 2, 3, 4,
    ])

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

describe("ControlHub — heartbeat", () => {
  test("sends periodic keepalive comments through the single drain", async () => {
    const hub = new ControlHub({
      buildSnapshot: snapshotBuilder(),
      heartbeatMs: 10,
    })
    const sink = new FakeSink()
    await hub.subscribe(sink)
    await new Promise((resolve) => setTimeout(resolve, 40))
    hub.dispose()

    const keepalives = sink.rawFrames.filter((frame) => frame.startsWith(":"))
    expect(keepalives.length).toBeGreaterThanOrEqual(1)
    expect(keepalives[0]).toContain("keepalive")

    // dispose stopped the timer — no further keepalives arrive.
    const countAfterDispose = sink.rawFrames.length
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(sink.rawFrames.length).toBe(countAfterDispose)
  })
})
