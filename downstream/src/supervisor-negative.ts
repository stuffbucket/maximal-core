/**
 * Negative assertions for the supervisor surface.
 *
 * A positive fixture proves a field EXISTS. These prove the complements that a
 * positive fixture cannot: that a removed field is genuinely gone, that a wrong
 * shape is rejected, and that the type surface is nameable (or, where it is not,
 * that the gap is recorded rather than forgotten).
 *
 * Every `@ts-expect-error` here is a two-way tripwire: it fails if the error
 * stops happening as well as if a new one appears.
 */
import {
  awaitReadyLine,
  type ParsedReadyLine,
  type ReadyLine,
} from "@stuffbucket/maximal-core/supervisor"

import { expectAssignable } from "./assert.js"

/**
 * Both contract types are nameable by a consumer. This started life as an
 * expect-error pinning the opposite — `ReadyLine` appeared in the public
 * signatures of `awaitReadyLine` and `parseReadyLine` but was not re-exported,
 * so a consumer had to reconstruct it from the return type. That gap is closed;
 * these assertions keep it closed.
 *
 * The two are distinct on purpose: `ReadyLine` is what the engine EMITS
 * (`v >= 1`), `ParsedReadyLine` is what the parser RETURNS (either version,
 * normalised). The parser's type is the wider one, so it must be assignable to
 * the emitter's — that direction is what keeps the change source-compatible.
 */
export type ReadyLineShape = ReadyLine
export type ParsedShape = ParsedReadyLine

export function nameableContractTypes(parsed: ParsedReadyLine): void {
  expectAssignable<ReadyLine>(parsed)
}

export async function negatives(
  stdout: AsyncIterable<Uint8Array>,
): Promise<void> {
  const ready = await awaitReadyLine(stdout)

  // @ts-expect-error `port` was replaced by `controlPort`/`proxyPort` when the
  // engine split the control and data planes (maximal-core#10). A consumer
  // still reading `.port` must fail to COMPILE rather than silently read
  // `undefined` and hang connecting to port NaN — which is what shipped past
  // every test in the repo before this fixture existed.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- the error type is the assertion
  expectAssignable<number>(ready.port)
}

// A ready line missing a port is not a ready line. Guards against the schema
// being loosened to all-optional, which would typecheck at every call site
// while making the contract meaningless.
// @ts-expect-error missing `controlPort`, `proxyPort` and `pid`.
export const incomplete: ReadyLineShape = { v: 1 }

// The version discriminant must stay numeric — a consumer switches on it to
// tell a v0 engine from a v1 one.
export const wrongVersionType: ReadyLineShape = {
  // @ts-expect-error `v` is a number, not a string.
  v: "1",
  controlPort: 1,
  proxyPort: 2,
  pid: 3,
}

// `awaitReadyLine` must keep taking an async iterable, not a Node stream type
// or a string. A host owns the process model; core owns only the protocol.
// @ts-expect-error a plain string is not an AsyncIterable of chunks.
export const wrongStdout = awaitReadyLine("@@MAXIMAL_READY@@ {}")
