import { defineCommand } from "citty"
import consola from "consola"

import { setupGitHubToken } from "./lib/auth/token"
import { ensurePaths } from "./lib/platform/paths"
import {
  getCopilotUsage,
  type QuotaDetail,
} from "./services/github/get-copilot-usage"

export const checkUsage = defineCommand({
  meta: {
    name: "check-usage",
    description: "Show current GitHub Copilot usage/quota information",
  },
  async run() {
    await ensurePaths()
    await setupGitHubToken()
    try {
      const usage = await getCopilotUsage()

      // Helper to summarize a quota snapshot. Every field is optional at the
      // boundary (GitHub varies the payload per plan — an `unlimited` snapshot
      // carries no counters), so a snapshot that omits them reports what it has
      // rather than printing NaN.
      function summarizeQuota(name: string, snap: QuotaDetail | undefined) {
        if (!snap) return `${name}: N/A`
        const total = snap.entitlement
        const remaining = snap.remaining
        if (total === undefined || remaining === undefined) {
          return `${name}: ${snap.unlimited ? "unlimited" : "N/A"}`
        }
        const used = total - remaining
        const percentUsed = total > 0 ? (used / total) * 100 : 0
        const percentRemaining =
          snap.percent_remaining ?? (total > 0 ? (remaining / total) * 100 : 0)
        return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`
      }

      const premiumLine = summarizeQuota(
        "Premium",
        usage.quota_snapshots?.premium_interactions,
      )
      const chatLine = summarizeQuota("Chat", usage.quota_snapshots?.chat)
      const completionsLine = summarizeQuota(
        "Completions",
        usage.quota_snapshots?.completions,
      )

      consola.box(
        `Copilot Usage (plan: ${usage.copilot_plan})\n`
          + `Quota resets: ${usage.quota_reset_date}\n`
          + `\nQuotas:\n`
          + `  ${premiumLine}\n`
          + `  ${chatLine}\n`
          + `  ${completionsLine}`,
      )
    } catch (err) {
      consola.error("Failed to fetch Copilot usage:", err)
      process.exit(1)
    }
  },
})
