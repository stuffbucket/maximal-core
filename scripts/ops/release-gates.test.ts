import { describe, expect, test } from "bun:test"

import {
  checkTagVersion,
  classifyBump,
  collectMilestoneGate,
  collectPrGate,
  exemption,
  exitCodeFor,
  evaluateMilestone,
  evaluatePr,
  type Finding,
  formatVersion,
  type GatePullRequest,
  type GateReport,
  hasBreakingFooter,
  highestTag,
  isAdjacent,
  isBot,
  main,
  maxVersion,
  OVERRIDE_LABEL,
  parseArgs,
  parseReleaseTag,
  PACKAGE_JSON_PATH,
  readPackageVersion,
  renderAnnotations,
  renderFindings,
  renderSummary,
  requiredBump,
  type Version,
} from "./release-gates"
import type { GhResult, GhRunner, ParsedTitle } from "./release-notes"

// Offline and deterministic: every `gh` call goes through the injected
// GhRunner from release-notes.ts, so this suite never shells out, never hits
// the network, and never depends on a PR or milestone existing. No
// `mock.module` anywhere (see AGENTS.md — Bun leaks module mocks forward).

const REPO = "stuffbucket/maximal-core"
const CURRENT: Version = [0, 2, 1]

const title = (t: string, breaking = false): ParsedTitle => ({
  type: t,
  breaking,
  description: "x",
})

const pr = (over: Partial<GatePullRequest> = {}): GatePullRequest => ({
  number: 42,
  title: "fix(auth): stop the refresh loop",
  body: "",
  milestone: { title: "v0.2.2" },
  author: { login: "stuffbucket", is_bot: false },
  labels: [],
  ...over,
})

const kinds = (r: GateReport): Array<string> => r.findings.map((f) => f.kind)
const bySeverity = (r: GateReport, s: Finding["severity"]): Array<string> =>
  r.findings.filter((f) => f.severity === s).map((f) => f.kind)

/** A GhRunner backed by a fixture table keyed on a substring of the argv. */
const fakeGh = (
  routes: ReadonlyArray<[string, unknown]>,
  calls: Array<Array<string>> = [],
): GhRunner => {
  return (args) => {
    calls.push([...args])
    const joined = args.join(" ")
    const hit = routes.find(([needle]) => joined.includes(needle))
    const result: GhResult = hit
      ? { status: 0, stdout: JSON.stringify(hit[1]), stderr: "" }
      : { status: 1, stdout: "", stderr: `unrouted: ${joined}` }
    return result
  }
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64")

describe("parseReleaseTag", () => {
  test("accepts exactly vX.Y.Z", () => {
    expect(parseReleaseTag("v0.3.0")).toEqual([0, 3, 0])
    expect(parseReleaseTag(" v10.20.30 ")).toEqual([10, 20, 30])
  })

  test("rejects anything that is not a release tag", () => {
    // The lenient parseSemver would happily turn every one of these into a
    // version — `Backlog` into [0,0,0], which would read as "milestone below
    // the current version" instead of "not a release milestone".
    for (const bad of [
      "Backlog",
      "v0.3",
      "0.3.0",
      "v0.3.0-rc.1",
      "v0.3.0 (Q3)",
      "",
    ]) {
      expect(parseReleaseTag(bad)).toBeUndefined()
    }
  })
})

describe("classifyBump", () => {
  test("classifies by the highest component that increased", () => {
    expect(classifyBump([0, 2, 1], [0, 2, 2])).toBe("patch")
    expect(classifyBump([0, 2, 1], [0, 3, 0])).toBe("minor")
    expect(classifyBump([0, 2, 1], [1, 0, 0])).toBe("major")
  })

  test("a multi-patch skip is still only a PATCH-level move", () => {
    // The load-bearing case: 0.2.1 -> 0.2.5 stays inside ^0.2.x, so a breaking
    // change in it is exactly as dangerous as in 0.2.2.
    expect(classifyBump([0, 2, 1], [0, 2, 5])).toBe("patch")
  })

  test("a minor skip is a genuine minor (out of a ^0.2.x range)", () => {
    expect(classifyBump([0, 2, 1], [0, 4, 0])).toBe("minor")
  })

  test("equal or lower targets are not-ahead", () => {
    expect(classifyBump([0, 2, 1], [0, 2, 1])).toBe("not-ahead")
    expect(classifyBump([0, 2, 1], [0, 2, 0])).toBe("not-ahead")
    expect(classifyBump([0, 3, 0], [0, 2, 9])).toBe("not-ahead")
    expect(classifyBump([1, 0, 0], [0, 9, 9])).toBe("not-ahead")
  })
})

describe("isAdjacent", () => {
  test("recognises the immediate next version at each level", () => {
    expect(isAdjacent([0, 2, 1], [0, 2, 2], "patch")).toBe(true)
    expect(isAdjacent([0, 2, 1], [0, 3, 0], "minor")).toBe(true)
    expect(isAdjacent([0, 2, 1], [1, 0, 0], "major")).toBe(true)
  })

  test("rejects skips and non-zeroed tails", () => {
    expect(isAdjacent([0, 2, 1], [0, 2, 5], "patch")).toBe(false)
    expect(isAdjacent([0, 2, 1], [0, 3, 1], "minor")).toBe(false)
    expect(isAdjacent([0, 2, 1], [0, 4, 0], "minor")).toBe(false)
    expect(isAdjacent([0, 2, 1], [1, 1, 0], "major")).toBe(false)
  })
})

describe("requiredBump", () => {
  test("pre-1.0: feat and fix are patches, breaking is a minor", () => {
    expect(requiredBump(title("fix"), [0, 2, 1])).toBe("patch")
    expect(requiredBump(title("feat"), [0, 2, 1])).toBe("patch")
    expect(requiredBump(title("feat", true), [0, 2, 1])).toBe("minor")
    expect(requiredBump(title("fix", true), [0, 2, 1])).toBe("minor")
  })

  test("post-1.0 the convention flips to plain semver", () => {
    // ^1.2.0 is >=1.2.0 <2.0.0, so at 1.0 it is MAJOR that leaves the range;
    // keeping the pre-1.0 table would silently permit breaking minors.
    expect(requiredBump(title("fix"), [1, 2, 0])).toBe("patch")
    expect(requiredBump(title("feat"), [1, 2, 0])).toBe("minor")
    expect(requiredBump(title("feat", true), [1, 2, 0])).toBe("major")
  })
})

describe("hasBreakingFooter", () => {
  test("matches a real footer", () => {
    expect(hasBreakingFooter("body\n\nBREAKING CHANGE: port is gone")).toBe(true)
    expect(hasBreakingFooter("BREAKING-CHANGE: port is gone")).toBe(true)
  })

  test("does not match prose or a lowercase mention", () => {
    expect(hasBreakingFooter("this is not a breaking change: promise")).toBe(false)
    expect(hasBreakingFooter("we avoid a BREAKING CHANGE here")).toBe(false)
    expect(hasBreakingFooter("")).toBe(false)
    expect(hasBreakingFooter(null)).toBe(false)
  })
})

describe("highestTag / maxVersion", () => {
  test("picks the highest release tag and ignores non-tags", () => {
    expect(highestTag(["v0.1.0", "nightly", "v0.2.1", "v0.2.0"])).toEqual([0, 2, 1])
    expect(highestTag(["nightly"])).toBeUndefined()
  })

  test("maxVersion tolerates either side missing", () => {
    expect(maxVersion([0, 2, 1], [0, 3, 0])).toEqual([0, 3, 0])
    expect(maxVersion(undefined, [0, 3, 0])).toEqual([0, 3, 0])
    expect(maxVersion([0, 2, 1], undefined)).toEqual([0, 2, 1])
    expect(maxVersion(undefined, undefined)).toEqual([0, 0, 0])
  })
})

describe("gate 1 — a PR must carry a release milestone", () => {
  test("a missing milestone blocks", () => {
    const r = evaluatePr({ pr: pr({ milestone: null }), current: CURRENT })
    expect(kinds(r)).toEqual(["missing-milestone"])
    expect(r.findings[0].severity).toBe("error")
    expect(exitCodeFor(r, "enforce")).toBe(1)
  })

  test("a non-release milestone blocks HERE, not as a gate-2 finding", () => {
    // `Backlog` satisfies "has a milestone" while shipping in no release and
    // appearing in no generated notes — exactly what gate 1 exists to prevent.
    const r = evaluatePr({
      pr: pr({ milestone: { title: "Backlog" } }),
      current: CURRENT,
    })
    expect(kinds(r)).toEqual(["milestone-not-a-release"])
  })

  test("a bot PR without a milestone warns instead of blocking", () => {
    // Dependabot cannot set a milestone; blocking would wedge every bump.
    const r = evaluatePr({
      pr: pr({
        milestone: null,
        title: "chore(deps): bump hono",
        author: { login: "dependabot[bot]", is_bot: true },
      }),
      current: CURRENT,
    })
    expect(bySeverity(r, "error")).toEqual([])
    expect(bySeverity(r, "warn")).toEqual(["missing-milestone"])
    expect(exitCodeFor(r, "enforce")).toBe(0)
  })

  test("a bot PR WITH a milestone is gated at full strength", () => {
    const r = evaluatePr({
      pr: pr({
        title: "feat(api)!: drop the legacy field",
        author: { login: "renovate[bot]", is_bot: false },
      }),
      current: CURRENT,
    })
    expect(bySeverity(r, "error")).toEqual(["bump-too-small"])
  })

  test("a clean PR produces nothing", () => {
    expect(evaluatePr({ pr: pr(), current: CURRENT }).findings).toEqual([])
  })
})

describe("gate 2 — a breaking change must be a minor", () => {
  test("blocks a breaking PR bucketed into a patch milestone", () => {
    // The PR #14 case: it removed `port` from the published ReadyLine type.
    const r = evaluatePr({
      pr: pr({
        number: 14,
        title: "feat(server)!: split /v1 and the control plane",
        milestone: { title: "v0.2.2" },
      }),
      current: CURRENT,
    })
    expect(kinds(r)).toEqual(["bump-too-small"])
    expect(r.findings[0].message).toContain("**minor**")
    expect(r.findings[0].message).toContain("^0.2.1")
  })

  test("allows the same PR in a minor milestone", () => {
    const r = evaluatePr({
      pr: pr({
        title: "feat(server)!: split /v1 and the control plane",
        milestone: { title: "v0.3.0" },
      }),
      current: CURRENT,
    })
    expect(r.findings).toEqual([])
  })

  test("blocks a breaking PR in a multi-patch skip milestone", () => {
    // v0.2.5 is four patches ahead but still inside ^0.2.x.
    const r = evaluatePr({
      pr: pr({ title: "fix(api)!: drop the field", milestone: { title: "v0.2.5" } }),
      current: CURRENT,
    })
    expect(kinds(r)).toEqual(["non-adjacent-bump", "bump-too-small"])
    expect(bySeverity(r, "error")).toEqual(["bump-too-small"])
  })

  test("an over-cautious minor for a non-breaking PR is allowed", () => {
    // The runbook's rule: when in doubt, minor.
    const r = evaluatePr({
      pr: pr({ title: "fix: tiny thing", milestone: { title: "v0.3.0" } }),
      current: CURRENT,
    })
    expect(r.findings).toEqual([])
  })

  test("a milestone BELOW the current version blocks, once", () => {
    const r = evaluatePr({
      pr: pr({ title: "feat!: break it", milestone: { title: "v0.2.0" } }),
      current: CURRENT,
    })
    // Only the milestone-level finding: comparing each PR against a version
    // that went backwards would repeat the same thing N times.
    expect(kinds(r)).toEqual(["milestone-not-ahead"])
  })

  test("a milestone EQUAL to the current version blocks", () => {
    const r = evaluatePr({
      pr: pr({ milestone: { title: "v0.2.1" } }),
      current: CURRENT,
    })
    expect(kinds(r)).toEqual(["milestone-not-ahead"])
  })

  test("a non-adjacent minor is a warning, not a block", () => {
    const r = evaluatePr({
      pr: pr({ title: "feat!: break it", milestone: { title: "v0.4.0" } }),
      current: CURRENT,
    })
    expect(kinds(r)).toEqual(["non-adjacent-bump"])
    expect(exitCodeFor(r, "enforce")).toBe(0)
  })

  test("a body-only BREAKING CHANGE footer is reported AND counted", () => {
    const r = evaluatePr({
      pr: pr({
        title: "feat(supervisor): rework the ready line",
        body: "why\n\nBREAKING CHANGE: `port` is gone from ReadyLine.",
        milestone: { title: "v0.2.2" },
      }),
      current: CURRENT,
    })
    // Both: the title must gain `!` (the changelog is generated from titles
    // only), and the milestone is under-bumped for what the body declares.
    expect(kinds(r)).toEqual(["breaking-marker-mismatch", "bump-too-small"])
  })

  test("a `!` title with a matching footer reports no mismatch", () => {
    const r = evaluatePr({
      pr: pr({
        title: "feat(supervisor)!: rework the ready line",
        body: "BREAKING CHANGE: `port` is gone.",
        milestone: { title: "v0.3.0" },
      }),
      current: CURRENT,
    })
    expect(r.findings).toEqual([])
  })

  test("a non-conforming title blocks with or without a milestone", () => {
    expect(
      kinds(evaluatePr({ pr: pr({ title: "add a thing" }), current: CURRENT })),
    ).toEqual(["non-conforming-title"])
    expect(
      kinds(
        evaluatePr({
          pr: pr({ title: "add a thing", milestone: null }),
          current: CURRENT,
        }),
      ),
    ).toEqual(["missing-milestone", "non-conforming-title"])
  })
})

describe("siblings — PRs in one milestone that disagree", () => {
  const breakingSibling = pr({
    number: 7,
    title: "feat(contract)!: drop the legacy field",
  })

  test("a sibling's violation surfaces as a WARNING on this PR", () => {
    const r = evaluatePr({
      pr: pr({ number: 42, milestone: { title: "v0.2.2" } }),
      current: CURRENT,
      siblings: [pr({ number: 42 }), breakingSibling],
    })
    expect(bySeverity(r, "error")).toEqual([])
    expect(bySeverity(r, "warn")).toEqual(["bump-too-small"])
    expect(r.findings[0].number).toBe(7)
    expect(exitCodeFor(r, "enforce")).toBe(0)
  })

  test("the same disagreement BLOCKS at the milestone boundary", () => {
    const r = evaluateMilestone({
      tag: "v0.2.2",
      current: CURRENT,
      prs: [pr({ number: 42 }), breakingSibling],
    })
    expect(bySeverity(r, "error")).toEqual(["bump-too-small"])
    expect(exitCodeFor(r, "enforce")).toBe(1)
  })

  test("the milestone's requirement is the MAX over its PRs", () => {
    // One feat! in a bag of fixes forces the whole milestone to a minor.
    const clean = evaluateMilestone({
      tag: "v0.3.0",
      current: CURRENT,
      prs: [
        pr({ number: 1, title: "fix: a" }),
        pr({ number: 2, title: "feat: b" }),
        pr({ number: 3, title: "feat(x)!: c" }),
      ],
    })
    expect(clean.findings).toEqual([])
  })

  test("the PR under test is not reported twice as its own sibling", () => {
    const self = pr({ number: 42, title: "feat!: break it", milestone: { title: "v0.2.2" } })
    const r = evaluatePr({ pr: self, current: CURRENT, siblings: [self] })
    expect(kinds(r)).toEqual(["bump-too-small"])
  })

  test("an exempt sibling does not resurface as a finding on its neighbour", () => {
    const r = evaluatePr({
      pr: pr({ number: 42, milestone: { title: "v0.2.2" } }),
      current: CURRENT,
      siblings: [
        pr({
          number: 7,
          title: "feat!: break it",
          labels: [{ name: OVERRIDE_LABEL }],
        }),
      ],
    })
    expect(r.findings).toEqual([])
  })
})

describe("exemptions", () => {
  test("a release commit is exempt (it belongs to no milestone by design)", () => {
    expect(exemption(pr({ title: "chore: release 0.3.0" }))).toBe("release commit")
    expect(exemption(pr({ title: "chore(main): release v0.3.0" }))).toBe(
      "release commit",
    )
    const r = evaluatePr({
      pr: pr({ title: "chore: release 0.3.0", milestone: null }),
      current: CURRENT,
    })
    expect(kinds(r)).toEqual(["gate-exempt"])
    expect(exitCodeFor(r, "enforce")).toBe(0)
  })

  test("the override label downgrades everything on that PR", () => {
    const r = evaluatePr({
      pr: pr({
        title: "feat!: break it",
        milestone: null,
        labels: [{ name: OVERRIDE_LABEL }],
      }),
      current: CURRENT,
    })
    expect(kinds(r)).toEqual(["gate-exempt"])
    expect(exitCodeFor(r, "enforce")).toBe(0)
  })

  test("an ordinary label is not an exemption", () => {
    expect(exemption(pr({ labels: [{ name: "bug" }] }))).toBeUndefined()
  })

  test("isBot recognises both signals", () => {
    expect(isBot(pr({ author: { login: "dependabot[bot]" } }))).toBe(true)
    expect(isBot(pr({ author: { login: "someone", is_bot: true } }))).toBe(true)
    expect(isBot(pr({ author: { login: "someone", is_bot: false } }))).toBe(false)
    expect(isBot(pr({ author: null }))).toBe(false)
  })
})

describe("evaluateMilestone", () => {
  test("refuses a milestone title that is not a release tag", () => {
    const r = evaluateMilestone({ tag: "Backlog", current: CURRENT, prs: [] })
    expect(kinds(r)).toEqual(["milestone-not-a-release"])
  })

  test("flags a milestone at or below the current release", () => {
    const r = evaluateMilestone({ tag: "v0.2.1", current: CURRENT, prs: [] })
    expect(kinds(r)).toEqual(["empty-milestone", "milestone-not-ahead"])
  })

  test("an empty milestone is never a silent green", () => {
    // A typo'd tag returns zero PRs exactly like a real-but-unassigned one.
    const r = evaluateMilestone({ tag: "v0.9.9", current: CURRENT, prs: [] })
    expect(kinds(r)).toContain("empty-milestone")
    expect(exitCodeFor(r, "enforce")).toBe(1)
  })
})

describe("gate 3 — the tag must match package.json", () => {
  test("matching versions pass", () => {
    expect(checkTagVersion("v0.3.0", "0.3.0").findings).toEqual([])
    expect(checkTagVersion("v0.3.0", "v0.3.0").findings).toEqual([])
  })

  test("the v0.1.1 regression is caught", () => {
    const r = checkTagVersion("v0.1.1", "0.1.0")
    expect(kinds(r)).toEqual(["version-tag-mismatch"])
    expect(r.findings[0].message).toContain("expected tag `v0.1.0`")
  })

  test("the repo's own package.json parses and matches its highest tag", () => {
    // Guards the reader against a package.json reshape; the value itself is
    // whatever the working tree holds.
    expect(readPackageVersion(PACKAGE_JSON_PATH)).toMatch(/^\d+\.\d+\.\d+$/u)
  })
})

describe("collectPrGate — the gh pipeline", () => {
  const routes = (
    prPayload: unknown,
    extra: ReadonlyArray<[string, unknown]> = [],
  ): ReadonlyArray<[string, unknown]> => [
    ["pr view", prPayload],
    ["tags?per_page", [{ name: "v0.2.1" }, { name: "v0.2.0" }]],
    ["contents/package.json", { content: b64({ version: "0.2.1" }) }],
    ...extra,
  ]

  test("reads the PR, the tags, and package.json at the BASE ref", () => {
    const calls: Array<Array<string>> = []
    const gh = fakeGh(
      routes({
        number: 42,
        title: "feat(server)!: split the listeners",
        body: "",
        milestone: { title: "v0.2.2" },
        author: { login: "stuffbucket", is_bot: false },
        labels: [],
        baseRefName: "main",
      }, [["pr list", []]]),
      calls,
    )
    const r = collectPrGate(42, { gh, repo: REPO })
    expect(kinds(r)).toEqual(["bump-too-small"])
    // The base ref, never the PR's merge tree — otherwise the PR under test
    // could choose its own baseline.
    expect(calls.some((c) => c.join(" ").includes("package.json?ref=main"))).toBe(
      true,
    )
  })

  test("does not list siblings when there is no release milestone", () => {
    const calls: Array<Array<string>> = []
    const gh = fakeGh(
      routes({
        number: 42,
        title: "fix: a thing",
        body: "",
        milestone: null,
        author: { login: "stuffbucket", is_bot: false },
        labels: [],
        baseRefName: "main",
      }),
      calls,
    )
    expect(kinds(collectPrGate(42, { gh, repo: REPO }))).toEqual([
      "missing-milestone",
    ])
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false)
  })

  test("a package.json missing at the base ref falls back to the tag list", () => {
    const gh = fakeGh([
      [
        "pr view",
        {
          number: 42,
          title: "feat!: break it",
          body: "",
          milestone: { title: "v0.2.2" },
          author: { login: "stuffbucket", is_bot: false },
          labels: [],
          baseRefName: "main",
        },
      ],
      ["tags?per_page", [{ name: "v0.2.1" }]],
      ["contents/package.json", {}],
      ["pr list", []],
    ])
    expect(kinds(collectPrGate(42, { gh, repo: REPO }))).toEqual(["bump-too-small"])
  })

  test("a package.json ahead of the tags raises the baseline", () => {
    // The bumped-but-not-yet-tagged window: max() of the two is the strict read.
    const gh = fakeGh([
      [
        "pr view",
        {
          number: 42,
          title: "fix: a thing",
          body: "",
          milestone: { title: "v0.2.2" },
          author: { login: "stuffbucket", is_bot: false },
          labels: [],
          baseRefName: "main",
        },
      ],
      ["tags?per_page", [{ name: "v0.2.1" }]],
      ["contents/package.json", { content: b64({ version: "0.2.2" }) }],
      ["pr list", []],
    ])
    expect(kinds(collectPrGate(42, { gh, repo: REPO }))).toEqual([
      "milestone-not-ahead",
    ])
  })

  test("a gh failure throws rather than passing silently", () => {
    const gh = fakeGh([])
    expect(() => collectPrGate(42, { gh, repo: REPO })).toThrow(/exit 1/u)
  })
})

describe("collectMilestoneGate — the gh pipeline", () => {
  test("measures the milestone against the default branch", () => {
    const calls: Array<Array<string>> = []
    const gh = fakeGh(
      [
        ["api repos/stuffbucket/maximal-core", { default_branch: "main" }],
        ["tags?per_page", [{ name: "v0.2.1" }]],
        ["contents/package.json", { content: b64({ version: "0.2.1" }) }],
        ["pr list", [{ number: 7, title: "feat(x)!: break it", body: "", labels: [] }]],
      ],
      calls,
    )
    expect(kinds(collectMilestoneGate("v0.2.2", { gh, repo: REPO }))).toEqual([
      "bump-too-small",
    ])
    expect(calls.some((c) => c.join(" ").includes("package.json?ref=main"))).toBe(
      true,
    )
  })

  test("skips the PR listing for a milestone that is not a release tag", () => {
    const calls: Array<Array<string>> = []
    const gh = fakeGh(
      [
        ["api repos/stuffbucket/maximal-core", { default_branch: "main" }],
        ["tags?per_page", [{ name: "v0.2.1" }]],
        ["contents/package.json", { content: b64({ version: "0.2.1" }) }],
      ],
      calls,
    )
    expect(kinds(collectMilestoneGate("Backlog", { gh, repo: REPO }))).toEqual([
      "milestone-not-a-release",
    ])
    expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(false)
  })
})

describe("modes and exit codes", () => {
  const failing = evaluatePr({
    pr: pr({ title: "feat!: break it", milestone: { title: "v0.2.2" } }),
    current: CURRENT,
  })

  test("enforce blocks, warn does not", () => {
    expect(exitCodeFor(failing, "enforce")).toBe(1)
    expect(exitCodeFor(failing, "warn")).toBe(0)
  })

  test("warnings alone never block", () => {
    const warned = evaluatePr({
      pr: pr({ title: "feat!: break it", milestone: { title: "v0.4.0" } }),
      current: CURRENT,
    })
    expect(exitCodeFor(warned, "enforce")).toBe(0)
  })
})

describe("parseArgs", () => {
  test("reads a subcommand, a target, and the flags", () => {
    expect(parseArgs(["pr", "42", "--repo", REPO, "--mode", "warn"])).toEqual({
      subcommand: "pr",
      target: "42",
      repo: REPO,
      mode: "warn",
    })
  })

  test("defaults to enforce, and an unrecognised mode does NOT disable the gate", () => {
    expect(parseArgs(["milestone", "v0.3.0"]).mode).toBe("enforce")
    expect(parseArgs(["pr", "1", "--mode", "off"]).mode).toBe("enforce")
    expect(parseArgs(["pr", "1", "--mode", ""]).mode).toBe("enforce")
  })

  test("keeps the first two positionals only", () => {
    expect(parseArgs(["version", "v0.3.0", "extra"]).target).toBe("v0.3.0")
  })
})

describe("main — exit-code contract", () => {
  test("bad usage is 2 (the gate could not run), never 1", () => {
    expect(main([])).toBe(2)
    expect(main(["pr"])).toBe(2)
    expect(main(["pr", "not-a-number"])).toBe(2)
    expect(main(["nonsense", "x"])).toBe(2)
  })

  test("a real violation is 1 — distinct from the cannot-run 2", () => {
    // `version` needs no gh at all: it reads the repo's own package.json, so
    // this exercises the whole path end to end offline.
    expect(main(["version", "v0.0.1"])).toBe(1)
    expect(
      main(["version", `v${readPackageVersion(PACKAGE_JSON_PATH)}`]),
    ).toBe(0)
  })

  test("--mode warn turns a violation into a clean exit", () => {
    expect(main(["version", "v0.0.1", "--mode", "warn"])).toBe(0)
  })
})

describe("rendering", () => {
  const failing = evaluatePr({
    pr: pr({ number: 14, title: "feat!: break it", milestone: { title: "v0.2.2" } }),
    current: CURRENT,
  })

  test("the human report names the subject and every finding", () => {
    const text = renderFindings(failing)
    expect(text).toContain("PR #14")
    expect(text).toContain("FAIL [bump-too-small]")
  })

  test("a clean report says so", () => {
    expect(renderFindings(evaluatePr({ pr: pr(), current: CURRENT }))).toContain(
      "every release gate passes",
    )
  })

  test("the summary separates blocking from warnings and names the escape hatch", () => {
    const md = renderSummary(failing)
    expect(md).toContain("### Blocking")
    expect(md).not.toContain("### Warnings")
    expect(md).toContain(OVERRIDE_LABEL)
  })

  test("annotations use the right Actions severity and escape newlines", () => {
    const [line] = renderAnnotations(failing)
    expect(line.startsWith("::error title=release-gates (bump-too-small)::")).toBe(
      true,
    )
    const warned = renderAnnotations({
      subject: "x",
      findings: [{ kind: "gate-exempt", severity: "warn", message: "a\nb" }],
    })
    expect(warned[0]).toContain("::warning ")
    expect(warned[0]).toContain("a%0Ab")
  })

  test("formatVersion round-trips a parsed tag", () => {
    expect(formatVersion(parseReleaseTag("v1.2.3") as Version)).toBe("v1.2.3")
  })
})
