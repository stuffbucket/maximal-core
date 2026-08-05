/**
 * The one way to serve a hub subscription over SSE.
 *
 * Both live surfaces need the identical dance — build a sink, subscribe, then
 * hold the response open until the client goes away — and having it written
 * twice is how the two drift into behaving differently under abort. `jscpd`
 * flagged them as a clone; this is the deduplication.
 *
 * Client disconnect **is** the unsubscribe. There is no cancel call, because a
 * transport-level disconnect is unambiguous and a separate cancel would race it.
 */
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { ControlHub, ControlSink } from "~/lib/live/hub"
import type { ControlSnapshot } from "~/lib/live/resources"

export function streamSubscription(
  c: Context,
  hub: () => ControlHub<ControlSnapshot>,
): Response {
  return streamSSE(c, async (stream) => {
    const sink: ControlSink = {
      write: async (frame) => {
        await stream.write(frame)
      },
      close: () => {
        // Resolved by the abort handler below.
      },
    }
    const unsubscribe = await hub().subscribe(sink)
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe()
        resolve()
      })
    })
  })
}
