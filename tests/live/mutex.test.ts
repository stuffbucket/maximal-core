import { describe, expect, test } from "bun:test"

import { AsyncMutex } from "~/lib/live/mutex"

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

describe("AsyncMutex", () => {
  test("serializes actions across their await chains (no interleave)", async () => {
    const mutex = new AsyncMutex()
    const order: Array<string> = []

    const action = (name: string) => async (): Promise<void> => {
      order.push(`${name}:start`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`${name}:end`)
    }

    // Both submitted synchronously; they must NOT interleave.
    await Promise.all([
      mutex.runExclusive(action("A")),
      mutex.runExclusive(action("B")),
    ])

    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"])
  })

  test("a rejected action does not wedge the queue", async () => {
    const mutex = new AsyncMutex()
    await expectRejects(
      () => mutex.runExclusive(() => Promise.reject(new Error("boom"))),
      /boom/,
    )

    // The next action still runs.
    const result = await mutex.runExclusive(() => Promise.resolve(42))
    expect(result).toBe(42)
  })

  test("simulated switch-vs-signout converge on a serialized final state", async () => {
    const mutex = new AsyncMutex()
    // Model the divergence hazard: an in-memory value and an on-disk value that
    // must stay equal. Each action reads, awaits (preflight), then writes both.
    const store = { memory: "none", disk: "none" }

    const activate = (key: string) => async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 5)) // preflight
      store.memory = key
      await new Promise((resolve) => setTimeout(resolve, 1)) // registry write
      store.disk = key
    }
    const signout = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      store.memory = "none"
      await new Promise((resolve) => setTimeout(resolve, 3))
      store.disk = "none"
    }

    await Promise.all([
      mutex.runExclusive(activate("acct-b")),
      mutex.runExclusive(signout),
    ])

    // Whatever ran last, memory and disk agree — no torn state.
    expect(store.memory).toBe(store.disk)
  })
})
