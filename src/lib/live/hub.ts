import {
  CONTROL_PROTOCOL_VERSION,
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

export interface ControlHubOptions<Snapshot = unknown> {
  /** Builds the full current-state snapshot for a connecting client. Injected so
   *  the hub stays decoupled from the (still being re-homed) aggregators. */
  buildSnapshot: () => Promise<Snapshot>
  /** Per-subscriber queue depth before a slow client is dropped. */
  queueCapacity?: number
  /** If set, send an SSE keepalive comment to every subscriber this often.
   *  Enqueued through each subscriber's queue, so the single drain loop stays
   *  the only writer. Omit to disable (the default). */
  heartbeatMs?: number
}

const DEFAULT_QUEUE_CAPACITY = 256

/** SSE comment sent on each heartbeat tick — keeps idle connections open
 *  through intermediaries and surfaces a dead peer (an unwritable socket
 *  overflows the queue and the subscriber is dropped). */
const HEARTBEAT_FRAME = ": keepalive\n\n"

/**
 * Owns fan-out to every connected subscriber. Library-first: the SSE route and
 * any in-process embedder drive this same API. Per-subscriber bounded queue with
 * drop-slow-then-disconnect (Tailscale's shape), so one wedged client can never
 * stall the shared producer.
 *
 * There is deliberately **no cursor, ring, or epoch**. ADR-0023 makes the
 * control plane stateless, so a dropped feed reconnects and re-snapshots rather
 * than replaying. That removes the resume bookkeeping entirely — and with it the
 * reason `emit` and `emitEdge` had to be different methods, since nothing is
 * ringed for a transient frame to evict.
 */
export class ControlHub<Snapshot = unknown> {
  private readonly subscribers = new Set<Subscriber>()

  private latestUsage: unknown = undefined
  private usageDirty = false

  private readonly buildSnapshot: () => Promise<Snapshot>
  private readonly queueCapacity: number
  private readonly heartbeatTimer: ReturnType<typeof setInterval> | null

  constructor(options: ControlHubOptions<Snapshot>) {
    this.buildSnapshot = options.buildSnapshot
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
   * Publish a state change to every live subscriber.
   *
   * One method, not the old cursored/edge pair: with nothing ringed there is no
   * ring for a high-frequency topic to evict, so the distinction that justified
   * two methods no longer exists.
   */
  emit(topic: ControlTopic, data: unknown): void {
    this.fanout(serializeFrame({ topic, data }))
  }

  /** Record a usage tick. Still coalesced — that was always about volume, not
   *  resume: a per-request storm would otherwise overflow every subscriber's
   *  bounded queue and get slow clients dropped. */
  recordUsage(data: unknown): void {
    this.latestUsage = data
    this.usageDirty = true
  }

  /** Emit at most one coalesced usage frame. Wire to an interval in production;
   *  called directly in tests for determinism. */
  flushUsage(): void {
    if (!this.usageDirty) return
    this.usageDirty = false
    this.emit("usage", this.latestUsage)
  }

  // ── Consumer API ────────────────────────────────────────────────────────

  /**
   * Attach a subscriber. Registers it for fan-out synchronously (so no frame is
   * missed during the snapshot build), pushes the snapshot at the head of its
   * queue, then starts the single drain loop. Returns an unsubscribe function.
   *
   * Every connect is a fresh snapshot — there is no resume path to take instead.
   */
  async subscribe(sink: ControlSink): Promise<() => void> {
    const subscriber: Subscriber = {
      sink,
      queue: new BoundedQueue<string>(this.queueCapacity),
      alive: true,
    }
    this.subscribers.add(subscriber)

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
      snapshot,
    }
    subscriber.queue.pushFront(
      serializeFrame({ topic: "snapshot", data: payload }),
    )

    void this.drain(subscriber)
    return () => {
      this.remove(subscriber, "client_close")
    }
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

  get stats(): { subscribers: number } {
    return { subscribers: this.subscribers.size }
  }
}
