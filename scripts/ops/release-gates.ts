#!/usr/bin/env bun
/**
 * Release gates — the three conventions in `docs/release-runbook.md`, checked
 * by a machine instead of by memory.
 *
 * The runbook's release model is "a release is a GitHub milestone whose title
 * IS the tag" (see `release-notes.ts`). Three rules hold that model together,
 * and until this file every one of them was upheld by human discipline alone:
 *
 *   1. **A PR carries a release milestone.** Without one it silently ships in
 *      whatever release is cut next and never appears in generated notes,
 *      because `release:notes` only ever sees the PRs in the milestone.
 *   2. **A breaking change is bumped to a MINOR, not a patch.** Pre-1.0 this
 *      repo's rule is feat/fix → patch, `feat!:`/`fix!:` → minor. That is not
 *      cosmetic: a consumer's `^0.2.0` resolves to `>=0.2.0 <0.3.0`, so a
 *      breaking change released as a patch is AUTO-INSTALLED on a routine
 *      update. This repo publishes `./supervisor` and `./control-contract`,
 *      consumed outside the repo — PR #14 removed `port` from the published
 *      `ReadyLine` type and was initially bucketed as a patch. Caught by hand;
 *      this gate is what catches it next time.
 *   3. **A tag matches `package.json`'s version.** Already gone wrong:
 *      `git show v0.1.1:package.json` reads `0.1.0`.
 *   4. **A tag is greater than every tag that already exists.** Nothing asserted
 *      this at all: gate 2 compares a milestone against the released version at
 *      the moment the CHECK runs, which is not the moment the TAG is pushed. Two
 *      releases prepared concurrently can therefore land in either order, and a
 *      lower tag carrying more content cannot be repaired afterwards — see
 *      `evaluateTagOrder`.
 *   5. **Nothing that claims to ship in this release is still open.** Held up
 *      only as a side effect of `release:notes` refusing to emit, which
 *      `release.ts` skips entirely when the changelog entry already exists —
 *      see `evaluateOpenPrs`.
 *
 * Five subcommands, one per convention plus the release-time aggregate:
 *
 *   pr <number>        gates 1 + 2 for one PR (the PR-time workflow)
 *   milestone <vX.Y.Z> gates 2 + 5 across a milestone (release preflight)
 *   order <vX.Y.Z>     gate 4 (local + remote tags; `--pushed` for a tripwire)
 *   version <vX.Y.Z>   gate 3 (tag vs package.json — preflight + tag tripwire)
 *
 * Usage:
 *   bun run release:check pr 42
 *   bun run release:check milestone v0.3.0
 *   bun run release:check order v0.3.0
 *   bun run release:check version v0.3.0
 *   bun run release:check pr 42 --repo stuffbucket/maximal-core --mode warn
 *
 * Exit codes: 0 clean (or `--mode warn`) · 1 a blocking finding · 2 the gate
 * could not run (bad usage, `gh` failure, unreadable package.json). Callers
 * MUST treat 2 as "not blocking" — a gate that fails closed on its own bugs
 * takes the repo down with it. `release-gates.yml` does exactly that.
 *
 * `release.ts` is the exception, and deliberately so: it runs gates 4 and 5
 * itself before `bumpp`, where a 2 means "refused, nothing happened" rather than
 * "the repo is wedged". Nothing downstream of that point is reversible.
 *
 * Escape hatches, in increasing blast radius:
 *   - `release-gate-override` label on one PR → every finding downgraded to a
 *     warning, with the reason printed.
 *   - `--mode warn` → nothing blocks (the workflow reads this from the
 *     `RELEASE_GATES_MODE` repo variable, so a misfiring gate is defused in
 *     seconds without a PR).
 *
 * All GitHub access goes through `release-notes.ts`'s single injectable
 * `GhRunner` and all repository access through `check-bindings.ts`'s `GitRunner`,
 * so every test here runs offline with no network, no repository and no
 * `mock.module`.
 */

import { Buffer } from "node:buffer"
import fs from "node:fs"
import path from "node:path"

import { type GitRunner, realGit } from "./check-bindings"
import {
  type GhRunner,
  ghJson,
  type ParsedTitle,
  parseConventionalTitle,
  realGh,
} from "./release-notes"
import { parseSemver, semverGt } from "./watch-external-drift"

// --- versions ---

export type Version = readonly [number, number, number]

export type BumpLevel = "major" | "minor" | "patch"

/** Ordering for "is the requested bump at least as big as the required one". */
const BUMP_RANK: Record<BumpLevel, number> = { patch: 1, minor: 2, major: 3 }

/**
 * A milestone title is a release tag only if it is EXACTLY `vX.Y.Z`.
 * `parseSemver` is deliberately lenient (it turns `v0.3` into `[0,3,0]` and
 * `Backlog` into `[0,0,0]`), which is right for comparing upstream release
 * tags in the drift watcher and catastrophically wrong here: a milestone named
 * `Backlog` would parse as `0.0.0` and read as "below the current version"
 * instead of "not a release milestone at all". So the shape is checked first.
 */
export const RELEASE_TAG_RE = /^v(?:\d+)\.(?:\d+)\.(?:\d+)$/u

/** `v0.3.0` → `[0,3,0]`. Undefined for anything that is not a release tag. */
export function parseReleaseTag(title: string): Version | undefined {
  const trimmed = title.trim()
  if (!RELEASE_TAG_RE.test(trimmed)) return undefined
  return parseSemver(trimmed)
}

export function formatVersion(v: Version): string {
  return `v${v[0]}.${v[1]}.${v[2]}`
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/**
 * The level of the HIGHEST component that increased between `current` and
 * `target`, or `not-ahead` when `target` does not exceed `current`.
 *
 * Classifying by highest-changed component (rather than by "is this the next
 * version") is the load-bearing detail. `0.2.1 → 0.2.5` skips four patches but
 * is still a PATCH-level move — it stays inside a consumer's `^0.2.x` range, so
 * a breaking change in it is exactly as dangerous as in `0.2.2`. Treating a
 * skip as "big enough" would let the case this gate exists for walk straight
 * through. Conversely `0.2.1 → 0.4.0` is a genuine minor: out of range, so the
 * upgrade is deliberate. Non-adjacency is reported separately, as a note.
 */
export function classifyBump(
  current: Version,
  target: Version,
): BumpLevel | "not-ahead" {
  if (target[0] !== current[0]) return target[0] > current[0] ? "major" : "not-ahead"
  if (target[1] !== current[1]) return target[1] > current[1] ? "minor" : "not-ahead"
  if (target[2] !== current[2]) return target[2] > current[2] ? "patch" : "not-ahead"
  return "not-ahead"
}

/** True when `target` is the immediate next version at `level`. */
export function isAdjacent(
  current: Version,
  target: Version,
  level: BumpLevel,
): boolean {
  if (level === "patch") return target[2] === current[2] + 1
  if (level === "minor") return target[1] === current[1] + 1 && target[2] === 0
  return target[0] === current[0] + 1 && target[1] === 0 && target[2] === 0
}

/**
 * The smallest bump a PR may legally ship in.
 *
 * Pre-1.0 (`current[0] === 0`) the rule is feat/fix → patch, breaking → minor,
 * because `^0.2.0` is `>=0.2.0 <0.3.0` and only a minor leaves that range. This
 * function is the executable record of that convention (with the *Choosing the
 * version* table in `docs/release-runbook.md` as its prose counterpart); the
 * inert release-please config that used to declare it is gone.
 *
 * At 1.0 that convention stops being the safe one: `^1.2.0` is `>=1.2.0 <2.0.0`
 * so it is MAJOR that leaves the range, and a minor no longer protects anyone.
 * The rule therefore keys off the current major rather than hardcoding the
 * pre-1.0 table, so this gate does not silently start permitting breaking
 * patches the day the repo cuts 1.0.0.
 */
export function requiredBump(title: ParsedTitle, current: Version): BumpLevel {
  if (current[0] === 0) return title.breaking ? "minor" : "patch"
  if (title.breaking) return "major"
  return title.type === "feat" ? "minor" : "patch"
}

/**
 * A Conventional Commit `BREAKING CHANGE:` footer in the PR body.
 *
 * The TITLE is authoritative for the bump everywhere else in this repo:
 * squash-merge makes it the commit subject and `release-notes.ts` parses titles
 * only, so a body-only breaking marker never reaches the changelog's
 * `BREAKING CHANGES` block. That asymmetry is itself the bug worth catching —
 * a body footer with no `!` in the title is reported (`breaking-marker-mismatch`)
 * AND counted as breaking for bump purposes, so the release can never be
 * under-bumped while the two disagree.
 *
 * Matched as a real footer (line-start, uppercase, colon-space) rather than
 * anywhere in prose, per the Conventional Commits spec.
 */
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:[ \t]/mu

export function hasBreakingFooter(body: string | null | undefined): boolean {
  return BREAKING_FOOTER_RE.test(body ?? "")
}

// --- findings ---

export type Severity = "error" | "warn"

export type FindingKind =
  | "breaking-marker-mismatch"
  | "bump-too-small"
  | "empty-milestone"
  | "gate-exempt"
  | "milestone-not-a-release"
  | "milestone-not-ahead"
  | "missing-milestone"
  | "non-adjacent-bump"
  | "non-conforming-title"
  | "open-pr-earlier-release"
  | "open-pr-in-release"
  | "open-pr-unmilestoned"
  | "prerelease-above-tag"
  | "tag-already-exists"
  | "tag-not-a-release"
  | "tag-not-highest"
  | "version-tag-mismatch"

export interface Finding {
  kind: FindingKind
  severity: Severity
  /** PR number, when the finding is about one PR. */
  number?: number
  message: string
}

export interface GateReport {
  /** One line naming what was checked, for the report header. */
  subject: string
  findings: ReadonlyArray<Finding>
}

export type Mode = "enforce" | "warn"

/** 0 clean (or warn mode) · 1 a blocking finding. Never 2 — that is `main`'s. */
export function exitCodeFor(report: GateReport, mode: Mode): number {
  if (mode === "warn") return 0
  return report.findings.some((f) => f.severity === "error") ? 1 : 0
}

function downgrade(findings: ReadonlyArray<Finding>): Array<Finding> {
  return findings.map((f) => ({ ...f, severity: "warn" as const }))
}

// --- PR shape ---

/** The PR fields the gates read (a subset of `gh pr view --json`). */
export interface GatePullRequest {
  number: number
  title: string
  body?: string | null
  milestone?: { title: string } | null
  author?: { login?: string; is_bot?: boolean } | null
  labels?: ReadonlyArray<{ name: string }>
}

/** Downgrades every finding on one PR to a warning. */
export const OVERRIDE_LABEL = "release-gate-override"

/**
 * A release commit ships the version bump itself and belongs to no milestone,
 * so gating it on one would deadlock the release it is cutting. Matches the
 * subject `docs/release-runbook.md` §4 prescribes.
 */
const RELEASE_COMMIT_RE = /^chore(?:\([\w-]+\))?: release v?\d+\.\d+\.\d+$/u

/** Why this PR is not gated, or undefined if it is. */
export function exemption(pr: GatePullRequest): string | undefined {
  if (RELEASE_COMMIT_RE.test(pr.title.trim())) return "release commit"
  if ((pr.labels ?? []).some((l) => l.name === OVERRIDE_LABEL)) {
    return `\`${OVERRIDE_LABEL}\` label`
  }
  return undefined
}

/**
 * Bot-authored PRs (Dependabot, renovate, the drift watcher) cannot set a
 * milestone — the API surface they use has no way to. Failing them on gate 1
 * would wedge every dependency bump on a maintainer action the bot is
 * structurally unable to take, so gate 1 is a WARNING for them. Gate 2 still
 * applies at full strength: a bot PR with a milestone is checked like any
 * other, and one without a milestone has nothing to check.
 */
export function isBot(pr: GatePullRequest): boolean {
  return pr.author?.is_bot === true || (pr.author?.login ?? "").endsWith("[bot]")
}

// --- gate 1 + 2 (pure) ---

/** Milestone-level findings: is this milestone a legal next version at all? */
export function evaluateMilestoneVersion(
  milestoneTitle: string,
  target: Version,
  current: Version,
): Array<Finding> {
  const level = classifyBump(current, target)
  if (level === "not-ahead") {
    return [
      {
        kind: "milestone-not-ahead",
        severity: "error",
        message: `milestone \`${milestoneTitle}\` is not ahead of the current released version \`${formatVersion(current)}\` — that release is already out (or the number is wrong). Retarget to the next unreleased milestone.`,
      },
    ]
  }
  if (!isAdjacent(current, target, level)) {
    return [
      {
        kind: "non-adjacent-bump",
        severity: "warn",
        message: `milestone \`${milestoneTitle}\` skips versions: \`${formatVersion(current)}\` → \`${formatVersion(target)}\` is a ${level} bump but not the adjacent one. Legal, but confirm it is intentional.`,
      },
    ]
  }
  return []
}

/**
 * Per-PR findings for a set of PRs that all ship in `target`. Severity is left
 * at `error`; callers downgrade (see `evaluatePr`, which does so for siblings).
 * Exempt PRs are skipped entirely — an override on a PR must not resurface as a
 * finding on its neighbour.
 */
export function evaluatePrBumps(
  prs: ReadonlyArray<GatePullRequest>,
  target: Version,
  milestoneTitle: string,
  current: Version,
): Array<Finding> {
  const findings: Array<Finding> = []
  const level = classifyBump(current, target)
  // `not-ahead` is already reported once at milestone level; comparing each PR
  // against a version that went backwards would say the same thing N times.
  if (level === "not-ahead") return findings

  for (const pr of prs) {
    if (exemption(pr)) continue

    const parsed = parseConventionalTitle(pr.title)
    if (!parsed) {
      findings.push({
        kind: "non-conforming-title",
        severity: "error",
        number: pr.number,
        message: `#${pr.number} title is not a single Conventional Commit: ${JSON.stringify(pr.title)} — expected \`type(scope): description\`. Squash-merge makes it the commit subject and \`release:notes\` refuses to emit on it, so the required bump cannot be derived either.`,
      })
      continue
    }

    const footer = hasBreakingFooter(pr.body)
    if (footer && !parsed.breaking) {
      findings.push({
        kind: "breaking-marker-mismatch",
        severity: "error",
        number: pr.number,
        message: `#${pr.number} declares a \`BREAKING CHANGE:\` footer in its body but its title has no \`!\`. The changelog is generated from titles only, so the breaking change would ship unannounced — add \`!\` to the title (\`${parsed.type}${parsed.scope ? `(${parsed.scope})` : ""}!: …\`).`,
      })
    }

    const need = requiredBump(
      { ...parsed, breaking: parsed.breaking || footer },
      current,
    )
    if (BUMP_RANK[level] < BUMP_RANK[need]) {
      findings.push({
        kind: "bump-too-small",
        severity: "error",
        number: pr.number,
        message: `#${pr.number} (\`${pr.title}\`) requires a **${need}** bump, but milestone \`${milestoneTitle}\` is a ${level} on \`${formatVersion(current)}\`. A consumer's \`^${current.join(".")}\` covers \`${formatVersion(target)}\`, so this would be auto-installed on a routine update. Move the PR to a ${need} milestone.`,
      })
    }
  }
  return findings
}

export interface PrGateInput {
  pr: GatePullRequest
  /** Highest released version — see `fetchCurrentVersion`. */
  current: Version
  /**
   * Other PRs in the same milestone. Their violations surface here as
   * WARNINGS: when two PRs in one milestone disagree about the required bump,
   * the person who notices first is whoever opened the second one, and it is
   * cheaper to retarget the milestone then than at release time. They do not
   * block, because they are not this PR's to fix — `milestone` makes the same
   * findings blocking at the release boundary.
   */
  siblings?: ReadonlyArray<GatePullRequest>
}

/** Gates 1 and 2 for a single PR. Pure. */
export function evaluatePr(input: PrGateInput): GateReport {
  const { pr, current } = input
  const subject = `PR #${pr.number} — ${pr.title}`

  const exempt = exemption(pr)
  if (exempt) {
    return {
      subject,
      findings: [
        {
          kind: "gate-exempt",
          severity: "warn",
          number: pr.number,
          message: `#${pr.number} is exempt from the release gates (${exempt}). Nothing was checked.`,
        },
      ],
    }
  }

  const findings: Array<Finding> = []
  const bot = isBot(pr)
  const milestoneTitle = pr.milestone?.title
  const target = milestoneTitle ? parseReleaseTag(milestoneTitle) : undefined

  // Gate 1. A non-release milestone (`Backlog`, `v0.3`) fails HERE rather than
  // in gate 2: it satisfies "has a milestone" while shipping in no release and
  // appearing in no generated notes, which is the exact failure gate 1 exists
  // to prevent. Keeping it here also means gate 2 never has to report on a
  // milestone it could not parse — no double-reporting.
  if (!milestoneTitle) {
    findings.push({
      kind: "missing-milestone",
      severity: bot ? "warn" : "error",
      number: pr.number,
      message: `#${pr.number} has no milestone. Without one it ships in whatever release is cut next and never appears in \`release:notes\` output. Assign it: \`gh pr edit ${pr.number} --milestone vX.Y.Z\`.${bot ? " (Bot-authored, so this is a warning — a maintainer assigns the milestone before the release is cut.)" : ""}`,
    })
  } else if (!target) {
    findings.push({
      kind: "milestone-not-a-release",
      severity: bot ? "warn" : "error",
      number: pr.number,
      message: `#${pr.number} is assigned to milestone \`${milestoneTitle}\`, which is not a release tag. A release milestone's title IS the tag and must be exactly \`vX.Y.Z\` (no prerelease suffix — this tooling does not model one).`,
    })
  }

  // Gate 2, only once there is a version to check against.
  if (target && milestoneTitle) {
    findings.push(
      ...evaluateMilestoneVersion(milestoneTitle, target, current),
      ...evaluatePrBumps([pr], target, milestoneTitle, current),
      ...downgrade(
        evaluatePrBumps(
          (input.siblings ?? []).filter((s) => s.number !== pr.number),
          target,
          milestoneTitle,
          current,
        ),
      ),
    )
  } else if (!milestoneTitle) {
    // No milestone at all: still check the title, since it is a hard rule in
    // its own right (AGENTS.md) and `release:notes` refuses to emit on it.
    if (!parseConventionalTitle(pr.title)) {
      findings.push({
        kind: "non-conforming-title",
        severity: "error",
        number: pr.number,
        message: `#${pr.number} title is not a single Conventional Commit: ${JSON.stringify(pr.title)} — expected \`type(scope): description\`. It becomes the squash subject and the changelog line.`,
      })
    }
  }

  return { subject, findings }
}

export interface MilestoneGateInput {
  tag: string
  current: Version
  prs: ReadonlyArray<GatePullRequest>
}

/**
 * Gate 2 across a whole milestone — the release preflight. The milestone's
 * required bump is the MAX over its PRs, which is what makes disagreement
 * between siblings visible: one `feat!:` in a bag of `fix:`es forces the whole
 * milestone to a minor, and every PR is compared against the milestone
 * independently, so the max is enforced pointwise. Blocking, unlike the
 * advisory sibling pass in `evaluatePr`.
 */
export function evaluateMilestone(input: MilestoneGateInput): GateReport {
  const subject = `milestone ${input.tag} (${input.prs.length} PR(s))`
  const target = parseReleaseTag(input.tag)
  if (!target) {
    return {
      subject,
      findings: [
        {
          kind: "milestone-not-a-release",
          severity: "error",
          message: `\`${input.tag}\` is not a release tag — a release milestone's title must be exactly \`vX.Y.Z\`.`,
        },
      ],
    }
  }
  return {
    subject,
    findings: [
      // An empty milestone must never read as "every gate passes": a typo'd
      // tag returns zero PRs from `gh pr list --search milestone:"…"` exactly
      // like a real-but-unassigned one, and a silent green there is the same
      // class of failure gate 1 exists to prevent.
      ...(input.prs.length === 0
        ? [
            {
              kind: "empty-milestone" as const,
              severity: "error" as const,
              message: `milestone \`${input.tag}\` has no pull requests. Either nothing is assigned to it, or the tag is typo'd — \`gh api repos/{owner}/{repo}/milestones?state=all --jq '.[].title'\` lists the real ones.`,
            },
          ]
        : []),
      ...evaluateMilestoneVersion(input.tag, target, input.current),
      ...evaluatePrBumps(input.prs, target, input.tag, input.current),
    ],
  }
}

// --- gate 3 (pure) ---

/**
 * Gate 3: the tag being cut matches `package.json`.
 *
 * WHERE THIS BELONGS, and why it is in two places:
 *
 * A published tag is immutable in practice — `docs/release-runbook.md` forbids
 * moving one, because a consumer's `bun.lock` pins the resolved SHA and only
 * `bun update` re-resolves, so a moved tag means two machines hold different
 * code under one version. The damage is therefore done the instant the tag is
 * pushed. That rules out tag-push as the PRIMARY placement: it can only ever
 * alarm after the fact.
 *
 * So the preventive placement is a PREFLIGHT the human runs before pushing
 * (`bun run release:check version vX.Y.Z`, wired into runbook §4). But
 * "a human runs it" is precisely the discipline this file exists to replace,
 * so a preflight alone is not enough either.
 *
 * Hence both, with different jobs: the preflight PREVENTS, and a tag-push
 * workflow (`release-tag-check.yml`) DETECTS — it is the only placement that
 * can see the tag that was actually pushed, and it fires within seconds, while
 * the tag is still almost certainly unconsumed and can be deleted rather than
 * moved. It is deliberately NOT on the release commit: the runbook's flow bumps
 * and tags in one `release:manual` invocation, so a push-to-main check would
 * race the tag push it is meant to precede and could not name the tag anyway.
 */
export function checkTagVersion(tag: string, packageVersion: string): GateReport {
  const subject = `tag ${tag} vs package.json ${packageVersion}`
  const expected = `v${packageVersion.trim().replace(/^v/u, "")}`
  if (expected === tag.trim()) return { subject, findings: [] }
  return {
    subject,
    findings: [
      {
        kind: "version-tag-mismatch",
        severity: "error",
        message: `tag \`${tag}\` does not match package.json's version \`${packageVersion}\` (expected tag \`${expected}\`). This has shipped before — \`git show v0.1.1:package.json\` reads \`0.1.0\`. Fix package.json and re-cut the tag; do not move a tag anyone may already have resolved.`,
      },
    ],
  }
}

/** Repo root resolved from this file, so the preflight works from any cwd. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
export const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json")

/** Throws — an unreadable package.json is a gate-cannot-run (exit 2), not a violation. */
export function readPackageVersion(file: string): string {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown }
  if (typeof parsed.version !== "string") {
    throw new Error(`${file} has no string \`version\` field`)
  }
  return parsed.version
}

// --- gate 4 (pure) ---

/**
 * Gate 4: the tag being cut is strictly GREATER than every release tag that
 * already exists, and does not exist itself.
 *
 * WHAT WAS MISSING. Gate 3 asserts tag == `package.json`. Gate 2 asserts the
 * milestone is ahead of the current release *at the moment the check runs*.
 * Neither is an assertion about the moment the tag is PUSHED, and nothing
 * anywhere compared the tag being cut against the tags that already exist. With
 * two releases in flight at once — which is the normal state of this repo, four
 * agents deep — `v0.5.0` and `v0.4.4` can be prepared concurrently and land in
 * either order. If `v0.5.0` lands first, `v0.4.4` is a LOWER-semver tag carrying
 * strictly more content, and it cannot be repaired: `docs/release-runbook.md`
 * forbids moving a published tag, because a consumer's `bun.lock` pins the
 * resolved SHA and only `bun update` re-resolves.
 *
 * WHERE IT RUNS, AND WHY THERE. Primarily inside `release.ts`, ahead of `bumpp`
 * — the same placement argument the clean-tree guard makes, for the same reason:
 * `bumpp` commits, tags AND pushes, so every refusal has to be upstream of it or
 * it is an alarm rather than a guard. It is NOT wired only into a preflight a
 * human runs, because "a human runs it" is the discipline these gates replace,
 * and it is not wired only into a tag-push workflow, because by then the tag is
 * immutable. The `order` subcommand exists for the by-hand path in runbook §4
 * and for a tag-push tripwire (`--pushed`), both of which are secondary.
 *
 * WHICH TAGS IT COMPARES AGAINST — LOCAL **AND** REMOTE. A local checkout is
 * stale by default: nothing fetches tags on its own, so a tag another agent (or
 * another machine) pushed five minutes ago is invisible to `git tag --list`.
 * That is exactly the race this gate exists for, so the remote is authoritative
 * and is read every time. The local list is unioned in rather than replaced,
 * because a tag that exists only locally is still one this release would collide
 * with on push.
 *
 * The remote is read with `git ls-remote --tags`, not `git fetch --tags`, on
 * purpose: `ls-remote` writes nothing. A guard that mutates the ref store of the
 * repository it is about to refuse from would leave the tree different from how
 * it found it — the one property the whole refusal path is built on. An
 * unreachable remote is a THROW (exit 2, "the gate could not run"), never a
 * pass: the flow ends in `git push` anyway, so a release that cannot see the
 * remote was never going to complete.
 *
 * PRERELEASES DO NOT BLOCK. `vX.Y.Z-rc.1` is not a release tag to any of this
 * tooling (`RELEASE_TAG_RE` is exact), and by semver a prerelease sorts BELOW
 * the release it precedes — `v0.5.0-rc.1` is not evidence that `0.5.0` shipped.
 * So prereleases are excluded from the comparison and reported as a WARNING when
 * their base version sorts at or above the tag being cut, which is the case
 * where one plausibly means "someone else is already cutting 0.5.0".
 *
 * No third comparator is written here. Exact release tags go through this file's
 * `compareVersions`; the prerelease advisory goes through `semverGt` from
 * `watch-external-drift.ts` (which `release-notes.ts` already reuses), whose
 * `parseSemver` truncates at the suffix and therefore compares base versions.
 */

/**
 * The remote a release is pushed to. `bumpp` ends in a bare `git push`, which
 * follows the branch's upstream; every checkout that has cut a release here has
 * that on `origin`. Overridable on the CLI (`--remote`) for a fork or a scratch
 * clone.
 */
export const DEFAULT_REMOTE = "origin"

/** A tag carrying a prerelease or build suffix: `v0.5.0-rc.1`, `v0.5.0+meta`. */
export const PRERELEASE_TAG_RE = /^v\d+\.\d+\.\d+[-+]/u

/**
 * Tag names out of `git ls-remote --tags <remote>` output.
 *
 * Annotated tags appear twice — `refs/tags/v0.4.3` and the peeled
 * `refs/tags/v0.4.3^{}` — so the suffix is stripped and the result deduped;
 * counting a tag twice would not change the max, but the "where does it live"
 * text in a refusal would read as nonsense.
 */
export function parseRemoteTags(lsRemote: string): Array<string> {
  const names = new Set<string>()
  for (const line of lsRemote.split("\n")) {
    const ref = line.split("\t")[1]
    if (!ref?.startsWith("refs/tags/")) continue
    names.add(ref.slice("refs/tags/".length).replace(/\^\{\}$/u, "").trim())
  }
  return [...names]
}

export interface TagInventory {
  /** `git tag --list` — what this checkout knows, which may be stale. */
  local: ReadonlyArray<string>
  /** `git ls-remote --tags` — what everyone else can already resolve. */
  remote: ReadonlyArray<string>
}

export interface TagOrderInput extends TagInventory {
  tag: string
  /** The remote name, for the message only. */
  remoteName?: string
  /**
   * The tag has ALREADY been pushed — the tripwire placement. Its own existence
   * then stops being a finding, and it is compared against every OTHER tag. The
   * preventive placement (`release.ts`, `release:check order`) leaves this off,
   * where an existing tag is the whole point.
   */
  pushed?: boolean
}

/** Where a tag was found, for a message that says which clock is wrong. */
function whereTagLives(
  name: string,
  local: ReadonlyArray<string>,
  remote: ReadonlyArray<string>,
  remoteName: string,
): string {
  const here = local.includes(name)
  const there = remote.includes(name)
  if (here && there) return `locally and on \`${remoteName}\``
  if (there) return `on \`${remoteName}\``
  return "locally (not yet pushed)"
}

/** Gate 4, pure. */
export function evaluateTagOrder(input: TagOrderInput): GateReport {
  const remoteName = input.remoteName ?? DEFAULT_REMOTE
  const subject = `tag ${input.tag} vs ${input.local.length} local / ${input.remote.length} ${remoteName} tag(s)`
  const target = parseReleaseTag(input.tag)
  if (!target) {
    return {
      subject,
      findings: [
        {
          kind: "tag-not-a-release",
          severity: "error",
          message: `\`${input.tag}\` is not a release tag — it must be exactly \`vX.Y.Z\`. Prereleases are not modelled by any of this tooling.`,
        },
      ],
    }
  }

  const findings: Array<Finding> = []
  const all = [...new Set([...input.local, ...input.remote])]

  if (!input.pushed && all.includes(input.tag.trim())) {
    findings.push({
      kind: "tag-already-exists",
      severity: "error",
      message: `tag \`${input.tag}\` already exists ${whereTagLives(input.tag.trim(), input.local, input.remote, remoteName)}. A published tag must never be moved — a consumer's \`bun.lock\` pins the SHA the tag resolved to, so re-cutting it means two machines hold different code under one version. Cut the next unused version instead.`,
    })
  }

  const others = all.filter((name) => name !== input.tag.trim())
  const highest = highestTag(others)
  if (highest && compareVersions(target, highest) <= 0) {
    const name = formatVersion(highest)
    findings.push({
      kind: "tag-not-highest",
      severity: "error",
      message: `tag \`${input.tag}\` is not ahead of \`${name}\`, which already exists ${whereTagLives(name, input.local, input.remote, remoteName)}. Cutting it would leave a lower-semver tag containing strictly more content, and nothing can repair that afterwards: a published tag must not be moved. Pick a version above \`${name}\` (see *Choosing the version* in the runbook), retarget the milestone, and re-run.`,
    })
  }

  for (const name of others) {
    if (!PRERELEASE_TAG_RE.test(name)) continue
    if (semverGt(input.tag, name)) continue
    findings.push({
      kind: "prerelease-above-tag",
      severity: "warn",
      message: `prerelease tag \`${name}\` exists ${whereTagLives(name, input.local, input.remote, remoteName)} and its base version is at or above \`${input.tag}\`. Prereleases are not release tags to this tooling, so this does not block — but check that nobody is mid-way through cutting that version.`,
    })
  }

  return { subject, findings }
}

// --- gate 5 (pure) ---

/**
 * Gate 5: what is still OPEN when the tag is cut.
 *
 * WHAT WAS ALREADY COVERED, AND WHY THAT WAS NOT ENOUGH. `release:notes`
 * refuses to emit when a milestone contains an open PR, and `release.ts` calls
 * it before `bumpp`, so an open PR in the milestone blocks a release today. But
 * it blocks as a SIDE EFFECT of notes generation, and that side effect has a
 * hole: `release.ts` skips the whole changelog step — `gh` reads included — when
 * `CHANGELOG.md` already documents the version. A re-run after a failed `bumpp`,
 * or a hand-pasted entry, therefore cuts the tag with the open PR unnoticed.
 * This gate states the rule directly instead, and `release.ts` runs it
 * unconditionally.
 *
 * WHAT IS AND IS NOT CHECKABLE. The milestone model is what makes any of this
 * decidable: a PR pre-selects its release. So each open PR is classified by
 * where it points, and only one of the four cases is a violation:
 *
 *   - **In the milestone being cut** → BLOCKING. It said it ships here; it will
 *     not be in the tag and will not be in the notes. Not a judgement call.
 *   - **In a LOWER release milestone** → warning. That release has not shipped.
 *     Cutting past it strands it, and cutting it afterwards is the reverse-order
 *     tag gate 4 will then refuse — so this is gate 4's failure, seen early
 *     enough to still be free. Legal, though: skipping a version is allowed.
 *   - **In a HIGHER milestone** → silent. It has explicitly deferred itself.
 *     Whether it touches the same code is not something a gate can weigh.
 *   - **No milestone, or one that is not a release tag** → warning, listed by
 *     number. An unassigned PR is NOT automatically part of this release, and a
 *     gate that guessed would block a real release on someone's draft. The
 *     honest answer is to name them and let the releaser decide — the same
 *     shape `untrackedNote` in `release.ts` uses for the same reason. (The PR
 *     gate already blocks the missing milestone on the PR itself, so this is a
 *     reminder, not a second enforcement point.)
 */
export function evaluateOpenPrs(
  tag: string,
  open: ReadonlyArray<GatePullRequest>,
): Array<Finding> {
  const cutting = parseReleaseTag(tag)
  if (!cutting) return []

  const findings: Array<Finding> = []
  for (const pr of open) {
    if (exemption(pr)) continue
    const milestoneTitle = pr.milestone?.title
    const target = milestoneTitle ? parseReleaseTag(milestoneTitle) : undefined

    if (!target) {
      findings.push({
        kind: "open-pr-unmilestoned",
        severity: "warn",
        number: pr.number,
        message: `#${pr.number} (\`${pr.title}\`) is open with ${milestoneTitle ? `milestone \`${milestoneTitle}\`, which is not a release tag` : "no milestone"}. Whether it belongs in \`${tag}\` is a judgement call this gate does not make: it lists, it does not block. Assign it and re-run if it ships here — \`gh pr edit ${pr.number} --milestone ${tag}\`.`,
      })
      continue
    }

    const order = compareVersions(target, cutting)
    if (order === 0) {
      findings.push({
        kind: "open-pr-in-release",
        severity: "error",
        number: pr.number,
        message: `#${pr.number} (\`${pr.title}\`) is OPEN and assigned to \`${tag}\`, the release being cut. It would not be in the tag and would not appear in the notes, while the milestone claims it ships. Merge it, or drop it from the milestone.`,
      })
    } else if (order < 0) {
      findings.push({
        kind: "open-pr-earlier-release",
        severity: "warn",
        number: pr.number,
        message: `#${pr.number} is open in milestone \`${milestoneTitle}\`, which is BELOW the \`${tag}\` being cut — that release has not shipped. Cutting \`${tag}\` first strands it, and cutting \`${milestoneTitle}\` afterwards is a lower tag with more content, which gate 4 will refuse. Merge it first, retarget it, or accept that \`${milestoneTitle}\` will never ship.`,
      })
    }
  }
  return findings
}

// --- collection (gh) ---

/** Hard cap on PRs read from one milestone, mirroring `release-notes.ts`. */
export const PR_PAGE_LIMIT = 200

const PR_FIELDS = "number,title,body,milestone,author,labels,baseRefName"

export interface FetchedPr extends GatePullRequest {
  baseRefName: string
}

export function fetchPr(
  gh: GhRunner,
  repo: string,
  number: number,
): FetchedPr {
  return ghJson<FetchedPr>(gh, [
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    PR_FIELDS,
  ])
}

export function fetchMilestonePrs(
  gh: GhRunner,
  repo: string,
  tag: string,
): Array<GatePullRequest> {
  return ghJson<Array<GatePullRequest>>(gh, [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--limit",
    String(PR_PAGE_LIMIT),
    "--search",
    `milestone:"${tag}"`,
    "--json",
    "number,title,body,author,labels",
  ])
}

/**
 * Every OPEN PR in the repo — gate 5's whole input. Read across the repo rather
 * than per-milestone on purpose: the PRs this gate has to name are precisely the
 * ones a milestone-scoped search cannot return (no milestone, or somebody
 * else's).
 */
export function fetchOpenPrs(gh: GhRunner, repo: string): Array<GatePullRequest> {
  return ghJson<Array<GatePullRequest>>(gh, [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(PR_PAGE_LIMIT),
    "--json",
    "number,title,milestone,author,labels",
  ])
}

/** Gate 5's `gh` read plus its pure evaluation. */
export function collectOpenPrGate(
  tag: string,
  options: CollectOptions = {},
): GateReport {
  const gh = options.gh ?? realGh
  const repo = options.repo ?? currentRepo(gh)
  const open = fetchOpenPrs(gh, repo)
  return {
    subject: `open pull requests vs ${tag} (${open.length} open)`,
    findings: evaluateOpenPrs(tag, open),
  }
}

/** `git tag --list` — this checkout's view, which nothing keeps up to date. */
export function listLocalTags(git: GitRunner): Array<string> {
  const res = git(["tag", "--list"])
  if (res.status !== 0) {
    throw new Error(
      `git tag --list → exit ${res.status}: ${res.stderr.trim() || "(no stderr)"}`,
    )
  }
  return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
}

/**
 * `git ls-remote --tags <remote>` — the authoritative list, read without writing
 * a single ref. A failure THROWS: gate 4 must never conclude "nothing exists"
 * from a network error, because that is the reading that lets a reverse-order
 * tag through.
 */
export function listRemoteTags(
  git: GitRunner,
  remote: string = DEFAULT_REMOTE,
): Array<string> {
  const res = git(["ls-remote", "--tags", remote])
  if (res.status !== 0) {
    throw new Error(
      `git ls-remote --tags ${remote} → exit ${res.status}: ${res.stderr.trim() || "(no stderr)"}. Gate 4 compares against the tags that already exist, so it cannot run without reading them — and this release ends in a \`git push\` to the same remote.`,
    )
  }
  return parseRemoteTags(res.stdout)
}

export interface TagOrderOptions {
  git?: GitRunner
  remote?: string
  pushed?: boolean
}

/** Gate 4's two git reads plus its pure evaluation. */
export function collectTagOrderGate(
  tag: string,
  options: TagOrderOptions = {},
): GateReport {
  const git = options.git ?? realGit
  const remote = options.remote ?? DEFAULT_REMOTE
  return evaluateTagOrder({
    tag,
    local: listLocalTags(git),
    remote: listRemoteTags(git, remote),
    remoteName: remote,
    pushed: options.pushed,
  })
}

/** Highest `vX.Y.Z` tag in the list. Undefined when there are none. */
export function highestTag(tags: ReadonlyArray<string>): Version | undefined {
  let best: Version | undefined
  for (const name of tags) {
    const v = parseReleaseTag(name)
    if (!v) continue
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return best
}

export function maxVersion(a?: Version, b?: Version): Version {
  if (!a) return b ?? [0, 0, 0]
  if (!b) return a
  return compareVersions(a, b) >= 0 ? a : b
}

export function fetchPackageVersionAtRef(
  gh: GhRunner,
  repo: string,
  ref: string,
): Version | undefined {
  const res = ghJson<{ content?: string }>(gh, [
    "api",
    `repos/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`,
  ])
  if (!res.content) return undefined
  const text = Buffer.from(res.content, "base64").toString("utf8")
  const version = (JSON.parse(text) as { version?: unknown }).version
  return typeof version === "string" ? parseReleaseTag(`v${version}`) : undefined
}

/**
 * The version a consumer can currently resolve — the baseline every bump is
 * measured from.
 *
 * Taken as `max(highest git tag, package.json on the BASE ref)` because the two
 * have already disagreed in this repo's history (v0.1.1 was tagged while
 * package.json read 0.1.0) and each covers the other's failure: the tag is what
 * a consumer actually resolves, and package.json is ahead of it in the window
 * between a bump commit and its tag. Taking the max is the strict reading —
 * a stale-low baseline would make every gate more permissive, which is the one
 * direction this check must never fail in.
 *
 * The BASE ref matters: `actions/checkout` on a `pull_request` checks out the
 * merge commit, so reading package.json from the working tree would let the PR
 * under test choose its own baseline.
 */
export function fetchCurrentVersion(
  gh: GhRunner,
  repo: string,
  baseRef: string,
): Version {
  const tags = ghJson<Array<{ name: string }>>(gh, [
    "api",
    "--paginate",
    `repos/${repo}/tags?per_page=100`,
  ])
  return maxVersion(
    highestTag(tags.map((t) => t.name)),
    fetchPackageVersionAtRef(gh, repo, baseRef),
  )
}

export function currentRepo(gh: GhRunner): string {
  const res = ghJson<{ nameWithOwner?: string }>(gh, [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ])
  if (!res.nameWithOwner) throw new Error("gh repo view: no nameWithOwner")
  return res.nameWithOwner
}

export interface CollectOptions {
  gh?: GhRunner
  repo?: string
}

/** Full gate-1+2 pipeline for one PR: `gh` reads plus the pure evaluation. */
export function collectPrGate(
  number: number,
  options: CollectOptions = {},
): GateReport {
  const gh = options.gh ?? realGh
  const repo = options.repo ?? currentRepo(gh)
  const pr = fetchPr(gh, repo, number)
  const current = fetchCurrentVersion(gh, repo, pr.baseRefName)
  const milestoneTitle = pr.milestone?.title
  const siblings =
    milestoneTitle && parseReleaseTag(milestoneTitle)
      ? fetchMilestonePrs(gh, repo, milestoneTitle)
      : undefined
  return evaluatePr({ pr, current, siblings })
}

/** Full gate-2 + gate-5 pipeline for a whole milestone (the release preflight). */
export function collectMilestoneGate(
  tag: string,
  options: CollectOptions = {},
): GateReport {
  const gh = options.gh ?? realGh
  const repo = options.repo ?? currentRepo(gh)
  // Measured against the default branch: at preflight time the release commit
  // has not landed, so HEAD of the default branch is the last released state.
  // Read through `gh api` rather than `gh repo view <repo> --json` — the REST
  // shape is stable, and every other lookup in this file already goes that way.
  const defaultBranch = ghJson<{ default_branch?: string }>(gh, [
    "api",
    `repos/${repo}`,
  ]).default_branch
  const current = fetchCurrentVersion(gh, repo, defaultBranch ?? "HEAD")
  const report = evaluateMilestone({
    tag,
    current,
    prs: parseReleaseTag(tag) ? fetchMilestonePrs(gh, repo, tag) : [],
  })
  // Gate 5 rides along here rather than in its own subcommand: this is the
  // command the runbook already tells a releaser to run at preflight, and "what
  // is still open" is the same question at the same moment. `release.ts` calls
  // `collectOpenPrGate` directly, so the release path does not depend on anyone
  // remembering this one.
  if (!parseReleaseTag(tag)) return report
  return {
    subject: report.subject,
    findings: [...report.findings, ...evaluateOpenPrs(tag, fetchOpenPrs(gh, repo))],
  }
}

// --- rendering ---

const ICON: Record<Severity, string> = { error: "FAIL", warn: "WARN" }

/** Human-readable report (stdout). */
export function renderFindings(report: GateReport): string {
  const lines = [`release-gates: ${report.subject}`]
  if (report.findings.length === 0) {
    lines.push("  OK   every release gate passes.")
    return lines.join("\n")
  }
  for (const f of report.findings) {
    lines.push(`  ${ICON[f.severity]} [${f.kind}] ${f.message}`)
  }
  return lines.join("\n")
}

/** Markdown for `$GITHUB_STEP_SUMMARY`. */
export function renderSummary(report: GateReport): string {
  const errors = report.findings.filter((f) => f.severity === "error")
  const warns = report.findings.filter((f) => f.severity === "warn")
  const lines = [`## Release gates — ${report.subject}`, ""]
  if (report.findings.length === 0) {
    lines.push("Every release gate passes.", "")
    return lines.join("\n")
  }
  if (errors.length > 0) {
    lines.push("### Blocking", "")
    for (const f of errors) lines.push(`- **\`${f.kind}\`** — ${f.message}`)
    lines.push("")
  }
  if (warns.length > 0) {
    lines.push("### Warnings", "")
    for (const f of warns) lines.push(`- **\`${f.kind}\`** — ${f.message}`)
    lines.push("")
  }
  lines.push(
    `_Checked by \`scripts/ops/release-gates.ts\`. See [the release runbook](https://github.com/stuffbucket/maximal-core/blob/main/docs/release-runbook.md#the-gates). Add the \`${OVERRIDE_LABEL}\` label to downgrade these to warnings on this PR._`,
  )
  return lines.join("\n")
}

/** GitHub Actions annotations, so findings surface on the Checks tab. */
export function renderAnnotations(report: GateReport): Array<string> {
  return report.findings.map(
    (f) =>
      `::${f.severity === "error" ? "error" : "warning"} title=release-gates (${f.kind})::${f.message.replace(/\r?\n/gu, "%0A")}`,
  )
}

// --- entry point ---

export interface Args {
  subcommand?: string
  target?: string
  repo?: string
  /** Gate 4's remote. */
  remote?: string
  /** Gate 4's tripwire mode: the tag is expected to exist already. */
  pushed: boolean
  mode: Mode
}

const VALUE_FLAGS = new Set(["--mode", "--remote", "--repo"])

export function parseArgs(argv: ReadonlyArray<string>): Args {
  const args: Args = { mode: "enforce", pushed: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i]
      if (arg === "--repo") args.repo = value
      else if (arg === "--remote") args.remote = value
      // Anything that is not exactly `warn` means enforce — an unrecognised
      // mode string must never silently disable the gate.
      else args.mode = value === "warn" ? "warn" : "enforce"
    } else if (arg === "--pushed") {
      args.pushed = true
    } else if (!arg.startsWith("-")) {
      if (args.subcommand === undefined) args.subcommand = arg
      else args.target ??= arg
    }
  }
  return args
}

const USAGE = `usage: bun run release:check <pr <number> | milestone <vX.Y.Z> | order <vX.Y.Z> | version <vX.Y.Z>> [--repo owner/name] [--remote origin] [--pushed] [--mode enforce|warn]`

export interface MainOptions {
  /**
   * Emit the GitHub Actions surfaces — the Checks-tab `::error`/`::warning`
   * annotations and the `$GITHUB_STEP_SUMMARY` section. Defaults to whether we
   * are ON Actions, which is the same seam `check-bindings.ts` grew in #31.
   *
   * Tests must pass `false`. `main` reads the repo's real `package.json`, so a
   * test driving a fixture tag otherwise paints an invented `::error` and an
   * invented summary block onto a run that is passing — which teaches everyone
   * to ignore the surface a real gate failure arrives on.
   */
  annotate?: boolean
  /** Where the report goes. Defaults to stdout. */
  log?: (line: string) => void
  /** Where the job summary is appended. Defaults to `$GITHUB_STEP_SUMMARY`. */
  summaryPath?: string
  /** Gate 4's git seam, so a test never shells out to a real repository. */
  git?: GitRunner
}

function report(report_: GateReport, mode: Mode, options: MainOptions): number {
  const log =
    options.log
    ?? ((line: string) => {
      console.log(line)
    })
  const annotate = options.annotate ?? process.env.GITHUB_ACTIONS !== undefined
  log(renderFindings(report_))
  if (annotate) {
    for (const line of renderAnnotations(report_)) log(line)
    const summaryPath = options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY
    if (summaryPath) fs.appendFileSync(summaryPath, `${renderSummary(report_)}\n`)
  }
  const code = exitCodeFor(report_, mode)
  if (code === 0 && mode === "warn" && report_.findings.length > 0) {
    log("\n(--mode warn: nothing blocked.)")
  }
  return code
}

export function main(
  argv: ReadonlyArray<string>,
  options: MainOptions = {},
): number {
  const { subcommand, target, repo, remote, pushed, mode } = parseArgs(argv)
  if (!subcommand || !target) {
    console.error(USAGE)
    return 2
  }

  try {
    switch (subcommand) {
      case "pr": {
        const number = Number.parseInt(target, 10)
        if (!Number.isInteger(number) || number <= 0) {
          console.error(`release-gates: \`${target}\` is not a PR number.\n${USAGE}`)
          return 2
        }
        return report(collectPrGate(number, { repo }), mode, options)
      }
      case "milestone":
        return report(collectMilestoneGate(target, { repo }), mode, options)
      case "order":
        return report(
          collectTagOrderGate(target, { git: options.git, remote, pushed }),
          mode,
          options,
        )
      case "version":
        return report(
          checkTagVersion(target, readPackageVersion(PACKAGE_JSON_PATH)),
          mode,
          options,
        )
      default:
        console.error(`release-gates: unknown subcommand \`${subcommand}\`.\n${USAGE}`)
        return 2
    }
  } catch (err) {
    // The gate could not RUN (gh failed, JSON was unparseable, package.json is
    // missing). Exit 2, distinct from a violation, so the caller can decline to
    // block on it — a gate that fails closed on its own bugs takes the repo
    // down with it.
    console.error(
      `release-gates: could not run — ${err instanceof Error ? err.message : String(err)}`,
    )
    return 2
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
