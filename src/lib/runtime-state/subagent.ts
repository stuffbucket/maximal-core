import { z } from "zod"

export const subagentMarkerPrefix = "__SUBAGENT_MARKER__"

/**
 * The subagent marker Claude Code embeds in a `<system-reminder>` block.
 *
 * A **wire boundary**: this JSON is written by another program, so it is
 * *parsed*, not cast — the same reason `readyLineSchema` exists in
 * `~/lib/start/boot-status`. Schema and type are one definition; `SubagentMarker`
 * is derived from the schema, so the shape we validate and the shape we pass
 * around cannot drift apart.
 *
 * What this replaced: `JSON.parse(json) as SubagentMarker` followed by
 * `!parsed.session_id || !parsed.agent_id || !parsed.agent_type`. That is a
 * truthiness test, not a type test — `{"session_id": 123, "agent_id": 1,
 * "agent_type": 1}` passed it, and every consumer downstream then held three
 * numbers typed as `string`. `.min(1)` preserves the old rejection of empty
 * strings exactly; the difference is that a non-string is now rejected too.
 *
 * `.loose()` because the marker is not ours to close: Claude Code may add
 * fields, and an unknown key must not stop us recognising a subagent turn.
 */
export const subagentMarkerSchema = z
  .object({
    session_id: z.string().min(1),
    agent_id: z.string().min(1),
    agent_type: z.string().min(1),
  })
  .loose()

export type SubagentMarker = z.infer<typeof subagentMarkerSchema>
