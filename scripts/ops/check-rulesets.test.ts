import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import {
  CHECK_JOBS,
  evaluate,
  EXPECTED,
  exitCodeFor,
  ghCliToken,
  jobIds,
  KNOWN_CONTEXT_COLLISIONS,
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

/** One rule's `parameters` bag, for targeted mutation. Throws if the fixture drifted. */
function params(live: Array<Ruleset>, type: string): Record<string, unknown> {
  const found = requirePr(live).rules?.find((r) => r.type === type)?.parameters
  if (!found) throw new Error(`fixture lost the ${type} rule`)
  return found
}

/** The required-context list inside the `required_status_checks` rule. */
function contexts(live: Array<Ruleset>): Array<{ context: string }> {
  return params(live, "required_status_checks").required_status_checks as Array<{
    context: string
  }>
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
    contexts(live).push({ context: "codeql" })
    params(live, "pull_request").required_approving_review_count = 1
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
    params(live, "required_status_checks").required_status_checks = [{ context: "test" }]
    const assertions = evaluate(live).findings.map((f) => f.assertion)
    expect(assertions).toContain("requires the `windows` check")
    expect(assertions).toContain("requires the `gate` check")
  })

  test("strict-update turned off", () => {
    const live = healthy()
    params(live, "required_status_checks").strict_required_status_checks_policy = false
    const finding = evaluate(live).findings[0]
    expect(finding.assertion).toBe("requires the branch to be up to date before merge")
    expect(finding.detail).toContain("Merge Queue")
  })

  test("merge methods widened past squash", () => {
    const live = healthy()
    params(live, "pull_request").allowed_merge_methods = ["squash", "merge"]
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

  test("the summary carries each finding's detail, not just a count", () => {
    // The only output a local run produces; the issue body needs --body-file.
    // Printing `1 finding(s)` and nothing else sends the reader to the settings
    // UI to guess which assertion broke.
    const live = healthy()
    requirePr(live).enforcement = "disabled"
    const summary = renderSummary(evaluate(live))
    const [finding] = evaluate(live).findings
    expect(finding).toBeDefined()
    expect(summary).toContain(finding!.assertion)
    expect(summary).toContain(finding!.detail)
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

describe("token resolution", () => {
  // The local run is the only one that can ever read `bypass_actors`, and a
  // `gh auth login` session exports no token to the environment — so without
  // this fallback the one assertion that matters most is always "unverified".
  test("falls back to the token gh is logged in with", () => {
    expect(ghCliToken(() => ({ status: 0, stdout: "gho_fake\n" }))).toBe("gho_fake")
  })

  test("is null when gh is logged out, absent, or prints nothing", () => {
    expect(ghCliToken(() => ({ status: 1, stdout: "" }))).toBeNull()
    expect(ghCliToken(() => ({ status: 0, stdout: "  \n" }))).toBeNull()
    expect(
      ghCliToken(() => {
        throw new Error("ENOENT")
      }),
    ).toBeNull()
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

  // A required check is matched by NAME. A second workflow with a job of the
  // same name reports into the same required context, and the last one to
  // finish decides what the merge button reads — so a green run of the wrong
  // workflow can stand in for a red run of the right one. The standing
  // collision is recorded; a new one fails here.
  test("no unrecorded workflow reuses a required context's job name", async () => {
    const dir = repoPath(".github/workflows")
    const contexts = new Set(CHECK_JOBS.map((j) => j.context))
    const owner = new Map(CHECK_JOBS.map((j) => [j.context, j.workflow]))
    const found: Array<string> = []
    for (const file of (await fs.readdir(dir)).sort()) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue
      const rel = `.github/workflows/${file}`
      const yaml = await fs.readFile(repoPath(rel), "utf8")
      for (const id of jobIds(yaml)) {
        if (contexts.has(id) && owner.get(id) !== rel) found.push(`${rel}:${id}`)
      }
    }
    expect(found).toEqual([...KNOWN_CONTEXT_COLLISIONS])
  })
})

describe("repo slug", () => {
  test("prefers the explicit override, then the Actions env, then the default", () => {
    expect(repoSlug({ RULESET_REPO: "a/b", GITHUB_REPOSITORY: "c/d" })).toBe("a/b")
    expect(repoSlug({ GITHUB_REPOSITORY: "c/d" })).toBe("c/d")
    expect(repoSlug({})).toBe("stuffbucket/maximal-core")
  })
})
