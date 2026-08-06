/**
 * Hono entry point that routes a web-tools-bearing /v1/messages
 * request through the agent loop (streaming or non-streaming).
 */

import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/models/anthropic-types"

import { isNonStreaming } from "~/routes/streaming-predicates"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import { type FlowBaseOptions } from "../api-flows"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "../non-stream-translation"
import { emitStreamError } from "../stream-error"
import { runAgentLoop } from "./agent"
import { selectExecutor } from "./executor"
import { attachClientShims, type WebToolPolicy } from "./rewriter"
import { runStreamingAgent, type UpstreamCall } from "./stream"

export interface WebToolsFlowArgs {
  c: Context
  payload: AnthropicMessagesPayload
  options: FlowBaseOptions
  policy: WebToolPolicy
  /** Upstream-call seam, forwarded to {@link runStreamingAgent}. Production
   *  callers omit it and get the real `createChatCompletions`; the flow test
   *  injects a stub so the mid-stream failure path is drivable without
   *  `mock.module` on a shared module. */
  upstreamCall?: UpstreamCall
}

export async function handleWithWebToolsAgent(args: WebToolsFlowArgs) {
  const { c, payload, options, policy } = args
  attachClientShims(payload, policy)
  const wantsStream = payload.stream === true

  const callOnce = async (
    turnPayload: AnthropicMessagesPayload,
  ): Promise<AnthropicResponse> => {
    const openAIPayload = translateToOpenAI(turnPayload)
    openAIPayload.stream = false
    const response = await createChatCompletions(openAIPayload, {
      requestId: options.requestId,
      sessionId: options.sessionId,
      compactType: options.compactType,
      subagentMarker: options.subagentMarker,
    })
    if (!isNonStreaming(response)) {
      throw new Error(
        "web-tools agent: expected non-streaming response from Copilot",
      )
    }
    return translateToAnthropic(response)
  }

  const executor = selectExecutor()

  if (!wantsStream) {
    const finalResponse = await runAgentLoop({
      initialPayload: payload,
      policy,
      executor,
      callOnce,
      logger: options.logger,
    })
    return c.json(finalResponse)
  }

  // Streaming path — true streaming during agent execution. Each
  // Copilot inner call streams; client sees text + server_tool_use +
  // result blocks as they happen, not buffered to the end.
  //
  // The `try` is load-bearing, and this flow needs it more than its three
  // siblings in `api-flows.ts` do. Those call upstream BEFORE `streamSSE`, so a
  // non-2xx becomes a real HTTP status via the route's `forwardError`. Here the
  // agent loop runs one upstream call PER TURN, all of them inside the stream
  // callback, after the client has already been committed to a 200
  // `text/event-stream`. `streamSSE` takes no `onError` here, so an escaping
  // throw is only `console.error`d and the response closes silently — the
  // client waits for a `message_stop` that never comes. Report in-band instead.
  return streamSSE(c, async (stream) => {
    try {
      await runStreamingAgent({
        initialPayload: payload,
        policy,
        stream,
        options,
        executor,
        upstreamCall: args.upstreamCall,
      })
    } catch (error) {
      await emitStreamError(stream, options.logger, {
        error,
        flow: "chat_completions",
      })
    }
  })
}
