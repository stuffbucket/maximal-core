import { describe, expect, test } from "bun:test"

import {
  awaitReadyLine,
  parseReadyLine,
  SidecarExitedError,
  SidecarReadyTimeoutError,
  sidecarSpawnEnv,
} from "~/lib/live/supervisor"
import { READY_MARKER } from "~/lib/start/boot-status"

const READY = `${READY_MARKER} {"port":51234,"pid":99}`

/** Feed stdout as arbitrary chunks so the reassembly path is exercised. */

// literals needs no await; the async form is what `awaitReadyLine` consumes.
async function* chunks(...parts: Array<string>): AsyncGenerator<string> {
  for (const part of parts) {
    // Yield across a microtask so chunks arrive the way a real stdout stream
    // delivers them, rather than all in one synchronous drain.
    await Promise.resolve()
    yield part
  }
}

/** Never yields a ready-line, so the timeout path is reachable. */
async function* stalls(): AsyncGenerator<string> {
  yield "booting\n"
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

async function expectRejection(
  fn: () => Promise<unknown>,
  ctor: new (...args: Array<never>) => Error,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ctor)
    return
  }
  throw new Error(`expected a ${ctor.name}, but it resolved`)
}

describe("parseReadyLine", () => {
  test("extracts the port and pid", () => {
    expect(parseReadyLine(READY)).toEqual({ port: 51234, pid: 99 })
  })

  test("ignores ordinary log lines", () => {
    expect(parseReadyLine("listening on 4141")).toBeNull()
    expect(parseReadyLine("@@MAXIMAL_STATUS@@ Booting…")).toBeNull()
  })

  test("a garbled marker is null, not a throw — the real line may follow", () => {
    expect(parseReadyLine(`${READY_MARKER} {not json`)).toBeNull()
    expect(parseReadyLine(`${READY_MARKER} {"port":"51234"}`)).toBeNull()
    expect(parseReadyLine(`${READY_MARKER} {"pid":1}`)).toBeNull()
  })
})

describe("awaitReadyLine", () => {
  test("resolves with the bound port once the marker arrives", async () => {
    const ready = await awaitReadyLine(
      chunks("booting\n", "@@MAXIMAL_STATUS@@ Auth…\n", `${READY}\n`),
    )
    expect(ready).toEqual({ port: 51234, pid: 99 })
  })

  test("reassembles a marker split across chunk boundaries", async () => {
    // stdout is a byte stream: a marker can straddle two reads, and a supervisor
    // that split on chunks would drop it intermittently under load.
    const mid = Math.floor(READY.length / 2)
    const ready = await awaitReadyLine(
      chunks(READY.slice(0, mid), READY.slice(mid), "\n"),
    )
    expect(ready.port).toBe(51234)
  })

  test("surfaces preceding boot lines so a splash can show progress", async () => {
    const seen: Array<string> = []
    await awaitReadyLine(chunks(`starting\nauth ok\n${READY}\n`), {
      onLine: (line) => seen.push(line),
    })
    expect(seen).toEqual(["starting", "auth ok"])
  })

  test("stdout closing before readiness is an exit, not a timeout", async () => {
    // The distinction matters: a supervisor reports "the sidecar died" very
    // differently from "it is still starting".
    await expectRejection(
      () => awaitReadyLine(chunks("booting\n")),
      SidecarExitedError,
    )
  })

  test("a sidecar that never announces readiness times out", async () => {
    await expectRejection(
      () => awaitReadyLine(stalls(), { timeoutMs: 20 }),
      SidecarReadyTimeoutError,
    )
  })
})

describe("sidecarSpawnEnv", () => {
  test("sets the gate the markers depend on", () => {
    // Without this the sidecar emits no markers at all, and a supervisor waits
    // forever on a ready-line that will never come.
    expect(sidecarSpawnEnv(1234)).toEqual({
      MAXIMAL_SIDECAR_PARENT_PID: "1234",
    })
  })
})
