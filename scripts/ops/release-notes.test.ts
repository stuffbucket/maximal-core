import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import {
  buildReleaseNotes,
  collectReleaseNotes,
  exitCodeFor,
  findMilestone,
  type GhResult,
  type GhRunner,
  parseArgs,
  parseConventionalTitle,
  PR_PAGE_LIMIT,
  previousTagFor,
  type PullRequest,
  renderChangelog,
  renderEntry,
  renderProblems,
  renderReleaseBody,
  SECTIONS,
  sortKey,
} from "./release-notes"

// Offline and deterministic: every `gh` call goes through the injected
// GhRunner, so this suite never shells out, never hits the network, and never
// depends on a milestone existing. The one filesystem read is the real
// CHANGELOG.md, used as a FORMAT GUARD — if the generator's output shape ever
// stops matching the file it is meant to append to, this suite reds.

const REPO = "stuffbucket/maximal-core"

const merged = (
  number: number,
  title: string,
  extra: Partial<PullRequest> = {},
): PullRequest => ({
  number,
  title,
  state: "MERGED",
  mergedAt: "2026-08-01T00:00:00Z",
  mergeCommit: { oid: `${String(number).repeat(2)}0abcdef1234567890abcdef1234567890ab`.slice(0, 40) },
  ...extra,
})

/** `previousTag: null` models a first release (no compare link). */
const build = (
  prs: ReadonlyArray<PullRequest>,
  previousTag: string | null = "v0.2.0",
) =>
  buildReleaseNotes({
    tag: "v0.2.1",
    repo: REPO,
    date: "2026-08-05",
    previousTag: previousTag ?? undefined,
    prs,
  })

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

describe("parseConventionalTitle", () => {
  test("parses type, scope, and description", () => {
    expect(parseConventionalTitle("feat(control): add api-keys endpoint")).toEqual({
      type: "feat",
      scope: "control",
      breaking: false,
      description: "add api-keys endpoint",
    })
  })

  test("parses a scopeless title", () => {
    expect(parseConventionalTitle("fix: stop the leak")).toEqual({
      type: "fix",
      scope: undefined,
      breaking: false,
      description: "stop the leak",
    })
  })

  test("marks a `!` title as breaking, with or without a scope", () => {
    expect(parseConventionalTitle("feat(api)!: drop v1")?.breaking).toBe(true)
    expect(parseConventionalTitle("feat!: drop v1")?.breaking).toBe(true)
  })

  test("rejects titles that are not conventional commits", () => {
    for (const bad of [
      "add a thing",
      "Feat: capitalised type",
      "feat:missing space",
      "feat(scope) missing colon",
      "feat: ",
      "chore(deps): bump\nfeat(x): two commits", // multi-line is not single
    ]) {
      expect(parseConventionalTitle(bad)).toBeUndefined()
    }
  })
})

describe("buildReleaseNotes — grouping", () => {
  test("groups by type into CHANGELOG sections, in SECTIONS order", () => {
    const notes = build([
      merged(1, "chore(deps): bump bun"),
      merged(2, "fix(auth): tear down the refresh loop"),
      merged(3, "feat(control): add api-keys"),
      merged(4, "docs: rewrite the runbook"),
      merged(5, "perf(warmup): short-circuit locally"),
    ])
    expect(notes.sections.map((s) => s.heading)).toEqual([
      "Features",
      "Bug Fixes",
      "Performance Improvements",
      "Documentation",
      "Miscellaneous Chores",
    ])
    expect(notes.problems).toEqual([])
  })

  test("covers every type the repo uses", () => {
    const types = ["feat", "fix", "refactor", "build", "docs", "test", "chore"]
    const notes = build(
      types.map((t, i) => merged(i + 1, `${t}(scope): thing ${i}`)),
    )
    expect(notes.sections).toHaveLength(types.length)
    for (const t of types) {
      expect(SECTIONS.some((s) => s.type === t)).toBe(true)
    }
  })

  test("sorts within a section by scope then description, case-insensitively", () => {
    const notes = build([
      merged(1, "feat: Windows tray parity"),
      merged(2, "feat(shell): warn to restart"),
      merged(3, "feat(claude-code): route via settings.json"),
      merged(4, "feat: Claude Code routing"),
    ])
    expect(notes.sections[0].entries.map((e) => e.number)).toEqual([4, 3, 2, 1])
  })

  test("sortKey folds scope and description into one case-insensitive key", () => {
    expect(
      sortKey({
        type: "feat",
        scope: "Site",
        breaking: false,
        description: "Hydrate",
        number: 1,
        closes: [],
      }),
    ).toBe("site: hydrate")
  })

  test("collects breaking changes into their own list and keeps them in-section", () => {
    const notes = build([merged(1, "feat(api)!: drop the v1 surface")])
    expect(notes.breaking.map((e) => e.number)).toEqual([1])
    expect(notes.sections[0].heading).toBe("Features")
    expect(notes.sections[0].entries).toHaveLength(1)
  })
})

describe("buildReleaseNotes — problem flagging", () => {
  test("flags a non-conforming PR title and drops it from the output", () => {
    const notes = build([
      merged(1, "feat(control): add api-keys"),
      merged(2, "just some words"),
    ])
    expect(notes.sections[0].entries.map((e) => e.number)).toEqual([1])
    expect(notes.problems).toHaveLength(1)
    expect(notes.problems[0]).toMatchObject({
      kind: "non-conforming-title",
      number: 2,
      fatal: false,
    })
    expect(exitCodeFor(notes)).toBe(1)
  })

  test("flags a conventional title whose type has no section", () => {
    const notes = build([
      merged(1, "feat: ok"),
      merged(2, "wip(control): half a thing"),
    ])
    expect(notes.problems[0]).toMatchObject({ kind: "unknown-type", number: 2 })
    expect(exitCodeFor(notes)).toBe(1)
  })

  test("flags an open PR and a closed-unmerged PR without rendering them", () => {
    const notes = build([
      merged(1, "feat: ok"),
      { number: 2, title: "feat: pending", state: "OPEN" },
      { number: 3, title: "feat: abandoned", state: "CLOSED", mergedAt: null },
    ])
    expect(notes.problems.map((p) => p.kind)).toEqual([
      "open-pr",
      "closed-unmerged",
    ])
    expect(notes.sections[0].entries.map((e) => e.number)).toEqual([1])
  })

  test("an empty milestone is fatal", () => {
    const notes = build([])
    expect(notes.problems).toHaveLength(1)
    expect(notes.problems[0]).toMatchObject({
      kind: "empty-milestone",
      fatal: true,
    })
    expect(exitCodeFor(notes)).toBe(2)
    expect(notes.sections).toEqual([])
  })

  test("a milestone whose PRs are all unusable is fatal, not silently empty", () => {
    const notes = build([merged(1, "no convention here")])
    expect(notes.problems.map((p) => p.kind)).toEqual([
      "non-conforming-title",
      "empty-milestone",
    ])
    expect(exitCodeFor(notes)).toBe(2)
  })

  test("a clean milestone exits 0", () => {
    expect(exitCodeFor(build([merged(1, "feat: ok")]))).toBe(0)
  })

  test("renderProblems labels fatal and non-fatal, and is empty when clean", () => {
    const report = renderProblems(build([merged(1, "nope")]).problems)
    expect(report).toContain("WARN  [non-conforming-title]")
    expect(report).toContain("FATAL [empty-milestone]")
    expect(renderProblems([])).toBe("")
  })
})

describe("rendering", () => {
  test("renders a bullet exactly like release-please did", () => {
    const notes = build([
      merged(296, "fix(ci): push updates manifest as app-repoman", {
        mergeCommit: { oid: "ec7822b82f0212e9250c6871c341c5aebc425f7c" },
      }),
    ])
    expect(renderEntry(notes.sections[0].entries[0], REPO)).toBe(
      "* **ci:** push updates manifest as app-repoman " +
        `([#296](https://github.com/${REPO}/issues/296)) ` +
        `([ec7822b](https://github.com/${REPO}/commit/ec7822b82f0212e9250c6871c341c5aebc425f7c))`,
    )
  })

  test("appends `closes` links for the issues a PR closed", () => {
    const notes = build([
      merged(273, "feat(site): hydrate download links", {
        mergeCommit: { oid: "1bdac36fe82031e9cf0113dc0ded631c223b0176a" },
        closingIssuesReferences: [{ number: 218 }, { number: 219 }],
      }),
    ])
    expect(renderEntry(notes.sections[0].entries[0], REPO)).toEndWith(
      `, closes [#218](https://github.com/${REPO}/issues/218) [#219](https://github.com/${REPO}/issues/219)`,
    )
  })

  test("omits the commit link when the merge sha is unknown", () => {
    const notes = build([
      merged(12, "feat: thing", { mergeCommit: null }),
    ])
    const line = renderEntry(notes.sections[0].entries[0], REPO)
    expect(line).toBe(`* thing ([#12](https://github.com/${REPO}/issues/12))`)
    expect(line).not.toContain("/commit/")
  })

  test("renders the CHANGELOG header with a compare link and release-please whitespace", () => {
    const md = renderChangelog(
      build([merged(1, "feat(a): one"), merged(2, "fix(b): two")]),
    )
    const lines = md.split("\n")
    expect(lines[0]).toBe(
      `## [0.2.1](https://github.com/${REPO}/compare/v0.2.0...v0.2.1) (2026-08-05)`,
    )
    expect(lines[1]).toBe("")
    expect(lines[2]).toBe("")
    expect(lines[3]).toBe("### Features")
    expect(lines[4]).toBe("")
    expect(lines[5]).toStartWith("* **a:** one ")
    expect(lines[6]).toBe("")
    expect(lines[7]).toBe("")
    expect(lines[8]).toBe("### Bug Fixes")
    expect(md).toEndWith("\n")
  })

  test("a first release renders an unlinked header instead of a broken compare URL", () => {
    const md = renderChangelog(build([merged(1, "feat: first")], null))
    expect(md.split("\n")[0]).toBe("## 0.2.1 (2026-08-05)")
    expect(md).not.toContain("/compare/")
  })

  test("puts breaking changes first, under release-please's heading", () => {
    const md = renderChangelog(
      build([merged(1, "feat(api)!: drop v1"), merged(2, "fix(b): two")]),
    )
    expect(md.split("\n")[3]).toBe("### ⚠ BREAKING CHANGES")
    expect(md.indexOf("BREAKING")).toBeLessThan(md.indexOf("### Features"))
  })

  test("the release body drops the version header and adds a full-changelog link", () => {
    const body = renderReleaseBody(build([merged(1, "feat(a): one")]))
    expect(body).toStartWith("### Features\n")
    expect(body).not.toContain("## 0.2.1")
    expect(body).toEndWith(
      `**Full Changelog**: https://github.com/${REPO}/compare/v0.2.0...v0.2.1\n`,
    )
  })

  test("the release body omits the footer when there is no previous tag", () => {
    const body = renderReleaseBody(build([merged(1, "feat(a): one")], null))
    expect(body).not.toContain("Full Changelog")
  })
})

describe("CHANGELOG.md format parity", () => {
  // Guard: the generated block must be indistinguishable from what is already
  // in the file, so a release can be pasted straight in.
  const changelogPath = path.join(import.meta.dir, "..", "..", "CHANGELOG.md")

  test("generated headings all appear verbatim in the existing CHANGELOG", async () => {
    const existing = await fs.readFile(changelogPath, "utf8")
    const used = new Set(
      [...existing.matchAll(/^### (.+)$/gmu)].map((m) => m[1]),
    )
    for (const heading of used) {
      expect(SECTIONS.some((s) => s.heading === heading)).toBe(true)
    }
    expect(used.size).toBeGreaterThan(0)
  })

  test("a generated block matches the shape of a real CHANGELOG block", async () => {
    const existing = await fs.readFile(changelogPath, "utf8")
    const real = existing.split("\n").slice(2, 9).join("\n")
    const generated = renderChangelog(
      buildReleaseNotes({
        tag: "v0.4.41",
        repo: "stuffbucket/maximal",
        date: "2026-07-10",
        previousTag: "v0.4.40",
        prs: [
          merged(
            296,
            "fix(ci): push updates manifest as app-repoman to clear require-PR ruleset",
            { mergeCommit: { oid: "ec7822b82f0212e9250c6871c341c5aebc425f7c" } },
          ),
        ],
      }),
    )
    // Same header line, same two blank lines, same heading, same first bullet.
    expect(generated.split("\n").slice(0, 5)).toEqual(
      real.split("\n").slice(0, 5),
    )
  })
})

describe("previousTagFor", () => {
  test("picks the highest tag strictly below the release tag", () => {
    expect(
      previousTagFor(["v0.1.0", "v0.2.0", "v0.2.1", "v0.3.0"], "v0.2.1"),
    ).toBe("v0.2.0")
  })

  test("ignores the tag itself and anything newer", () => {
    expect(previousTagFor(["v0.2.1", "v9.0.0"], "v0.2.1")).toBeUndefined()
  })

  test("returns undefined for a first release", () => {
    expect(previousTagFor([], "v0.1.0")).toBeUndefined()
  })
})

describe("parseArgs", () => {
  test("reads the tag positionally, before or after flags", () => {
    expect(parseArgs(["v0.2.1"]).tag).toBe("v0.2.1")
    expect(parseArgs(["--force", "v0.2.1"]).tag).toBe("v0.2.1")
    expect(parseArgs(["--repo", "a/b", "v0.2.1"]).tag).toBe("v0.2.1")
  })

  test("does not mistake a flag's value for the tag", () => {
    expect(parseArgs(["--repo", "a/b"]).tag).toBeUndefined()
    expect(parseArgs(["--previous", "v0.2.0"]).tag).toBeUndefined()
    expect(parseArgs(["--date", "2026-08-05"]).tag).toBeUndefined()
  })

  test("reads every flag", () => {
    expect(
      parseArgs([
        "v0.2.1",
        "--repo",
        "a/b",
        "--previous",
        "v0.2.0",
        "--date",
        "2026-08-05",
        "--release-body",
        "--force",
      ]),
    ).toEqual({
      tag: "v0.2.1",
      repo: "a/b",
      previous: "v0.2.0",
      date: "2026-08-05",
      releaseBody: true,
      force: true,
    })
  })
})

describe("collection through the injected gh runner", () => {
  const milestones = [
    { number: 4, title: "v0.2.0", state: "closed" },
    { number: 5, title: "v0.2.1", state: "open" },
  ]

  test("resolves repo, milestone, PRs, and previous tag with no network", () => {
    const calls: Array<Array<string>> = []
    const gh = fakeGh(
      [
        ["repo view", { nameWithOwner: REPO }],
        ["milestones", milestones],
        ["pr list", [merged(12, "feat(control): add api-keys endpoint")]],
        ["tags", [{ name: "v0.1.0" }, { name: "v0.2.0" }]],
      ],
      calls,
    )
    const notes = collectReleaseNotes({ tag: "v0.2.1", gh })
    expect(notes.repo).toBe(REPO)
    expect(notes.previousTag).toBe("v0.2.0")
    expect(notes.sections[0].entries[0].number).toBe(12)
    expect(exitCodeFor(notes)).toBe(0)
    // the milestone filter reaches gh as a search qualifier
    expect(calls.some((c) => c.includes('milestone:"v0.2.1"'))).toBe(true)
  })

  test("defaults the date to today when not supplied", () => {
    const gh = fakeGh([
      ["repo view", { nameWithOwner: REPO }],
      ["milestones", milestones],
      ["pr list", [merged(12, "feat: x")]],
      ["tags", []],
    ])
    const notes = collectReleaseNotes({
      tag: "v0.2.1",
      gh,
      now: () => new Date("2026-08-05T12:00:00Z"),
    })
    expect(notes.date).toBe("2026-08-05")
  })

  test("explicit repo, previous tag, and date skip their gh lookups", () => {
    const calls: Array<Array<string>> = []
    const gh = fakeGh(
      [
        ["milestones", milestones],
        ["pr list", [merged(12, "feat: x")]],
      ],
      calls,
    )
    const notes = collectReleaseNotes({
      tag: "v0.2.1",
      gh,
      repo: REPO,
      previousTag: "v0.2.0",
      date: "2026-08-05",
    })
    expect(notes.previousTag).toBe("v0.2.0")
    expect(calls.some((c) => c.includes("view"))).toBe(false)
    expect(calls.some((c) => c.join(" ").includes("tags"))).toBe(false)
  })

  test("a missing milestone throws and names the ones that exist", () => {
    const gh = fakeGh([["milestones", milestones]])
    expect(() => findMilestone(gh, REPO, "v9.9.9")).toThrow(
      /no milestone titled `v9\.9\.9`.*v0\.2\.0, v0\.2\.1/su,
    )
  })

  test("a failing gh call surfaces its stderr rather than an empty result", () => {
    const gh: GhRunner = () => ({
      status: 4,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
    })
    expect(() => collectReleaseNotes({ tag: "v0.2.1", gh, repo: REPO })).toThrow(
      /exit 4: gh: Not Found/u,
    )
  })

  test("unparseable gh output is an error, not a crash", () => {
    const gh: GhRunner = () => ({ status: 0, stdout: "<html>", stderr: "" })
    expect(() => collectReleaseNotes({ tag: "v0.2.1", gh, repo: REPO })).toThrow(
      /unparseable JSON/u,
    )
  })

  test("hitting the PR page limit is reported, never silently truncated", () => {
    const many = Array.from({ length: PR_PAGE_LIMIT }, (_, i) =>
      merged(i + 1, `feat: thing ${i}`),
    )
    const gh = fakeGh([
      ["milestones", milestones],
      ["pr list", many],
    ])
    const notes = collectReleaseNotes({
      tag: "v0.2.1",
      gh,
      repo: REPO,
      previousTag: "v0.2.0",
      date: "2026-08-05",
    })
    expect(notes.problems.map((p) => p.kind)).toEqual(["truncated"])
    expect(exitCodeFor(notes)).toBe(1)
  })
})
