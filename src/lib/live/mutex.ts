/**
 * Process-wide async mutex: serializes state-mutating control actions so no two
 * interleave across their await chains. Without this, `activateAccount` (which
 * awaits a network preflight before swapping the in-memory token trio and
 * writing the registry) and a concurrent `signOut` interleave, leaving the
 * proxy's in-memory trio divergent from the on-disk active key. Broadcast order
 * converges regardless; only serialized mutation makes the underlying state
 * converge too.
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve()

  /** Run `fn` once every prior action has settled. A rejected action does not
   *  wedge the queue — the next action still runs. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
