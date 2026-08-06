#!/usr/bin/env bun
/**
 * Branch-ruleset drift check — the protection on `main` is configuration that
 * lives in GitHub's UI, where nothing in this repo can see it change.
 *
 *   bun run rules:check                 # verify the live rulesets
 *   bun run rules:check --body-file x.md   # + a Markdown issue body on drift
 *
 * WHY THIS EXISTS. `main` acquired two rulesets (`main-require-pr`,
 * `main-protect-history`) that turn every previously-advisory CI gate into a
 * merge blocker. They are the load-bearing configuration for every other gate
 * in the repo, and they are also the only gate NOT in the repo: someone with
 * admin can delete or gut either one in the settings UI, in seconds, and no
 * PR, no review and no check would record it. Everything the repo spent this
 * cycle fixing was that same shape — a config nothing read, a guard nothing
 * ran. This is the check that notices.
 *
 * WHY THE EXPECTATION LIVES IN THIS FILE, not in a JSON sibling. Same argument
 * as `scripts/check-deps.ts`: an external expectation file is itself a drift
 * surface, and the nearest thing to a single source of truth is to keep the
 * record inside the gate that reads it. Unlike `external-drift-baseline.json`,
 * which is a *last-reviewed value* a maintainer bumps after reading a
 * changelog, `EXPECTED` below is a *policy* — it changes only when the policy
 * changes, which is a deliberate hand-edit, visible in review, and it is
 * type-checked and unit-tested where a JSON blob would be neither.
 *
 * WHERE THE LINE IS DRAWN, and why. Every assertion here is a FLOOR: a
 * weakening fails, a tightening passes. Bare existence is worthless (a ruleset
 * can be present and gutted — enforcement flipped to `evaluate`, the required
 * checks emptied), and a byte-exact snapshot is worse than worthless (it turns
 * every legitimate settings change into a red build, and a check that cries
 * wolf gets deleted). So:
 *
 *   ASSERTED — the ruleset exists, is `active` (not `evaluate`/`disabled`),
 *   targets the default branch, still carries each rule TYPE, still requires
 *   each of `test`/`windows`/`gate`, still requires the branch to be
 *   up to date (`strict_required_status_checks_policy`, which is what stands in
 *   for the Merge Queue this repo cannot have — repoman ADR-0007), and still
 *   allows ONLY squash merges (the PR title is the commit subject and the whole
 *   changelog; a merge commit would bypass that).
 *
 *   NOT ASSERTED — ruleset ids, timestamps, `do_not_enforce_on_create`, the
 *   review-count knobs, the identity of a bypass actor, and any check or
 *   ruleset beyond the ones named. Required checks are compared as a SUPERSET:
 *   adding a fourth required check is a tightening and must not fail. Likewise
 *   `required_approving_review_count` is unasserted — raising it from 0 is a
 *   tightening, and pinning it would fail on the day someone does.
 *
 * THE ONE ASSERTION THIS USUALLY CANNOT MAKE is the bypass list, and both
 * rulesets now demand the same thing of it: NO bypass actor at all. `main` used
 * to carry an always-mode admin bypass so `release:manual` could push the
 * release commit straight to it; that flow is gone. `release:prepare` lands the
 * release commit through a pull request like everything else, and `release:tag`
 * pushes the tag, which no ruleset here restricts (both are `target: branch`,
 * and there is no tag ruleset). So a bypass actor appearing on `main-require-pr`
 * is now DRIFT rather than a requirement — it would restore the one commit that
 * reached `main` with no check run against it.
 *
 * `bypass_actors` is only returned to a token that can read repository
 * administration — measured: an unauthenticated read of this public repo's
 * rulesets returns 200 with the rules and conditions intact and the
 * `bypass_actors` key ABSENT ENTIRELY, and a workflow `GITHUB_TOKEN` cannot be
 * granted administration at all (there is no such key in a workflow's
 * `permissions:` block). So the key's absence is reported as UNVERIFIED, never
 * as a finding — the same rule `check-bindings.ts` follows for a toolchain it
 * cannot match: an answer you could not compute must never be rendered as an
 * answer you did compute. Deliberately it does not escalate either: a daily
 * scheduled run can never read it, and an alert that fires every single day is
 * an alert nobody reads. It is verified when a human runs this locally — the
 * token comes from `RULESET_WATCH_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`, or, failing
 * all three, from `gh auth token`, because a `gh auth login` session exports
 * nothing to the environment and the local run is the only one that can see
 * this at all. See docs/admin/branch-rulesets.md.
 *
 * IF THE REPO GOES PRIVATE. The ruleset endpoints return 403 on a private
 * repo without GitHub Pro — the rulesets keep applying, but this check can no
 * longer read them. That is exit 2 ("could not read"), which files an issue
 * rather than passing: silence has to be earned, not defaulted to.
 *
 * Exit codes: 0 every readable assertion holds · 1 drift (a protection was
 * removed or weakened) · 2 the rulesets could not be read at all.
 *
 * The GitHub API is the only I/O and it is confined to `fetchRulesets`;
 * `evaluate` and the renderers are pure over already-parsed JSON, so the whole
 * suite in check-rulesets.test.ts runs offline.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

// --- the expectation ---

/** One live ruleset this repo requires, and the floor it must still meet. */
export interface Expectation {
  readonly name: string
  /** Rendered into the report so a reader knows what breaks without it. */
  readonly why: string
  /** Any ONE of these in `conditions.ref_name.include` counts. */
  readonly refs: ReadonlyArray<string>
  /** Rule `type`s that must all still be present. */
  readonly rules: ReadonlyArray<string>
  /** Contexts the `required_status_checks` rule must still require (subset). */
  readonly requiredContexts?: ReadonlyArray<string>
  /** `strict_required_status_checks_policy` must still be on. */
  readonly strictUpdate?: boolean
  /** `allowed_merge_methods` may contain nothing outside this. */
  readonly mergeMethods?: ReadonlyArray<string>
  /** `some`: at least one always-bypass actor. `none`: no bypass at all. */
  readonly bypass: "some" | "none"
  readonly bypassWhy: string
}

export const EXPECTED: ReadonlyArray<Expectation> = [
  {
    name: "main-require-pr",
    why: "Without it every CI gate in this repo is advisory again: a red PR, or no PR at all, can land on `main`.",
    refs: ["~DEFAULT_BRANCH", "refs/heads/main"],
    rules: ["pull_request", "required_status_checks"],
    requiredContexts: ["test", "windows", "gate"],
    strictUpdate: true,
    mergeMethods: ["squash"],
    bypass: "none",
    bypassWhy:
      "Nothing may reach `main` outside a pull request, the release included. `release:prepare` lands the release commit on `release/vX.Y.Z` and opens a PR for it, and `release:tag` then tags the MERGED head — tags are unrestricted here, because both rulesets are `target: branch` and there is no tag ruleset. A bypass actor would put back the one commit that used to reach `main` with no `test`, `windows` or `gate` run against it (docs/release-runbook.md).",
  },
  {
    name: "main-protect-history",
    why: "Without it `main` can be deleted or force-pushed, and a published tag's history can be rewritten under consumers who already resolved it.",
    refs: ["~DEFAULT_BRANCH", "refs/heads/main"],
    rules: ["deletion", "non_fast_forward"],
    bypass: "none",
    bypassWhy:
      "History protection with an exemption is not history protection. Nothing needs to force-push `main`; the release only ever fast-forwards it through a merged pull request.",
  },
]

/**
 * Each required status-check context and the workflow whose JOB ID produces it.
 * A required context that names no job never reports, and GitHub waits for it
 * forever — every PR wedged, with no failing check to point at. The parity test
 * over this table is what makes renaming a job a red build here instead.
 */
export const CHECK_JOBS: ReadonlyArray<{ context: string; workflow: string }> = [
  { context: "test", workflow: ".github/workflows/ci.yml" },
  { context: "windows", workflow: ".github/workflows/ci.yml" },
  { context: "gate", workflow: ".github/workflows/release-gates.yml" },
]

/**
 * Workflows OTHER than the one above that define a job with a required
 * context's name, recorded so a new one fails the parity test instead of
 * appearing silently.
 *
 * A required status check is matched by name, not by workflow. Two workflows
 * with a job of the same name therefore report into one required context, and
 * which result the merge button reads is decided by whichever completed last —
 * so a green run of the wrong workflow can stand in for a red run of the right
 * one. `tooling-ci.yml`'s `test` is path-filtered to `scripts/ops/**` and
 * `package.json`, so the collision only materialises on a PR that touches those
 * (this one does: both reported).
 *
 * NOT FIXED HERE, deliberately. Renaming that job removes the ambiguity but
 * also removes the only thing that makes `typecheck:ops` blocking, and adding
 * the new name to the ruleset is a repository-settings change this repo cannot
 * make from a PR. It is recorded as a known hazard, and the ratchet below stops
 * a second one arriving unannounced — see docs/admin/branch-rulesets.md.
 */
export const KNOWN_CONTEXT_COLLISIONS: ReadonlyArray<string> = [
  ".github/workflows/tooling-ci.yml:test",
]

/** Absolute path to a repo-relative file, so this runs from any cwd. */
export const repoPath = (rel: string): string => path.join(REPO_ROOT, rel)

// --- workflow parsing (offline parity, no YAML dependency) ---

/**
 * Top-level job ids of a workflow. Deliberately textual: the ops lane has no
 * `node_modules` (release-gates.yml runs `test:ops` without `bun install`), so
 * a YAML dependency here would be a new install in three workflows to read
 * three identifiers.
 */
export function jobIds(yaml: string): Array<string> {
  const lines = yaml.split("\n")
  const start = lines.findIndex((l) => /^jobs:\s*$/u.test(l))
  if (start < 0) return []
  const ids: Array<string> = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break // back to column 0: out of the jobs block
    const m = /^ {2}([A-Za-z_][\w-]*):/u.exec(line)
    if (m?.[1]) ids.push(m[1])
  }
  return ids
}

/** Whether a workflow fires on `pull_request` (not `pull_request_target`). */
export function triggersOnPullRequest(yaml: string): boolean {
  const lines = yaml.split("\n")
  const start = lines.findIndex((l) => /^on:\s*$/u.test(l))
  if (start < 0) return /^on:.*\bpull_request\b/mu.test(yaml)
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break
    if (/^ {2}pull_request:/u.test(line)) return true
  }
  return false
}

// --- live state ---

export interface BypassActor {
  actor_id?: number
  actor_type?: string
  bypass_mode?: string
}

export interface Rule {
  type?: string
  parameters?: Record<string, unknown>
}

/** The subset of a ruleset this check reads. Unknown keys are ignored. */
export interface Ruleset {
  id?: number
  name?: string
  target?: string
  enforcement?: string
  conditions?: { ref_name?: { include?: Array<string> } }
  rules?: Array<Rule>
  /** ABSENT unless the caller's token can read repository administration. */
  bypass_actors?: Array<BypassActor>
}

const GH_API = "https://api.github.com"

/** `owner/repo` this check is about. */
export function repoSlug(env: Record<string, string | undefined> = process.env): string {
  return env.RULESET_REPO ?? env.GITHUB_REPOSITORY ?? "stuffbucket/maximal-core"
}

/**
 * The token `gh` is already logged in with, or null. Without this the local run
 * — the ONLY run that can see `bypass_actors` — silently reports it unverified,
 * because a `gh auth login` session stores its token in the CLI's own config
 * and exports nothing to the environment.
 */
export function ghCliToken(
  run: (cmd: string, args: Array<string>) => { status: number | null; stdout: string } = (
    cmd,
    args,
  ) => {
    const res = spawnSync(cmd, args, { encoding: "utf8" })
    return { status: res.status, stdout: res.stdout ?? "" }
  },
): string | null {
  try {
    const res = run("gh", ["auth", "token"])
    if (res.status !== 0) return null
    const token = res.stdout.trim()
    return token === "" ? null : token
  } catch {
    return null // `gh` is not installed — CI, or a machine without it.
  }
}

function ghHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const token =
    env.RULESET_WATCH_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? ghCliToken() ?? undefined
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "maximal-ruleset-check",
    "x-github-api-version": "2022-11-28",
  }
  // Unauthenticated works on a public repo (rules and conditions are public;
  // `bypass_actors` is not) — a token only ever adds visibility here.
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function ghJson(
  route: string,
  env: Record<string, string | undefined>,
): Promise<unknown> {
  const res = await fetch(`${GH_API}${route}`, { headers: ghHeaders(env) })
  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 404
        ? " — a private repo without GitHub Pro returns this for rulesets, and a token with `repo` scope is needed to read bypass actors (docs/admin/branch-rulesets.md)"
        : ""
    throw new Error(`GitHub ${route} → ${res.status} ${res.statusText}${hint}`)
  }
  return res.json()
}

/** Every repository-level ruleset, each fetched in full. The only network. */
export async function fetchRulesets(
  repo: string = repoSlug(),
  env: Record<string, string | undefined> = process.env,
): Promise<Array<Ruleset>> {
  const list = (await ghJson(`/repos/${repo}/rulesets`, env)) as Array<{ id?: number }>
  const out: Array<Ruleset> = []
  for (const summary of list) {
    if (typeof summary.id !== "number") continue
    out.push((await ghJson(`/repos/${repo}/rulesets/${summary.id}`, env)) as Ruleset)
  }
  return out
}

// --- evaluation (pure) ---

/** A protection that is gone or weaker than the floor. Blocking. */
export interface Finding {
  ruleset: string
  assertion: string
  detail: string
}

/** An assertion this token could not see. Reported, never escalated. */
export interface Unverified {
  ruleset: string
  assertion: string
  reason: string
}

export interface Report {
  findings: Array<Finding>
  unverified: Array<Unverified>
}

function rule(live: Ruleset, type: string): Rule | undefined {
  return live.rules?.find((r) => r.type === type)
}

function stringArray(value: unknown): Array<string> | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined
}

/** Every way the live rulesets can fall below the floor `expected` states. */
export function evaluate(
  live: ReadonlyArray<Ruleset>,
  expected: ReadonlyArray<Expectation> = EXPECTED,
): Report {
  const report: Report = { findings: [], unverified: [] }
  const add = (ruleset: string, assertion: string, detail: string): void => {
    report.findings.push({ ruleset, assertion, detail })
  }

  for (const want of expected) {
    const found = live.find((r) => r.name === want.name)
    if (!found) {
      // Everything else would cascade off this one fact; report it alone.
      add(want.name, "exists", `no ruleset named \`${want.name}\` on this repository.`)
      continue
    }

    if (found.enforcement !== "active") {
      add(
        want.name,
        "enforcement is `active`",
        `enforcement is \`${found.enforcement ?? "(unset)"}\` — the rules are recorded but not enforced.`,
      )
    }
    if (found.target !== undefined && found.target !== "branch") {
      add(want.name, "targets branches", `target is \`${found.target}\`, not \`branch\`.`)
    }

    const refs = found.conditions?.ref_name?.include ?? []
    if (!want.refs.some((r) => refs.includes(r))) {
      add(
        want.name,
        "applies to the default branch",
        `\`conditions.ref_name.include\` is ${JSON.stringify(refs)} — none of ${want.refs.join(" / ")}.`,
      )
    }

    for (const type of want.rules) {
      if (!rule(found, type)) {
        add(want.name, `carries the \`${type}\` rule`, `the \`${type}\` rule is gone.`)
      }
    }

    const pr = rule(found, "pull_request")
    if (want.mergeMethods && pr) {
      const methods = stringArray(pr.parameters?.allowed_merge_methods) ?? []
      const extra = methods.filter((m) => !want.mergeMethods?.includes(m))
      if (extra.length > 0) {
        add(
          want.name,
          `allows only ${want.mergeMethods.map((m) => `\`${m}\``).join(" / ")} merges`,
          `\`allowed_merge_methods\` also permits ${extra.map((m) => `\`${m}\``).join(", ")} — a merge commit's subject is not the PR title, so the changelog and every release gate that reads it stop being derivable.`,
        )
      }
    }

    const checks = rule(found, "required_status_checks")
    if (checks) {
      const contexts = new Set(
        (
          (checks.parameters?.required_status_checks as
            | Array<{ context?: unknown }>
            | undefined) ?? []
        )
          .map((c) => c.context)
          .filter((c): c is string => typeof c === "string"),
      )
      for (const context of want.requiredContexts ?? []) {
        if (!contexts.has(context)) {
          add(
            want.name,
            `requires the \`${context}\` check`,
            `\`${context}\` is no longer a required status check (now: ${[...contexts].join(", ") || "none"}).`,
          )
        }
      }
      if (want.strictUpdate === true && checks.parameters?.strict_required_status_checks_policy !== true) {
        add(
          want.name,
          "requires the branch to be up to date before merge",
          "`strict_required_status_checks_policy` is off. This repo has no Merge Queue (unavailable on a user-owned repo), so that flag is the only thing serialising concurrent PRs — without it two independently green PRs can land a broken `main` (repoman ADR-0007).",
        )
      }
    }

    // Bypass: the assertion a workflow token structurally cannot make.
    if (found.bypass_actors === undefined) {
      report.unverified.push({
        ruleset: want.name,
        assertion: want.bypass === "some" ? "has a bypass actor" : "has no bypass actor",
        reason:
          "the API returned no `bypass_actors` key, which is what it does for a caller that cannot read repository administration (an unauthenticated read, or a workflow `GITHUB_TOKEN`). Run `bun run rules:check` locally with a `repo`-scoped token to verify it.",
      })
    } else if (want.bypass === "some") {
      if (!found.bypass_actors.some((a) => a.bypass_mode === "always")) {
        add(want.name, "has an always-bypass actor", want.bypassWhy)
      }
    } else if (found.bypass_actors.length > 0) {
      add(
        want.name,
        "has no bypass actor",
        `${found.bypass_actors.length} bypass actor(s) were added. ${want.bypassWhy}`,
      )
    }
  }

  return report
}

// --- rendering ---

/** One line per assertion, for the run log. */
export function renderSummary(
  report: Report,
  expected: ReadonlyArray<Expectation> = EXPECTED,
): string {
  const lines: Array<string> = []
  for (const want of expected) {
    const findings = report.findings.filter((f) => f.ruleset === want.name)
    lines.push(
      `${findings.length === 0 ? "ok   " : "DRIFT"}  ${want.name.padEnd(22)} ${findings.length === 0 ? "meets the floor" : `${findings.length} finding(s)`}`,
    )
    // The count alone is not actionable, and this is the only output a local
    // run produces — the issue body is written only under --body-file.
    for (const f of findings) lines.push(`         expected ${f.assertion}`, `         got ${f.detail}`)
  }
  for (const u of report.unverified) {
    lines.push(`?     ${u.ruleset.padEnd(22)} unverified: ${u.assertion}`)
  }
  return lines.join("\n")
}

/** Markdown issue body. Scoped so the fix is derivable from it directly. */
export function renderIssue(
  report: Report,
  repo: string,
  expected: ReadonlyArray<Expectation> = EXPECTED,
): string {
  const lines: Array<string> = [
    "## Branch-ruleset drift on `main`",
    "",
    `The protection on \`${repo}\`'s default branch no longer meets the floor recorded in \`scripts/ops/check-rulesets.ts\`. Every CI gate in this repo is blocking **because of** these rulesets, so a weakening here silently un-gates everything else.`,
    "",
    `Review the live state at https://github.com/${repo}/settings/rules — then either restore the protection, or, if the change was deliberate, update \`EXPECTED\` in \`scripts/ops/check-rulesets.ts\` and \`docs/admin/branch-rulesets.md\` in the same PR.`,
    "",
  ]
  for (const want of expected) {
    const findings = report.findings.filter((f) => f.ruleset === want.name)
    if (findings.length === 0) continue
    lines.push(`### \`${want.name}\``, `${want.why}`, "")
    for (const f of findings) lines.push(`- **expected:** ${f.assertion}`, `  - ${f.detail}`)
    lines.push("")
  }
  if (report.unverified.length > 0) {
    lines.push("### Not verified by this run", "")
    for (const u of report.unverified) {
      lines.push(`- \`${u.ruleset}\` — ${u.assertion}: ${u.reason}`)
    }
    lines.push("")
  }
  lines.push(
    "---",
    "_Generated by the `watch-branch-rules` workflow. Reused while drift persists; auto-closes on the next clean run._",
  )
  return lines.join("\n")
}

/** The body filed when the rulesets could not be read at all (exit 2). */
export function renderUnreadable(repo: string, reason: string): string {
  return [
    "## Branch rulesets could not be read",
    "",
    `The drift check could not read \`${repo}\`'s rulesets, so it cannot say whether \`main\` is still protected. This is **not** a report that protection is gone — it is a report that nobody can currently tell.`,
    "",
    `\`\`\`\n${reason}\n\`\`\``,
    "",
    "Most likely causes, in order: the repository went private (the ruleset endpoints return 403 on a private repo without GitHub Pro), the API was down, or a rate limit was hit. Check https://github.com/" +
      repo +
      "/settings/rules by hand and see `docs/admin/branch-rulesets.md`.",
    "",
    "---",
    "_Generated by the `watch-branch-rules` workflow._",
  ].join("\n")
}

// --- entry point ---

export function exitCodeFor(report: Report): number {
  return report.findings.length > 0 ? 1 : 0
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

async function writeOutputs(pairs: Record<string, string>): Promise<void> {
  if (!process.env.GITHUB_OUTPUT) return
  const body = Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("")
  await fs.appendFile(process.env.GITHUB_OUTPUT, body)
}

async function main(): Promise<number> {
  const repo = flag("--repo") ?? repoSlug()
  const bodyFile = flag("--body-file")

  let live: Array<Ruleset>
  try {
    live = await fetchRulesets(repo)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`check-rulesets: could not read ${repo}'s rulesets — ${reason}`)
    await writeOutputs({ drift: "true", unreadable: "true" })
    if (bodyFile) await fs.writeFile(bodyFile, renderUnreadable(repo, reason))
    return 2
  }

  const report = evaluate(live)
  console.error(renderSummary(report))
  const drift = report.findings.length > 0
  await writeOutputs({ drift: String(drift), unreadable: "false" })

  if (drift) {
    if (bodyFile) await fs.writeFile(bodyFile, renderIssue(report, repo))
    console.error(
      `\n${report.findings.length} finding(s). https://github.com/${repo}/settings/rules`,
    )
  } else {
    console.error("\nEvery readable assertion holds — `main` still meets the recorded floor.")
  }
  return exitCodeFor(report)
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exit(code)
    },
    (err: Error) => {
      console.error(`check-rulesets: ${err.message}`)
      process.exit(2)
    },
  )
}
