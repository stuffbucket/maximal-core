#!/usr/bin/env bun
/**
 * Release-notes generator — milestone in, CHANGELOG-shaped Markdown out.
 *
 * This repo has NO release automation. `docs/release-runbook.md` still
 * describes a release-please pipeline (`release-please.yml` / `release.yml`)
 * that was inherited from the parent repo and never carried over: neither
 * workflow exists in `.github/workflows/`, and nothing runs
 * `release-please-config.json`. So the notes that release-please used to write
 * have to come from somewhere else. Here, the somewhere else is a **GitHub
 * milestone whose title is the tag** (e.g. `v0.2.1`): whatever is in the
 * milestone is what ships, which makes the release contents reviewable in the
 * GitHub UI *before* the tag is cut.
 *
 * The output is byte-compatible with what release-please wrote into
 * `CHANGELOG.md` (same `## [x.y.z](compare-link) (date)` header, same
 * `### Features` / `### Bug Fixes` sections, same
 * `* **scope:** desc ([#12](…/issues/12)) ([abc1234](…/commit/abc1234…))`
 * bullets, same alphabetical order), so a generated block can be pasted at the
 * top of the existing file without a format seam. `--release-body` emits the
 * same sections shaped for a GitHub Release instead.
 *
 * Refuses to emit on any problem rather than quietly shipping wrong notes:
 * a missing milestone, an empty milestone, a PR title that is not a valid
 * Conventional Commit, an unknown commit type, a PR still open or closed
 * unmerged, or a truncated PR page all report to stderr and set a non-zero
 * exit. `--force` emits the well-formed subset anyway, still non-zero.
 *
 * Usage:
 *   bun run scripts/ops/release-notes.ts v0.2.1
 *   bun run scripts/ops/release-notes.ts v0.2.1 --release-body
 *   bun run scripts/ops/release-notes.ts v0.2.1 --previous v0.2.0 --date 2026-08-05
 *   bun run scripts/ops/release-notes.ts v0.2.1 --repo stuffbucket/maximal-core
 *   bun run scripts/ops/release-notes.ts v0.2.1 --force   # emit despite problems
 *
 * Exit codes: 0 clean · 1 problems found · 2 fatal (no milestone / no PRs).
 *
 * All GitHub access goes through the `gh` CLI (already this repo's only GitHub
 * client — see `docs/release-runbook.md`), and every `gh` call funnels through
 * one injectable `GhRunner`, so the tests drive the whole pipeline offline.
 */

import { spawnSync } from "node:child_process"

import { semverGt } from "./watch-external-drift"

// --- gh plumbing (the only I/O, and the only injected dependency) ---

export interface GhResult {
  status: number
  stdout: string
  stderr: string
}

/** Runs `gh` with the given argv. The single seam every GitHub read passes. */
export type GhRunner = (args: ReadonlyArray<string>) => GhResult

/** The real `gh`. A missing/unrunnable binary is a normal failed result. */
export const realGh: GhRunner = (args) => {
  const res = spawnSync("gh", [...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.error) {
    return {
      status: 127,
      stdout: "",
      stderr: `could not run \`gh\`: ${res.error.message}`,
    }
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  }
}

function ghJson<T>(gh: GhRunner, args: ReadonlyArray<string>): T {
  const res = gh(args)
  if (res.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} → exit ${res.status}: ${res.stderr.trim() || "(no stderr)"}`,
    )
  }
  try {
    return JSON.parse(res.stdout) as T
  } catch {
    throw new Error(
      `gh ${args.join(" ")} → unparseable JSON: ${res.stdout.slice(0, 200)}`,
    )
  }
}

// --- conventional-commit parsing ---

/**
 * CHANGELOG sections, in render order, keyed by Conventional Commit type.
 * The three headings this repo's CHANGELOG already uses (Features, Bug Fixes,
 * Performance Improvements) keep their exact text; the rest use the same
 * conventional-changelog names release-please would have used had they not
 * been hidden by default.
 */
export const SECTIONS: ReadonlyArray<{ type: string; heading: string }> = [
  { type: "feat", heading: "Features" },
  { type: "fix", heading: "Bug Fixes" },
  { type: "perf", heading: "Performance Improvements" },
  { type: "revert", heading: "Reverts" },
  { type: "refactor", heading: "Code Refactoring" },
  { type: "build", heading: "Build System" },
  { type: "ci", heading: "Continuous Integration" },
  { type: "docs", heading: "Documentation" },
  { type: "style", heading: "Styles" },
  { type: "test", heading: "Tests" },
  { type: "chore", heading: "Miscellaneous Chores" },
]

const KNOWN_TYPES = new Set(SECTIONS.map((s) => s.type))

/** Heading for a breaking-change callout, matching release-please's wording. */
const BREAKING_HEADING = "⚠ BREAKING CHANGES"

const TITLE_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?(?<breaking>!)?: (?<description>.+)$/u

export interface ParsedTitle {
  type: string
  scope?: string
  breaking: boolean
  description: string
}

/**
 * Parse a PR title as a single Conventional Commit. Returns undefined when the
 * title does not conform — the caller reports it, never guesses. Pure.
 */
export function parseConventionalTitle(title: string): ParsedTitle | undefined {
  const m = TITLE_RE.exec(title.trim())
  if (!m?.groups) return undefined
  const { type, scope, breaking, description } = m.groups
  return {
    type,
    scope: scope || undefined,
    breaking: breaking === "!",
    description: description.trim(),
  }
}

// --- inputs ---

/** A PR as returned by `gh pr list --json …`. */
export interface PullRequest {
  number: number
  title: string
  state: string
  mergedAt?: string | null
  mergeCommit?: { oid?: string | null } | null
  closingIssuesReferences?: ReadonlyArray<{ number: number }>
}

export interface Milestone {
  number: number
  title: string
  state: string
}

/** A PR that parsed cleanly and will be rendered. */
export interface Entry extends ParsedTitle {
  number: number
  /** Full merge-commit sha, when known. */
  sha?: string
  closes: ReadonlyArray<number>
}

export type ProblemKind =
  | "closed-unmerged"
  | "empty-milestone"
  | "missing-milestone"
  | "non-conforming-title"
  | "open-pr"
  | "truncated"
  | "unknown-type"

export interface Problem {
  kind: ProblemKind
  /** PR number, when the problem is about one PR. */
  number?: number
  message: string
  /** A fatal problem means there is nothing worth emitting at all. */
  fatal: boolean
}

export interface Section {
  heading: string
  entries: ReadonlyArray<Entry>
}

export interface ReleaseNotes {
  tag: string
  /** Tag with any leading `v` stripped — what the CHANGELOG heading shows. */
  version: string
  date: string
  repo: string
  previousTag?: string
  sections: ReadonlyArray<Section>
  breaking: ReadonlyArray<Entry>
  problems: Array<Problem>
}

// --- pure assembly ---

/** Sort key mirroring release-please: `scope: description`, case-insensitive. */
export function sortKey(entry: Entry): string {
  return `${entry.scope ? `${entry.scope}: ` : ""}${entry.description}`.toLowerCase()
}

export interface BuildInput {
  tag: string
  repo: string
  date: string
  previousTag?: string
  prs: ReadonlyArray<PullRequest>
}

/**
 * Turn a milestone's PRs into rendered sections plus the problems that stop
 * them being trustworthy. Pure — this is the whole generator minus the `gh`
 * calls, so the tests exercise the real logic.
 */
export function buildReleaseNotes(input: BuildInput): ReleaseNotes {
  const problems: Array<Problem> = []
  const entries: Array<Entry> = []

  for (const pr of input.prs) {
    if (pr.state === "OPEN") {
      problems.push({
        kind: "open-pr",
        number: pr.number,
        message: `#${pr.number} is still OPEN — merge it or drop it from the milestone.`,
        fatal: false,
      })
      continue
    }
    if (!pr.mergedAt) {
      problems.push({
        kind: "closed-unmerged",
        number: pr.number,
        message: `#${pr.number} was closed without merging — drop it from the milestone.`,
        fatal: false,
      })
      continue
    }

    const parsed = parseConventionalTitle(pr.title)
    if (!parsed) {
      problems.push({
        kind: "non-conforming-title",
        number: pr.number,
        message: `#${pr.number} title is not a Conventional Commit: ${JSON.stringify(pr.title)} — expected \`type(scope): description\`.`,
        fatal: false,
      })
      continue
    }
    if (!KNOWN_TYPES.has(parsed.type)) {
      problems.push({
        kind: "unknown-type",
        number: pr.number,
        message: `#${pr.number} uses unknown type \`${parsed.type}\` — known types: ${[...KNOWN_TYPES].join(", ")}.`,
        fatal: false,
      })
      continue
    }

    entries.push({
      ...parsed,
      number: pr.number,
      sha: pr.mergeCommit?.oid ?? undefined,
      closes: (pr.closingIssuesReferences ?? []).map((r) => r.number),
    })
  }

  if (input.prs.length === 0) {
    problems.push({
      kind: "empty-milestone",
      message: `milestone \`${input.tag}\` has no pull requests — assign the PRs that ship in this release to it.`,
      fatal: true,
    })
  } else if (entries.length === 0) {
    problems.push({
      kind: "empty-milestone",
      message: `milestone \`${input.tag}\` has ${input.prs.length} PR(s) but none usable — see the problems above.`,
      fatal: true,
    })
  }

  const byKey = (a: Entry, b: Entry): number => {
    const ka = sortKey(a)
    const kb = sortKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  }

  const sections: Array<Section> = []
  for (const { type, heading } of SECTIONS) {
    const inSection = entries.filter((e) => e.type === type).sort(byKey)
    if (inSection.length > 0) sections.push({ heading, entries: inSection })
  }

  return {
    tag: input.tag,
    version: stripV(input.tag),
    date: input.date,
    repo: input.repo,
    previousTag: input.previousTag,
    sections,
    breaking: entries.filter((e) => e.breaking).sort(byKey),
    problems,
  }
}

/** `v0.2.1` → `0.2.1`. The tag keeps its prefix; the heading does not. */
export function stripV(tag: string): string {
  return tag.replace(/^v/u, "")
}

// --- rendering ---

function issueLink(repo: string, n: number): string {
  return `[#${n}](https://github.com/${repo}/issues/${n})`
}

/** One CHANGELOG bullet, byte-identical to what release-please emitted. */
export function renderEntry(entry: Entry, repo: string): string {
  const scope = entry.scope ? `**${entry.scope}:** ` : ""
  const parts = [`* ${scope}${entry.description} (${issueLink(repo, entry.number)})`]
  if (entry.sha) {
    parts.push(
      ` ([${entry.sha.slice(0, 7)}](https://github.com/${repo}/commit/${entry.sha}))`,
    )
  }
  if (entry.closes.length > 0) {
    parts.push(
      `, closes ${entry.closes.map((n) => issueLink(repo, n)).join(" ")}`,
    )
  }
  return parts.join("")
}

function renderSections(notes: ReleaseNotes): Array<string> {
  const blocks: Array<string> = []
  if (notes.breaking.length > 0) {
    blocks.push(
      [
        `### ${BREAKING_HEADING}`,
        "",
        ...notes.breaking.map((e) => renderEntry(e, notes.repo)),
      ].join("\n"),
    )
  }
  for (const section of notes.sections) {
    blocks.push(
      [
        `### ${section.heading}`,
        "",
        ...section.entries.map((e) => renderEntry(e, notes.repo)),
      ].join("\n"),
    )
  }
  return blocks
}

function compareUrl(notes: ReleaseNotes): string | undefined {
  return notes.previousTag
    ? `https://github.com/${notes.repo}/compare/${notes.previousTag}...${notes.tag}`
    : undefined
}

/**
 * The block to paste at the top of `CHANGELOG.md`, directly under
 * `# Changelog`. Reproduces release-please's exact whitespace: two blank lines
 * after the `##` header and between sections, one after each heading.
 * A first release (no previous tag) gets an unlinked header, as release-please
 * also did.
 */
export function renderChangelog(notes: ReleaseNotes): string {
  const url = compareUrl(notes)
  const header = url
    ? `## [${notes.version}](${url}) (${notes.date})`
    : `## ${notes.version} (${notes.date})`
  return `${[header, ...renderSections(notes)].join("\n\n\n")}\n`
}

/**
 * The GitHub Release body: the same sections without the redundant version
 * header (the release page already shows the tag), plus GitHub's conventional
 * full-changelog footer.
 */
export function renderReleaseBody(notes: ReleaseNotes): string {
  const blocks = renderSections(notes)
  const url = compareUrl(notes)
  if (url) blocks.push(`**Full Changelog**: ${url}`)
  return `${blocks.join("\n\n")}\n`
}

/** Human-readable problem report (stderr). Empty string when there are none. */
export function renderProblems(problems: ReadonlyArray<Problem>): string {
  if (problems.length === 0) return ""
  const lines = [`release-notes: ${problems.length} problem(s):`]
  for (const p of problems) {
    lines.push(`  ${p.fatal ? "FATAL" : "WARN "} [${p.kind}] ${p.message}`)
  }
  return lines.join("\n")
}

/** 0 clean · 1 problems (output still derivable) · 2 fatal. */
export function exitCodeFor(notes: ReleaseNotes): number {
  if (notes.problems.some((p) => p.fatal)) return 2
  return notes.problems.length > 0 ? 1 : 0
}

// --- collection (gh) ---

/** Hard cap on PRs read from one milestone; hitting it is reported, not hidden. */
export const PR_PAGE_LIMIT = 200

export interface CollectOptions {
  tag: string
  gh?: GhRunner
  /** Skip the `gh repo view` lookup. */
  repo?: string
  /** Skip the tag-list lookup for the compare link. */
  previousTag?: string
  /** Defaults to today (UTC). */
  date?: string
  now?: () => Date
}

/** `owner/name` of the current checkout. */
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

/**
 * Find the milestone whose title is exactly `tag`. Throws with the available
 * titles when there is no match — a typo'd tag must never look like an empty
 * release.
 */
export function findMilestone(
  gh: GhRunner,
  repo: string,
  tag: string,
): Milestone {
  const milestones = ghJson<Array<Milestone>>(gh, [
    "api",
    "--paginate",
    `repos/${repo}/milestones?state=all&per_page=100`,
  ])
  const found = milestones.find((m) => m.title === tag)
  if (!found) {
    const known = milestones.map((m) => m.title).join(", ") || "(none)"
    throw new Error(
      `no milestone titled \`${tag}\` in ${repo}. Existing milestones: ${known}`,
    )
  }
  return found
}

/** PRs assigned to the milestone, in any state (unmerged ones get flagged). */
export function listMilestonePrs(
  gh: GhRunner,
  repo: string,
  tag: string,
): Array<PullRequest> {
  return ghJson<Array<PullRequest>>(gh, [
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
    "number,title,state,mergedAt,mergeCommit,closingIssuesReferences",
  ])
}

/**
 * Highest semver tag strictly below `tag` — the left side of the compare link.
 * Undefined when nothing precedes it (first release), which renders an
 * unlinked header rather than a broken compare URL.
 */
export function previousTagFor(
  tags: ReadonlyArray<string>,
  tag: string,
): string | undefined {
  let best: string | undefined
  for (const candidate of tags) {
    if (candidate === tag) continue
    if (!semverGt(tag, candidate)) continue
    if (!best || semverGt(candidate, best)) best = candidate
  }
  return best
}

function fetchPreviousTag(
  gh: GhRunner,
  repo: string,
  tag: string,
): string | undefined {
  const tags = ghJson<Array<{ name: string }>>(gh, [
    "api",
    "--paginate",
    `repos/${repo}/tags?per_page=100`,
  ])
  return previousTagFor(
    tags.map((t) => t.name),
    tag,
  )
}

/** Full pipeline: `gh` reads + the pure build. Throws on a missing milestone. */
export function collectReleaseNotes(options: CollectOptions): ReleaseNotes {
  const gh = options.gh ?? realGh
  const now = options.now ?? (() => new Date())
  const repo = options.repo ?? currentRepo(gh)

  // Existence check first: `gh pr list --search` returns an empty list for a
  // milestone that does not exist, which would otherwise read as "nothing to
  // release" instead of "you typed the tag wrong".
  findMilestone(gh, repo, options.tag)

  const prs = listMilestonePrs(gh, repo, options.tag)
  const notes = buildReleaseNotes({
    tag: options.tag,
    repo,
    date: options.date ?? now().toISOString().slice(0, 10),
    previousTag: options.previousTag ?? fetchPreviousTag(gh, repo, options.tag),
    prs,
  })

  if (prs.length >= PR_PAGE_LIMIT) {
    notes.problems.push({
      kind: "truncated",
      message: `milestone returned ${prs.length} PRs, the page limit — the notes may be incomplete. Raise PR_PAGE_LIMIT.`,
      fatal: false,
    })
  }
  return notes
}

// --- entry point ---

export interface Args {
  tag?: string
  repo?: string
  previous?: string
  date?: string
  releaseBody: boolean
  force: boolean
}

/** Flags that consume the following argv item, so it is not the tag. */
const VALUE_FLAGS = new Set(["--date", "--previous", "--repo"])

/** Parse the CLI argv. Pure, so the shapes are covered by tests. */
export function parseArgs(argv: ReadonlyArray<string>): Args {
  const args: Args = { releaseBody: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i]
      if (arg === "--repo") args.repo = value
      else if (arg === "--previous") args.previous = value
      else args.date = value
    } else if (arg === "--release-body") args.releaseBody = true
    else if (arg === "--force") args.force = true
    else if (!arg.startsWith("--")) args.tag ??= arg
  }
  return args
}

function main(argv: ReadonlyArray<string>): number {
  const { tag, repo, previous, date, releaseBody, force } = parseArgs(argv)
  if (!tag) {
    console.error(
      "usage: bun run scripts/ops/release-notes.ts <tag> [--repo owner/name] [--previous vX.Y.Z] [--date YYYY-MM-DD] [--release-body] [--force]",
    )
    return 2
  }

  let notes: ReleaseNotes
  try {
    notes = collectReleaseNotes({ tag, repo, previousTag: previous, date })
  } catch (err) {
    console.error(
      `release-notes: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 2
  }

  const code = exitCodeFor(notes)
  if (code !== 0) console.error(renderProblems(notes.problems))

  if (code === 0 || (code === 1 && force)) {
    process.stdout.write(
      releaseBody ? renderReleaseBody(notes) : renderChangelog(notes),
    )
  } else if (code === 1) {
    console.error("\nNo output written. Re-run with --force to emit anyway.")
  }
  return code
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
