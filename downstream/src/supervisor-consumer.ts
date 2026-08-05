/**
 * Downstream consumer of `@stuffbucket/maximal-core/supervisor`.
 *
 * Written the way the Electron host in stuffbucket/maximal actually uses it:
 * spawn the sidecar with `sidecarSpawnEnv()`, hand the child's stdout to
 * `awaitReadyLine`, then read the ports and pid off the resolved `ReadyLine`.
 * Every field is DESTRUCTURED and fed to a typed sink, because an import alone
 * proves almost nothing — a removed field only becomes a compile error at the
 * point something reads it.
 *
 * This is the file that would have failed on maximal-core#14: the `port` →
 * `controlPort`/`proxyPort` change is a breaking edit to a published type, and a
 * consumer that reads `.controlPort` breaks the moment it goes away.
 */
import type { AwaitReadyOptions } from "@stuffbucket/maximal-core/supervisor"

import {
  awaitReadyLine,
  parseReadyLine,
  sidecarSpawnEnv,
  SidecarExitedError,
  SidecarReadyTimeoutError,
} from "@stuffbucket/maximal-core/supervisor"

import { expectAssignable } from "./assert.js"

// --- spawn env -------------------------------------------------------------
// A host sets this on the child before it can expect ANY marker on stdout.
// Both call shapes matter: no-arg (default to the host's own pid) and explicit.
const env = sidecarSpawnEnv()
const envForPid = sidecarSpawnEnv(4242)
expectAssignable<string>(env.MAXIMAL_SIDECAR_PARENT_PID)
expectAssignable<string>(envForPid.MAXIMAL_SIDECAR_PARENT_PID)
// The env object must be spreadable into a spawn options bag typed as a plain
// string record — a host merges it with its own environment.
expectAssignable<Record<string, string>>({ FOO: "bar", ...env })

// --- stdout shapes ---------------------------------------------------------
// `child_process`/`utilityProcess` stdout yields Buffers (assignable to
// Uint8Array); Bun.spawn and test doubles commonly yield strings. Both must be
// accepted, or a host has to cast at the boundary.
// A stdout double yields synchronously; the `async` is what makes it an
// AsyncIterable, which is the shape under test.
// eslint-disable-next-line @typescript-eslint/require-await -- async is the shape under test
async function* byteStdout(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([0x40, 0x40])
}
// eslint-disable-next-line @typescript-eslint/require-await -- async is the shape under test
async function* stringStdout(): AsyncGenerator<string> {
  yield "@@MAXIMAL_READY@@ {}\n"
}

const options: AwaitReadyOptions = {
  timeoutMs: 15_000,
  onLine: (line) => {
    expectAssignable<string>(line)
  },
}

// --- the ready line --------------------------------------------------------
export async function boot(): Promise<{
  controlUrl: string
  proxyUrl: string
  pid: number
}> {
  try {
    const ready = await awaitReadyLine(byteStdout(), options)
    // Destructuring is the assertion: rename or remove any of these and this
    // line stops compiling.
    const { v, controlPort, proxyPort, pid } = ready
    expectAssignable<number>(v)
    expectAssignable<number>(controlPort)
    expectAssignable<number>(proxyPort)
    expectAssignable<number>(pid)

    // Options are optional, and the string-stdout overload resolves too.
    const readyFromStrings = await awaitReadyLine(stringStdout())
    expectAssignable<number>(readyFromStrings.controlPort)

    return {
      controlUrl: `http://127.0.0.1:${String(controlPort)}/control`,
      proxyUrl: `http://127.0.0.1:${String(proxyPort)}/v1`,
      pid,
    }
  } catch (error) {
    // Both failure modes must be exported as VALUES, not types: a host
    // distinguishes "it died" from "it is still starting" with `instanceof`,
    // and a type-only export would compile at the import site but explode at
    // runtime. These two lines are what force the value export.
    if (error instanceof SidecarReadyTimeoutError) throw error
    if (error instanceof SidecarExitedError) throw error
    throw error
  }
}

// The constructors are part of the surface too — a host fakes a timeout in its
// own tests.
expectAssignable<Error>(new SidecarReadyTimeoutError(30_000))
expectAssignable<Error>(new SidecarExitedError())

// --- parseReadyLine --------------------------------------------------------
// The null branch is load-bearing: a supervisor must keep reading past a
// garbled marker rather than abort a healthy boot. If the return type ever
// widened to a non-nullable `ReadyLine`, this narrowing would become dead and
// the @ts-expect-error below would flip.
const maybeReady = parseReadyLine('@@MAXIMAL_READY@@ {"v":1}')
if (maybeReady !== null) {
  expectAssignable<number>(maybeReady.controlPort)
}
// @ts-expect-error parseReadyLine returns `ReadyLine | null`; reading a field
// without narrowing must stay an error, or every consumer silently accepts a
// null ready-line.
export const unsafePid: number = parseReadyLine("nope").pid
