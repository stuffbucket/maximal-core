import { describe, expect, test } from "bun:test"

import {
  awaitReadyLine,
  parseReadyLine,
  SidecarExitedError,
  SidecarReadyTimeoutError,
  sidecarSpawnEnv,
} from "~/lib/live/supervisor"
import { READY_MARKER } from "~/lib/start/boot-status"

const READY = `${READY_MARKER} {"v":1,"controlPort":51234,"proxyPort":4141,"pid":99}`
/** The pre-#10 shape: one listener served both planes. */
const READY_V0 = `${READY_MARKER} {"port":51234,"pid":99}`

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
  test("extracts both ports and the pid", () => {
    expect(parseReadyLine(READY)).toEqual({
      v: 1,
      controlPort: 51234,
      proxyPort: 4141,
      pid: 99,
    })
  })

  test("a v0 line still parses — one listener served both planes", () => {
    // This parser ships to hosts that may supervise an older engine. Rejecting
    // the old shape would hang them on a ready-line they silently dropped.
    expect(parseReadyLine(READY_V0)).toEqual({
      v: 0,
      controlPort: 51234,
      proxyPort: 51234,
      pid: 99,
    })
  })

  test("an unknown future version parses if the v1 fields are there", () => {
    const future = `${READY_MARKER} {"v":9,"controlPort":1,"proxyPort":2,"pid":3}`
    expect(parseReadyLine(future)).toMatchObject({ v: 9, controlPort: 1 })
  })

  test("ignores ordinary log lines", () => {
    expect(parseReadyLine("listening on 4141")).toBeNull()
    expect(parseReadyLine("@@MAXIMAL_STATUS@@ Booting…")).toBeNull()
  })

  test("a garbled marker is null, not a throw — the real line may follow", () => {
    expect(parseReadyLine(`${READY_MARKER} {not json`)).toBeNull()
    expect(parseReadyLine(`${READY_MARKER} {"port":"51234"}`)).toBeNull()
    expect(parseReadyLine(`${READY_MARKER} {"pid":1}`)).toBeNull()
    // v1 claimed but the fields are missing — do not silently half-parse.
    expect(parseReadyLine(`${READY_MARKER} {"v":1,"pid":1}`)).toBeNull()
  })
})

describe("awaitReadyLine", () => {
  test("resolves with the bound port once the marker arrives", async () => {
    const ready = await awaitReadyLine(
      chunks("booting\n", "@@MAXIMAL_STATUS@@ Auth…\n", `${READY}\n`),
    )
    expect(ready).toEqual({
      v: 1,
      controlPort: 51234,
      proxyPort: 4141,
      pid: 99,
    })
  })

  test("reassembles a marker split across chunk boundaries", async () => {
    // stdout is a byte stream: a marker can straddle two reads, and a supervisor
    // that split on chunks would drop it intermittently under load.
    const mid = Math.floor(READY.length / 2)
    const ready = await awaitReadyLine(
      chunks(READY.slice(0, mid), READY.slice(mid), "\n"),
    )
    expect(ready.controlPort).toBe(51234)
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

describe("awaitReadyLine — stream ownership", () => {
  test("leaves the stream open: a `for await` exit would kill the sidecar", async () => {
    // Regression. Exiting a `for await` calls iterator.return(), which destroys a
    // Node Readable — closing the read end of the pipe so the sidecar dies with
    // EPIPE on its very next log line. Found by spawning the real binary; no
    // unit test with a plain generator can catch it, so assert it explicitly.
    const { Readable } = await import("node:stream")
    const stream = new Readable({ read() {} })
    stream.push(`${READY}\n`)

    const ready = await awaitReadyLine(stream)
    expect(ready.controlPort).toBe(51234)
    // The assertion that matters: destroying this is what kills the sidecar.
    expect(stream.destroyed).toBe(false)
    expect(stream.readableEnded).toBe(false)
    stream.destroy()
  })

  test("a boot line sharing the ready chunk is surfaced, not dropped", async () => {
    const seen: Array<string> = []
    await awaitReadyLine(chunks(`${READY}\ntrailing line\n`), {
      onLine: (line) => seen.push(line),
    })
    expect(seen).toContain("trailing line")
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
