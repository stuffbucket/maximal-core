import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import {
  CHECK_JOBS,
  evaluate,
  EXPECTED,
  exitCodeFor,
  jobIds,
  renderIssue,
  renderSummary,
  renderUnreadable,
  repoPath,
  repoSlug,
  triggersOnPullRequest,
  type Ruleset,
} from "./check-rulesets"

// Offline and deterministic: `evaluate` is pure over already-parsed JSON, and
// the parity block below reads workflow files from this repo. Nothing here
// touches the network.

// A live pair that meets the floor — the shape the GitHub API actually returns
// for this repo, trimmed to the keys the check reads.
function healthy(): Array<Ruleset> {
  return [
    {
      id: 1,
      name: "main-require-pr",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            allowed_merge_methods: ["squash"],
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: true,
            required_status_checks: [
              { context: "test", integration_id: 15368 },
              { context: "windows", integration_id: 15368 },
              { context: "gate", integration_id: 15368 },
            ],
          },
        },
      ],
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    },
    {
      id: 2,
      name: "main-protect-history",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      bypass_actors: [],
    },
  ]
}

/** The `main-require-pr` entry of a fixture, for targeted mutation. */
function requirePr(live: Array<Ruleset>): Ruleset {
  const found = live.find((r) => r.name === "main-require-pr")
  if (!found) throw new Error("fixture lost main-require-pr")
  return found
}

describe("healthy state", () => {
  test("the recorded floor is met", () => {
    const report = evaluate(healthy())
    expect(report.findings).toEqual([])
    expect(report.unverified).toEqual([])
    expect(exitCodeFor(report)).toBe(0)
  })

  test("a tightening is not drift", () => {
    const live = healthy()
    const checks = requirePr(live).rules?.[1]
    ;(checks?.parameters?.required_status_checks as Array<{ context: string }>).push({
      context: "codeql",
    })
    ;(requirePr(live).rules?.[0].parameters as Record<string, unknown>)
      .required_approving_review_count = 1
    expect(evaluate(live).findings).toEqual([])
  })

  test("an unrelated extra ruleset is ignored", () => {
    const live = [...healthy(), { name: "protect-tags", enforcement: "active" }]
    expect(evaluate(live).findings).toEqual([])
  })
})

describe("weakenings are findings", () => {
  test("a deleted ruleset reports once, not once per assertion", () => {
    const report = evaluate(healthy().filter((r) => r.name !== "main-protect-history"))
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({
      ruleset: "main-protect-history",
      assertion: "exists",
    })
    expect(exitCodeFor(report)).toBe(1)
  })

  test("enforcement downgraded to evaluate", () => {
    const live = healthy()
    requirePr(live).enforcement = "evaluate"
    expect(evaluate(live).findings[0].assertion).toBe("enforcement is `active`")
  })

  test("retargeted away from the default branch", () => {
    const live = healthy()
    requirePr(live).conditions = { ref_name: { include: ["refs/heads/dev"] } }
    expect(evaluate(live).findings[0].assertion).toBe("applies to the default branch")
  })

  test("`refs/heads/main` is accepted as the default branch", () => {
    const live = healthy()
    requirePr(live).conditions = { ref_name: { include: ["refs/heads/main"] } }
    expect(evaluate(live).findings).toEqual([])
  })

  test("a removed rule type", () => {
    const live = healthy()
    const history = live.find((r) => r.name === "main-protect-history")
    if (history) history.rules = [{ type: "deletion" }]
    expect(evaluate(live).findings[0].assertion).toBe("carries the `non_fast_forward` rule")
  })

  test("a required check dropped", () => {
    const live = healthy()
    const checks = requirePr(live).rules?.[1]
    if (checks?.parameters) {
      checks.parameters.required_status_checks = [{ context: "test" }]
    }
    const assertions = evaluate(live).findings.map((f) => f.assertion)
    expect(assertions).toContain("requires the `windows` check")
    expect(assertions).toContain("requires the `gate` check")
  })

  test("strict-update turned off", () => {
    const live = healthy()
    const checks = requirePr(live).rules?.[1]
    if (checks?.parameters) checks.parameters.strict_required_status_checks_policy = false
    const finding = evaluate(live).findings[0]
    expect(finding.assertion).toBe("requires the branch to be up to date before merge")
    expect(finding.detail).toContain("Merge Queue")
  })

  test("merge methods widened past squash", () => {
    const live = healthy()
    const pr = requirePr(live).rules?.[0]
    if (pr?.parameters) pr.parameters.allowed_merge_methods = ["squash", "merge"]
    const finding = evaluate(live).findings[0]
    expect(finding.assertion).toContain("only `squash`")
    expect(finding.detail).toContain("`merge`")
  })
})

describe("the bypass assertion", () => {
  test("a removed release bypass is a finding, with the release coupling named", () => {
    const live = healthy()
    requirePr(live).bypass_actors = []
    const finding = evaluate(live).findings[0]
    expect(finding.assertion).toBe("has an always-bypass actor")
    expect(finding.detail).toContain("release:manual")
  })

  test("any always-bypass actor satisfies it, whatever its type", () => {
    const live = healthy()
    requirePr(live).bypass_actors = [
      { actor_id: 3892691, actor_type: "Integration", bypass_mode: "always" },
    ]
    expect(evaluate(live).findings).toEqual([])
  })

  test("a pull-request-only bypass mode does not count", () => {
    const live = healthy()
    requirePr(live).bypass_actors = [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" },
    ]
    expect(evaluate(live).findings[0].assertion).toBe("has an always-bypass actor")
  })

  test("a bypass added to history protection is a finding", () => {
    const live = healthy()
    const history = live.find((r) => r.name === "main-protect-history")
    if (history) {
      history.bypass_actors = [
        { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      ]
    }
    expect(evaluate(live).findings[0].assertion).toBe("has no bypass actor")
  })

  test("an absent bypass_actors key is unverified, never a finding", () => {
    // What an unauthenticated read or a workflow GITHUB_TOKEN gets back:
    // measured on this public repo, the key is omitted entirely.
    const live = healthy().map(({ bypass_actors: _omitted, ...rest }) => rest)
    const report = evaluate(live)
    expect(report.findings).toEqual([])
    expect(report.unverified).toHaveLength(2)
    expect(report.unverified[0].reason).toContain("bypass_actors")
    // Unverified must not escalate: a daily run can never read it.
    expect(exitCodeFor(report)).toBe(0)
  })
})

describe("rendering", () => {
  test("the summary names every expected ruleset", () => {
    const summary = renderSummary(evaluate(healthy()))
    for (const want of EXPECTED) expect(summary).toContain(want.name)
  })

  test("the issue body carries the fix path and the deliberate-change path", () => {
    const live = healthy()
    requirePr(live).enforcement = "disabled"
    const body = renderIssue(evaluate(live), "stuffbucket/maximal-core")
    expect(body).toContain("main-require-pr")
    expect(body).toContain("settings/rules")
    expect(body).toContain("check-rulesets.ts")
    expect(body).toContain("docs/admin/branch-rulesets.md")
  })

  test("an unreadable run says nobody can tell, not that protection is gone", () => {
    const body = renderUnreadable("stuffbucket/maximal-core", "GitHub /rulesets → 403 Forbidden")
    expect(body).toContain("403")
    expect(body).toContain("not")
    expect(body).toContain("private")
  })
})

describe("workflow parsing", () => {
  const yaml = [
    "name: CI",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "  merge_group:",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo not-a-job",
    "  windows:",
    "    runs-on: windows-latest",
    "",
  ].join("\n")

  test("reads top-level job ids only", () => {
    expect(jobIds(yaml)).toEqual(["test", "windows"])
  })

  test("no jobs block yields nothing rather than throwing", () => {
    expect(jobIds("name: x\n")).toEqual([])
  })

  test("detects a pull_request trigger", () => {
    expect(triggersOnPullRequest(yaml)).toBe(true)
    expect(triggersOnPullRequest("on:\n  schedule:\n    - cron: '0 0 * * *'\n")).toBe(false)
    // pull_request_target is a different trigger and must not count.
    expect(triggersOnPullRequest("on:\n  pull_request_target:\n")).toBe(false)
  })
})

// The parity guard. A required status check names a JOB ID; if a job is renamed
// the check never reports and GitHub blocks the PR forever with nothing red to
// point at. This is the offline half of the ruleset check, and the half that
// runs on every PR (release-gates.yml's `test:ops` self-check).
describe("required-check parity with the workflows", () => {
  test("every required context is a job in its workflow", async () => {
    for (const { context, workflow } of CHECK_JOBS) {
      const yaml = await fs.readFile(repoPath(workflow), "utf8")
      expect(jobIds(yaml)).toContain(context)
    }
  })

  test("every workflow producing a required check runs on pull requests", async () => {
    for (const { workflow } of CHECK_JOBS) {
      const yaml = await fs.readFile(repoPath(workflow), "utf8")
      expect(triggersOnPullRequest(yaml)).toBe(true)
    }
  })

  test("the required contexts and the job table are the same set", () => {
    const fromExpectation = new Set(EXPECTED.flatMap((e) => e.requiredContexts ?? []))
    const fromTable = new Set(CHECK_JOBS.map((j) => j.context))
    expect([...fromExpectation].sort()).toEqual([...fromTable].sort())
  })
})

describe("repo slug", () => {
  test("prefers the explicit override, then the Actions env, then the default", () => {
    expect(repoSlug({ RULESET_REPO: "a/b", GITHUB_REPOSITORY: "c/d" })).toBe("a/b")
    expect(repoSlug({ GITHUB_REPOSITORY: "c/d" })).toBe("c/d")
    expect(repoSlug({})).toBe("stuffbucket/maximal-core")
  })
})
