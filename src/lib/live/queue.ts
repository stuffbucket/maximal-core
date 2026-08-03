/** Sentinel returned by `take()` once the queue is closed and drained, so the
 *  single consumer can distinguish "closed" from a real value. */
export const CLOSED = Symbol("queue-closed")
export type QueueClosed = typeof CLOSED

/**
 * Single-consumer bounded FIFO backing one control subscriber.
 *
 * `push` is non-blocking and returns false on overflow — the caller then drops
 * the slow subscriber rather than letting it block the shared producer (the
 * "drop-slow-then-disconnect" rule). `take` resolves when an item is available
 * or the queue closes; there is at most one waiter because there is exactly one
 * drain loop per subscriber.
 */
export class BoundedQueue<T> {
  private readonly items: Array<T> = []
  private waiter: ((value: T | QueueClosed) => void) | null = null
  private closed = false
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  /** Append to the tail. Returns false on overflow or after close; a waiting
   *  consumer is handed the item directly and bypasses the capacity check. */
  push(item: T): boolean {
    if (this.closed) return false
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve(item)
      return true
    }
    if (this.items.length >= this.capacity) return false
    this.items.push(item)
    return true
  }

  /** Prepend — used once, for the snapshot frame, before the drain starts. */
  pushFront(item: T): void {
    if (this.closed) return
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve(item)
      return
    }
    this.items.unshift(item)
  }

  take(): Promise<T | QueueClosed> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as T)
    }
    if (this.closed) return Promise.resolve(CLOSED)
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve(CLOSED)
    }
  }

  get size(): number {
    return this.items.length
  }
}
