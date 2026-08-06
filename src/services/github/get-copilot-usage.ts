import { z } from "zod"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/config/api-config"
import { GITHUB_API_TIMEOUT_MS } from "~/lib/http/http-timeouts"
import { sendRequestJson } from "~/lib/http/send-request"
import { state } from "~/lib/runtime-state/state"

export const getCopilotUsage = async (
  githubToken?: string,
): Promise<CopilotUsageResponse> => {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  return await sendRequestJson(
    `${getGitHubApiBaseUrl()}/copilot_internal/user`,
    {
      githubToken: resolvedGithubToken,
      headers: githubHeaders(),
      timeoutMs: GITHUB_API_TIMEOUT_MS,
      errorMessage: "Failed to get Copilot usage",
    },
    CopilotUsageResponseSchema,
  )
}

// Every field optional, for the same reason the response schema below declares
// its own that way: this payload varies by plan/account type, and an
// `unlimited` snapshot has no numeric entitlement to report. Requiring the full
// set here made a lean-but-valid snapshot throw — not only breaking the usage
// view, but making `copilot-preflight` reject an entitled account with a
// "check your connection" that had nothing to do with the network.
const QuotaDetailSchema = z
  .object({
    entitlement: z.number().optional(),
    overage_count: z.number().optional(),
    overage_permitted: z.boolean().optional(),
    percent_remaining: z.number().optional(),
    quota_id: z.string().optional(),
    quota_remaining: z.number().optional(),
    remaining: z.number().optional(),
    unlimited: z.boolean().optional(),
  })
  .loose()

export type QuotaDetail = z.infer<typeof QuotaDetailSchema>

// Each snapshot is optional: GitHub returns different quota keys per plan/account
// and has already retired one (`premium_interactions`, #311). `.loose()` keeps
// any snapshot key we don't name.
const QuotaSnapshotsSchema = z
  .object({
    chat: QuotaDetailSchema.optional(),
    completions: QuotaDetailSchema.optional(),
    premium_interactions: QuotaDetailSchema.optional(),
  })
  .loose()

// Declares ONLY the fields the app reads, every one optional/nullish — this is
// an undocumented internal endpoint whose payload varies by account type
// (free/EMU/business), so a strict schema would throw on a valid response and
// break the usage view (the regression this validation exists to prevent).
// `.loose()` passes the rest of the body through untouched, so the `/usage`
// route still relays the full object to the dashboard.
const CopilotUsageResponseSchema = z
  .object({
    login: z.string().optional(),
    copilot_plan: z.string().optional(),
    quota_reset_date: z.string().optional(),
    quota_snapshots: QuotaSnapshotsSchema.nullish(),
  })
  .loose()

export type CopilotUsageResponse = z.infer<typeof CopilotUsageResponseSchema>
