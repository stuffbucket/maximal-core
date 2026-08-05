import { afterEach, describe, expect, test } from "bun:test"

import { parseReadyLine } from "~/lib/live/supervisor"
import {
  emitReadyLine,
  READY_LINE_VERSION,
  READY_MARKER,
  type ReadyLine,
} from "~/lib/start/boot-status"

const ORIGINAL_PARENT = process.env.MAXIMAL_SIDECAR_PARENT_PID

function captureStdout(fn: () => void): string {
  const written: Array<string> = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: string) => {
    written.push(chunk)
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = original
  }
  return written.join("")
}

afterEach(() => {
  if (ORIGINAL_PARENT === undefined) {
    delete process.env.MAXIMAL_SIDECAR_PARENT_PID
  } else {
    process.env.MAXIMAL_SIDECAR_PARENT_PID = ORIGINAL_PARENT
  }
})

describe("ready-line (maximal-core#3)", () => {
  test("emits one parseable line carrying the bound port and pid", () => {
    process.env.MAXIMAL_SIDECAR_PARENT_PID = "4242"
    const out = captureStdout(() => {
      expect(
        emitReadyLine({ v: 1, controlPort: 51234, proxyPort: 4141, pid: 99 }),
      ).toBe(true)
    })

    const lines = out.split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith(`${READY_MARKER} `)).toBe(true)

    const payload = JSON.parse(
      lines[0].slice(READY_MARKER.length + 1),
    ) as ReadyLine
    // The control port is the whole point: a supervisor asks for an ephemeral
    // one, so this is the only way it learns where to connect. The proxy port
    // matters too — it falls back when 4141 is held (maximal-core#10).
    expect(payload.v).toBe(1)
    expect(payload.controlPort).toBe(51234)
    expect(payload.proxyPort).toBe(4141)
    expect(payload.pid).toBe(99)
  })

  test("a plain CLI run emits nothing — the user's terminal stays clean", () => {
    delete process.env.MAXIMAL_SIDECAR_PARENT_PID
    const out = captureStdout(() => {
      expect(
        emitReadyLine({ v: 1, controlPort: 4141, proxyPort: 4141, pid: 1 }),
      ).toBe(false)
    })
    expect(out).toBe("")
  })

  test("the payload survives a strict round-trip, so a supervisor can parse it", () => {
    process.env.MAXIMAL_SIDECAR_PARENT_PID = "1"
    const ready: ReadyLine = { v: 1, controlPort: 0, proxyPort: 4141, pid: 7 }
    const out = captureStdout(() => {
      emitReadyLine(ready)
    })
    // JSON on a single line: a supervisor reads stdout line-by-line and must not
    // need to buffer across newlines to parse one marker.
    expect(out.trimEnd()).not.toContain("\n")
    expect(JSON.parse(out.slice(READY_MARKER.length + 1)) as ReadyLine).toEqual(
      ready,
    )
  })

  test("what this engine emits is what a supervisor's parser reads back", () => {
    // The end of the contract, both halves at once: emitter and parser derive
    // from one schema precisely so this cannot drift. `v` is stamped from
    // READY_LINE_VERSION rather than a literal, so bumping the version without
    // teaching the parser about it fails here.
    process.env.MAXIMAL_SIDECAR_PARENT_PID = "1"
    const ready: ReadyLine = {
      v: READY_LINE_VERSION,
      controlPort: 51_234,
      proxyPort: 4141,
      pid: 99,
    }
    const out = captureStdout(() => {
      emitReadyLine(ready)
    })
    expect(parseReadyLine(out.trimEnd())).toEqual(ready)
  })
})
