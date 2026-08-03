import { randomUUID } from "node:crypto"

import {
  CONTROL_PROTOCOL_VERSION,
  type ControlFrame,
  type ControlTopic,
  serializeFrame,
  type SnapshotPayload,
} from "~/lib/live/contract"
import { BoundedQueue, CLOSED } from "~/lib/live/queue"

/**
 * The write sink a transport (the SSE route, or a test) provides. `write` MUST
 * apply real backpressure — resolve only once the frame has flushed to the
 * socket — so a slow client overflows its own bounded queue instead of blocking
 * the shared producer.
 */
export interface ControlSink {
  write(frame: string): Promise<void>
  close(reason: string): void
}

interface Subscriber {
  readonly sink: ControlSink
  readonly queue: BoundedQueue<string>
  alive: boolean
}

export interface SubscribeOptions {
  /** The client's Last-Event-ID cursor, if it is resuming. */
  lastEventId?: string | number
  /** The epoch the client last saw; must match for a replay, else re-snapshot. */
  epoch?: string
}

export interface ControlHubOptions<Snapshot = unknown> {
  /** Builds the full current-state snapshot for a connecting client. Injected so
   *  the hub stays decoupled from the (still being re-homed) aggregators. */
  buildSnapshot: () => Promise<Snapshot>
  /** Delta ring depth — how far back a resume can reach before re-snapshotting. */
  ringCapacity?: number
  /** Per-subscriber queue depth before a slow client is dropped. */
  queueCapacity?: number
  /** If set, send an SSE keepalive comment to every subscriber this often.
   *  Enqueued through each subscriber's queue, so the single drain loop stays
   *  the only writer. Omit to disable (the default). */
  heartbeatMs?: number
}

const DEFAULT_RING_CAPACITY = 512
const DEFAULT_QUEUE_CAPACITY = 256

/** SSE comment sent on each heartbeat tick — keeps idle connections open
 *  through intermediaries and surfaces a dead peer (an unwritable socket
 *  overflows the queue and the subscriber is dropped). */
const HEARTBEAT_FRAME = ": keepalive\n\n"

/**
 * Owns the cursor, the delta ring, the epoch, and fan-out to every connected
 * subscriber. Library-first: the SSE route and any in-process embedder both
 * drive this same API. Modeled on Tailscale's per-session channel +
 * drop-slow-then-disconnect, with Kubernetes list-watch resume (monotonic
 * cursor + replay ring). See docs/spec/control-api.md.
 */
export class ControlHub<Snapshot = unknown> {
  private cursor = 0
  private readonly epoch = randomUUID()
  private readonly ring: Array<ControlFrame> = []
  private readonly subscribers = new Set<Subscriber>()

  private latestUsage: unknown = undefined
  private usageDirty = false

  private readonly buildSnapshot: () => Promise<Snapshot>
  private readonly ringCapacity: number
  private readonly queueCapacity: number
  private readonly heartbeatTimer: ReturnType<typeof setInterval> | null

  constructor(options: ControlHubOptions<Snapshot>) {
    this.buildSnapshot = options.buildSnapshot
    this.ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY
    this.queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY
    this.heartbeatTimer =
      options.heartbeatMs === undefined ?
        null
      : this.startHeartbeat(options.heartbeatMs)
  }

  private startHeartbeat(intervalMs: number): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      this.fanout(HEARTBEAT_FRAME)
    }, intervalMs)
    timer.unref()
    return timer
  }

  /** Stop the heartbeat timer. For tests and a clean shutdown. */
  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
  }

  // ── Producer API ────────────────────────────────────────────────────────

  /**
   * Publish a full-resource state upsert — cursored, ringed, resumable. MUST run
   * synchronously with no await before the cursor is assigned, so two concurrent
   * emits can never ring out of monotonic order.
   */
  emit(topic: ControlTopic, data: unknown): void {
    const cursor = ++this.cursor
    const frame: ControlFrame = { topic, data, cursor }
    this.ring.push(frame)
    if (this.ring.length > this.ringCapacity) this.ring.shift()
    this.fanout(serializeFrame(frame))
  }

  /**
   * Publish a transient / side-effecting signal on the live edge only — no
   * cursor, never ringed, never replayed. This is what keeps a gap-free
   * reconnect from re-firing something like an OS toast
   * (`notify_on_reconnect`).
   */
  emitEdge(topic: ControlTopic, data: unknown): void {
    this.fanout(serializeFrame({ topic, data }))
  }

  /** Record a usage tick. Coalesced (only the latest is flushed) and edge-only,
   *  so a per-request storm can't evict resumable frames from the ring. */
  recordUsage(data: unknown): void {
    this.latestUsage = data
    this.usageDirty = true
  }

  /** Emit at most one coalesced usage frame. Wire to an interval in production;
   *  called directly in tests for determinism. */
  flushUsage(): void {
    if (!this.usageDirty) return
    this.usageDirty = false
    this.emitEdge("usage", this.latestUsage)
  }

  // ── Consumer API ────────────────────────────────────────────────────────

  /**
   * Attach a subscriber. Registers it for fan-out synchronously (so no delta is
   * missed during the snapshot build), then either replays the ring (gap-free
   * resume) or pushes a fresh snapshot at the head of its queue, then starts the
   * single drain loop. Returns an unsubscribe function.
   */
  async subscribe(
    sink: ControlSink,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    const subscriber: Subscriber = {
      sink,
      queue: new BoundedQueue<string>(this.queueCapacity),
      alive: true,
    }
    const baseline = this.cursor
    this.subscribers.add(subscriber)

    const replay =
      options.lastEventId === undefined ?
        null
      : this.replayFrom(options.lastEventId, options.epoch)

    if (replay) {
      for (const frame of replay) {
        subscriber.queue.push(serializeFrame(frame))
      }
    } else {
      let snapshot: Snapshot
      try {
        snapshot = await this.buildSnapshot()
      } catch (error) {
        // Registered before the await, so a failed build cannot leak it.
        this.remove(subscriber, "snapshot_failed")
        throw error
      }
      const payload: SnapshotPayload<Snapshot> = {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        epoch: this.epoch,
        snapshot,
      }
      subscriber.queue.pushFront(
        serializeFrame({ topic: "snapshot", cursor: baseline, data: payload }),
      )
    }

    void this.drain(subscriber)
    return () => {
      this.remove(subscriber, "client_close")
    }
  }

  /**
   * The cursored frames a resuming client missed, or null if it must
   * re-snapshot. Forces a re-snapshot on epoch mismatch, a non-integer or
   * negative id, a future cursor (never silently go live with stale state), or a
   * gap past the ring's oldest entry.
   */
  replayFrom(
    lastEventId: string | number,
    epoch?: string,
  ): Array<ControlFrame> | null {
    if (epoch !== this.epoch) return null
    const since = Number(lastEventId)
    if (!Number.isInteger(since) || since < 0) return null
    if (since > this.cursor) return null
    if (this.ring.length === 0) return since === this.cursor ? [] : null
    const oldest = this.ring[0].cursor ?? 0
    if (since + 1 < oldest) return null
    return this.ring.filter((frame) => (frame.cursor ?? 0) > since)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private fanout(frame: string): void {
    // The frame is serialized once and the same string is shared to every
    // queue. Iterate a copy — overflow removal mutates the set mid-loop.
    for (const subscriber of Array.from(this.subscribers)) {
      if (!subscriber.queue.push(frame)) {
        this.remove(subscriber, "overflow")
      }
    }
  }

  private async drain(subscriber: Subscriber): Promise<void> {
    try {
      while (subscriber.alive) {
        const item = await subscriber.queue.take()
        if (item === CLOSED) break
        await subscriber.sink.write(item)
      }
    } catch {
      // A write threw: dead or half-open peer. Fall through to cleanup — this
      // is the detector for connections onAbort never fires for.
    } finally {
      this.remove(subscriber, "drain_end")
    }
  }

  private remove(subscriber: Subscriber, reason: string): void {
    if (!subscriber.alive) return
    subscriber.alive = false
    this.subscribers.delete(subscriber)
    subscriber.queue.close()
    subscriber.sink.close(reason)
  }

  // ── Introspection (tests / diagnostics) ─────────────────────────────────

  get stats(): {
    subscribers: number
    cursor: number
    ringSize: number
    epoch: string
  } {
    return {
      subscribers: this.subscribers.size,
      cursor: this.cursor,
      ringSize: this.ring.length,
      epoch: this.epoch,
    }
  }
}
