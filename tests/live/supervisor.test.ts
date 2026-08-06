import { describe, expect, test } from "bun:test"

import {
  awaitReadyLine,
  type ParsedReadyLine,
  parseReadyLine,
  type ReadyLine,
  SidecarExitedError,
  SidecarReadyTimeoutError,
  sidecarSpawnEnv,
} from "~/lib/live/supervisor"
import {
  READY_LINE_VERSION,
  READY_MARKER,
  readyLineSchema,
} from "~/lib/start/boot-status"

const READY = `${READY_MARKER} {"v":1,"controlPort":51234,"proxyPort":4141,"pid":99}`
/** The pre-#14 shape: one listener served both planes. */
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

describe("parseReadyLine — version honesty", () => {
  test("a normalised v0 line is not an emittable line", () => {
    // The defect this guards. `parseReadyLine` used to be annotated `ReadyLine`
    // — the *emitter's* type, documented as `v >= 1` — while the v0 branch
    // returns `v: 0`, so a host that trusted the documented contract could be
    // handed a 0 with no type error anywhere to warn it. The bound that keeps
    // the two contracts apart lives on `readyLineSchema`; widening it to
    // `min(0)` to make a return type fit would delete the separation entirely.
    const parsed: ParsedReadyLine | null = parseReadyLine(READY_V0)
    expect(parsed?.v).toBe(0)
    expect(readyLineSchema.safeParse(parsed).success).toBe(false)
  })

  test("a wire line cannot claim v0 while carrying the current fields", () => {
    // v0 is *synthesised* by the parser for a line that carried no version at
    // all; no engine emits it. A line that states it must not be accepted, or
    // "v: 0 means pre-split engine" stops being something a host can rely on.
    const forged = `${READY_MARKER} {"v":0,"controlPort":1,"proxyPort":2,"pid":3}`
    expect(parseReadyLine(forged)).toBeNull()
    const negative = `${READY_MARKER} {"v":-1,"controlPort":1,"proxyPort":2,"pid":3}`
    expect(parseReadyLine(negative)).toBeNull()
    const fractional = `${READY_MARKER} {"v":1.5,"controlPort":1,"proxyPort":2,"pid":3}`
    expect(parseReadyLine(fractional)).toBeNull()
  })

  test("what this engine stamps validates as an emitted line and round-trips", () => {
    const emitted: ReadyLine = {
      v: READY_LINE_VERSION,
      controlPort: 51_234,
      proxyPort: 4141,
      pid: 99,
    }
    expect(readyLineSchema.safeParse(emitted).success).toBe(true)
    expect(
      parseReadyLine(`${READY_MARKER} ${JSON.stringify(emitted)}`),
    ).toEqual(emitted)
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

describe("boot-failure errors carry what the sidecar emitted", () => {
  // A failed boot is usually seen once, in a CI log, by someone who cannot
  // re-run it. Naming only the symptom makes that log undiagnosable, and the
  // cause is on stderr — which this module never sees, so a supervisor that
  // owns the pipes passes it in.
  test("the output is appended to the message", () => {
    expect(
      new SidecarExitedError("Sidecar output (1 lines):\n  stderr  EADDRINUSE")
        .message,
    ).toBe(
      "Sidecar stdout closed before it emitted a ready-line\nSidecar output (1 lines):\n  stderr  EADDRINUSE",
    )
    expect(
      new SidecarReadyTimeoutError(30_000, "still binding\n").message,
    ).toBe("Sidecar did not emit a ready-line within 30000ms\nstill binding")
  })

  test("a host with nothing to add gets the bare message", () => {
    expect(new SidecarExitedError().message).toBe(
      "Sidecar stdout closed before it emitted a ready-line",
    )
    expect(new SidecarReadyTimeoutError(20, "   ").message).toBe(
      "Sidecar did not emit a ready-line within 20ms",
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
