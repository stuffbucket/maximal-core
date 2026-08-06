import { Glob } from "bun"
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, normalize, resolve } from "node:path"

/**
 * Docs-reference parity.
 *
 * `docs/dev/testing-strategy.md` promises that a rename never silently
 * invalidates the docs. This is the mechanism behind that promise. It checks
 * the four reference classes that are cheap to verify and expensive to notice
 * by eye:
 *
 *   1. `bun run <script>` — the script exists in package.json.
 *   2. Backticked repo-relative paths — the file or directory exists on disk.
 *   3. Relative markdown links — the target exists (i.e. would not 404 on
 *      GitHub, which is where these docs are actually read).
 *   4. Workflow filenames — a `*.yml` named as one of this repo's workflows
 *      exists under `.github/workflows/`.
 *
 * PRECISION OVER RECALL. A docs test that cries wolf gets deleted, and then
 * enforces nothing at all. Every heuristic below is deliberately biased toward
 * staying silent: it scans inline code spans rather than all prose, it ignores
 * anything containing a glob or placeholder, it skips whole document classes
 * that exist to record a past state, and it skips paragraphs whose own point is
 * that the named thing is *absent*. The cost is real misses. The benefit is
 * that a red result here is always a genuine defect, so nobody learns to
 * ignore it.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")

/** Docs whose references are enforced, before exclusions. */
const DOC_GLOB = "docs/**/*.md"
const ROOT_DOCS = ["README.md", "AGENTS.md"]

/**
 * Directories excluded from the script / path / workflow checks.
 *
 * These are *records*, not maps. They describe a state of the tree at the
 * moment they were written, and re-pointing their paths at today's layout
 * would falsify them. Roughly 200 stale `src/…` citations live here by design.
 */
const EXCLUDED_TREES: Array<{ path: string; why: string }> = [
  {
    path: "docs/archive",
    why: "Frozen parent-repo history. Its links correctly target stuffbucket/maximal, and scripts/ops/release-notes.test.ts reads CHANGELOG-maximal.md as a fixture. Never flag, never edit.",
  },
  {
    path: "docs/decisions",
    why: "ADRs are immutable point-in-time records. An ADR cites the code as it stood when the decision was made; updating those paths would rewrite history. NARROWED: this exemption covers src/ and tests/ citations only. An ADR's reference to a SIBLING ADR is not a point-in-time code citation — the target either exists or the reader gets a 404 — so those are checked separately, below.",
  },
  {
    path: "docs/spec",
    why: "PRDs, wire specs and strategy docs. Same point-in-time contract as ADRs, plus proposals that name files intended to exist only if the work is scheduled.",
  },
]

/**
 * Individual files excluded. Deliberately tiny: a doc that carries a `>` scope
 * banner (see `applyScopeNotes`) needs no entry here, so this list holds only
 * the documents whose "this is a record" statement is prose the parser cannot
 * see. If it ever grows past a handful, the right fix is a directory rule.
 */
const EXCLUDED_FILES: Array<{ path: string; why: string }> = [
  {
    path: "docs/dev/project-health-audit-2026-07.md",
    why: 'Dated audit of the pre-split tree. Its own header: the file:line citations "were accurate on that date and against that layout … Read it as a record, not as a map." Stated as a Status/Scope block rather than a > banner.',
  },
  {
    path: "docs/stop-hook-prd.md",
    why: "Describes an operator's local .claude/ setup, so its scripts (`bun run design:check`) and paths are the operator's, not this repo's. Header says so; not a > banner.",
  },
]

/**
 * `*.yml` filenames that are named in the docs but are not — and never will be
 * — workflows of this repo. Without this the workflow check flags every
 * third-party config file that happens to end in `.yml`.
 */
const NON_WORKFLOW_YML = new Set([
  "action.yml", // composite-action manifest, not a workflow
  "codecov.yml",
  "dependabot.yml",
  "docker-compose.observability.yml",
  "docker-compose.yml",
  "lefthook.yml", // third-party git-hook manager, shown as an example
])

/**
 * Top-level directories a backticked token must start with to be treated as a
 * repo path. This is the single highest-value precision filter: it rejects
 * `~/.local/share/maximal/config.json`, `node_modules/…`, `%APPDATA%\…`,
 * `shell/`, `landing/`, `site/` and every other path that is illustrative,
 * external, or belongs to a different tier. `dist/` is omitted because it is
 * build output and absent in a clean checkout.
 */
const PATH_ROOTS = ["src", "tests", "scripts", "docs", "downstream", ".github"]

/**
 * A token containing any of these is a pattern, a placeholder or a shell
 * expansion — `src/…`, `tests/**`, `docs/decisions/<id>-<slug>.md`,
 * `${COPILOT_API_HOME}/state`, `.github/workflows/*.yml`. Never a literal path.
 */
const PLACEHOLDER = /[*?<>{}$|\\%~…]|\.\.\./

/**
 * Paragraph-level negation. Docs legitimately name things in order to say they
 * are absent — `docs/release-runbook.md` devotes a section to "What this repo
 * does *not* have" and names `release.yml` four times. Flagging those would
 * force someone to delete a correct sentence, which is the worst possible
 * outcome for this test's credibility.
 *
 * Matched against the enclosing paragraph plus its nearest heading, not the
 * single line: these sentences wrap.
 */
const NEGATIONS = [
  /\bno longer\b/i,
  /\bno such\b/i,
  /\bnot exist/i,
  /\bnever (?:existed|shipped|carried)\b/i,
  /\bneither\b/i,
  /\bdoes not (?:have|resolve|commit|ship|build|live)\b/i,
  /\bdo not (?:have|resolve|go looking)\b/i,
  /\b(?:ships|builds|has|have|there is|there are) no\b/i,
  /\bwere (?:deleted|removed|inert)\b/i,
  /\bare (?:deleted|removed)\b/i,
  /\bnot (?:in this repo|carried over|committed|tracked)\b/i,
  /\bnot in `?maximal-core/i,
  /\bis untracked\b/i,
  /\b(?:parent|GUI) repo\b/i,
  /\bpre-split\b/i,
  /\bdo not (?:treat|read) its paths as current\b/i,
]

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

interface Doc {
  /** Repo-relative path, e.g. `docs/architecture.md`. */
  path: string
  /** Raw lines, fences included. */
  raw: Array<string>
  /** Lines with fenced-code content blanked out. */
  prose: Array<string>
  /** Per-line negation context: nearest heading + enclosing paragraph. */
  context: Array<string>
}

const FENCE = /^\s*(?:```|~~~)/

function buildDoc(path: string): Doc {
  const raw = readFileSync(join(REPO_ROOT, path), "utf8").split("\n")
  const prose: Array<string> = []
  let inFence = false
  for (const line of raw) {
    if (FENCE.test(line)) {
      inFence = !inFence
      prose.push("")
      continue
    }
    prose.push(inFence ? "" : line)
  }

  // Walk paragraphs of prose, tracking the nearest heading, and stamp every
  // line in a paragraph with `heading + paragraph` as its negation context.
  const context: Array<string> = Array.from({ length: raw.length }, () => "")
  let heading = ""
  let start = -1
  const flush = (end: number): void => {
    if (start < 0) return
    const text = prose.slice(start, end).join(" ")
    for (let i = start; i < end; i++) context[i] = `${heading} ${text}`
    start = -1
  }
  for (const [i, line] of prose.entries()) {
    if (line.trim() === "") {
      flush(i)
      context[i] = heading
      continue
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      flush(i)
      heading = line
      context[i] = heading
      continue
    }
    if (start < 0) start = i
  }
  flush(prose.length)
  // Fenced lines got blanked above; give them at least their heading.
  for (const [i, line] of context.entries()) {
    if (line === "") context[i] = heading
  }
  applyScopeNotes(prose, context)
  return { path, raw, prose, context }
}

/**
 * Blockquote scope notes.
 *
 * The convention in this repo is a `>` banner declaring that the paths in what
 * follows belong to the parent repo, or to a tree that no longer exists. A
 * banner in the preamble (before the second heading) governs the whole file;
 * one inside a section governs that section. Only banners whose own text reads
 * as a negation have any effect, so an ordinary blockquote suppresses nothing.
 */
function applyScopeNotes(prose: Array<string>, context: Array<string>): void {
  const bounds: Array<number> = []
  for (const [i, line] of prose.entries()) {
    if (/^\s*#{1,6}\s/.test(line)) bounds.push(i)
  }
  bounds.push(prose.length)
  for (const [section, start] of bounds.entries()) {
    if (start === prose.length) break
    const end = bounds[section + 1] ?? prose.length
    const quote = prose
      .slice(start, end)
      .filter((line) => /^\s*>/.test(line))
      .join(" ")
    if (quote === "" || !NEGATIONS.some((pattern) => pattern.test(quote)))
      continue
    // A preamble banner (the first section, i.e. right under the H1) scopes
    // the entire document.
    const scopeEnd = section === 0 ? prose.length : end
    for (let i = start; i < scopeEnd; i++) context[i] += ` ${quote}`
  }
}

function isNegated(doc: Doc, lineIndex: number): boolean {
  const context = doc.context[lineIndex] ?? ""
  return NEGATIONS.some((pattern) => pattern.test(context))
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function allDocs(): Array<string> {
  return [...ROOT_DOCS, ...new Glob(DOC_GLOB).scanSync(REPO_ROOT)]
    .map((p) => p.replaceAll("\\", "/"))
    .sort()
}

function inTree(path: string, tree: string): boolean {
  return path === tree || path.startsWith(`${tree}/`)
}

const EXCLUDED_PATHS = new Set(EXCLUDED_FILES.map((f) => f.path))

/** Docs whose scripts / paths / workflow names are enforced. */
function enforcedDocs(): Array<Doc> {
  return allDocs()
    .filter(
      (p) =>
        !EXCLUDED_PATHS.has(p)
        && !EXCLUDED_TREES.some((t) => inTree(p, t.path)),
    )
    .map((p) => buildDoc(p))
}

/**
 * Docs whose relative links are enforced — everything except the frozen
 * archive. A link's validity does not decay with the document's age: the
 * target either exists or the reader gets a 404, so this check runs over
 * records too.
 */
function linkedDocs(): Array<Doc> {
  return allDocs()
    .filter((p) => !inTree(p, "docs/archive"))
    .map((p) => buildDoc(p))
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface Violation {
  file: string
  line: number
  reference: string
  problem: string
  fix: string
}

function report(kind: string, violations: Array<Violation>): string {
  if (violations.length === 0) return ""
  const body = violations
    .map(
      (v) =>
        `  ${v.file}:${v.line}\n`
        + `    reference: ${v.reference}\n`
        + `    problem:   ${v.problem}\n`
        + `    fix:       ${v.fix}`,
    )
    .join("\n\n")
  return (
    `${violations.length} ${kind} in the docs do not resolve against this repo.\n\n`
    + `${body}\n\n`
    + "  Either correct the reference, or — if the doc is a point-in-time record\n"
    + "  whose paths are meant to be historical — add it to EXCLUDED_FILES /\n"
    + "  EXCLUDED_TREES in tests/docs-reference-parity.test.ts with a reason.\n"
  )
}

/** Yields every inline code span outside fenced blocks. */
function* codeSpans(doc: Doc): Generator<{ line: number; token: string }> {
  for (const [i, line] of doc.prose.entries()) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      yield { line: i, token: match[1].trim() }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. bun run <script>
// ---------------------------------------------------------------------------

describe("docs reference parity", () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> }
  const scripts = new Set(Object.keys(pkg.scripts))

  it("every `bun run <script>` names a script in package.json", () => {
    const violations: Array<Violation> = []
    for (const doc of enforcedDocs()) {
      // Commands live in fenced blocks as often as in prose, so scan raw lines.
      for (const [i, line] of doc.raw.entries()) {
        // Stop the match at a `/` or `.` so `bun run scripts/foo.ts` (a file
        // path, not a script name) is not read as the script `scripts`.
        for (const match of line.matchAll(
          /\bbun run ([a-z][\w-]*(?::[\w-]+)*)(?![\w:./-])/g,
        )) {
          const name = match[1]
          if (scripts.has(name) || isNegated(doc, i)) continue
          violations.push({
            file: doc.path,
            line: i + 1,
            reference: `bun run ${name}`,
            problem: `package.json defines no "${name}" script.`,
            fix: `Use an existing script, or add "${name}" to package.json. Defined today: ${[...scripts].sort().join(", ")}`,
          })
        }
      }
    }
    expect(report("`bun run` references", violations)).toBe("")
  })

  // -------------------------------------------------------------------------
  // 2. Backticked repo-relative paths
  // -------------------------------------------------------------------------

  it("every backticked repo path exists on disk", () => {
    const violations: Array<Violation> = []
    for (const doc of enforcedDocs()) {
      for (const { line, token } of codeSpans(doc)) {
        const candidate = normalizeCandidate(token)
        if (candidate === null) continue
        if (existsSync(join(REPO_ROOT, candidate))) continue
        if (isNegated(doc, line)) continue
        violations.push({
          file: doc.path,
          line: line + 1,
          reference: `\`${token}\``,
          problem: `${candidate} does not exist in the repo.`,
          fix: "Re-point it at the current path, or drop the citation if the thing is gone.",
        })
      }
    }
    expect(report("repo paths", violations)).toBe("")
  })

  // -------------------------------------------------------------------------
  // 3. Relative markdown links
  // -------------------------------------------------------------------------

  it("every relative markdown link resolves (would not 404 on GitHub)", () => {
    const violations: Array<Violation> = []
    for (const doc of linkedDocs()) {
      for (const [i, line] of doc.raw.entries()) {
        for (const match of line.matchAll(
          /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        )) {
          const target = match[1]
          if (/^(?:[a-z][a-z0-9+.-]*:|#|<|\/\/)/i.test(target)) continue
          const path = decodeURIComponent(
            target.split("#")[0].split("?")[0],
          ).trim()
          if (path === "" || PLACEHOLDER.test(path)) continue
          const resolved = normalize(join(dirname(doc.path), path))
          if (resolved.startsWith("..")) continue // escapes the repo; not ours
          if (existsSync(join(REPO_ROOT, resolved))) continue
          violations.push({
            file: doc.path,
            line: i + 1,
            reference: `](${target})`,
            problem: `resolves to ${resolved}, which does not exist.`,
            fix:
              /\.\w+$/.test(path) ?
                "Correct the target path."
              : `Markdown links need the file extension — GitHub does not strip it. Try ${path}.md`,
          })
        }
      }
    }
    expect(report("relative links", violations)).toBe("")
  })

  // -------------------------------------------------------------------------
  // 4. Workflow filenames
  // -------------------------------------------------------------------------

  it("every workflow named in prose exists under .github/workflows/", () => {
    const workflows = new Set(
      new Glob("*.yml").scanSync(join(REPO_ROOT, ".github/workflows")),
    )
    const violations: Array<Violation> = []
    const add = (
      at: { doc: Doc; line: number },
      reference: string,
      name: string,
    ): void => {
      violations.push({
        file: at.doc.path,
        line: at.line + 1,
        reference,
        problem: `.github/workflows/${name} does not exist.`,
        fix: `Workflows in this repo: ${[...workflows].sort().join(", ")}. Re-point the reference, or say explicitly that ${name} is absent.`,
      })
    }

    for (const doc of enforcedDocs()) {
      // (a) Path form, anywhere in prose — the unambiguous case.
      for (const [i, line] of doc.prose.entries()) {
        for (const match of line.matchAll(
          /(?<![\w/-])\.github\/workflows\/([\w.-]+\.ya?ml)/g,
        )) {
          const name = match[1]
          if (workflows.has(name) || isNegated(doc, i)) continue
          add({ doc, line: i }, `.github/workflows/${name}`, name)
        }
      }

      // (b) Bare backticked filename. Only when the ENTIRE code span is the
      // filename: that rules out `stuffbucket/repoman/.github/workflows/
      // triage-reusable.yml@v1` and every other owner-prefixed or `@ref`-
      // pinned reference to somebody else's workflow. Dotfiles (`.stats.yml`)
      // and `.yaml` (winget manifests, tool configs) are out of scope too.
      for (const { line, token } of codeSpans(doc)) {
        if (!/^[a-z0-9][\w.-]*\.yml$/i.test(token)) continue
        if (NON_WORKFLOW_YML.has(token)) continue
        if (workflows.has(token) || isNegated(doc, line)) continue
        add({ doc, line }, `\`${token}\``, token)
      }
    }
    expect(report("workflow references", violations)).toBe("")
  })

  // -------------------------------------------------------------------------
  // 5. ADR-to-ADR references
  // -------------------------------------------------------------------------

  /**
   * `docs/decisions` is exempt from the path check above because an ADR cites
   * the code as it stood when the decision was made. That reasoning covers
   * `src/…` and `tests/…`; it does not cover a reference to a *sibling ADR*,
   * which is not a point-in-time citation — the file either exists or the
   * reader gets a 404. That gap is how ADR-0014 kept pointing at ADR-0013 for
   * months after the core split deleted it.
   *
   * Scanned over RAW lines, because these references live in YAML frontmatter
   * (`related_adrs:`, `supersedes:`) as often as in prose, and frontmatter is
   * not an inline code span.
   *
   * An ADR that genuinely lives in the parent repo is cited by its full URL;
   * `https://github.com/…/docs/decisions/0013-…md` contains this pattern as a
   * substring, so URL-embedded matches are skipped. The bare `ADR-NNNN` prose
   * form is deliberately NOT checked: several ADRs here were inherited from
   * `stuffbucket/maximal` and legitimately cite parent-repo ADRs (0002, 0004,
   * 0012) that never existed in core, so checking it would fire on correct
   * text. Precision over recall, as above.
   */
  it("every ADR reference to a sibling ADR resolves", () => {
    const violations: Array<Violation> = []
    const adrRef = /docs\/decisions\/\d{4}-[a-z0-9-]+\.md/g
    for (const path of allDocs().filter((p) => inTree(p, "docs/decisions"))) {
      const doc = buildDoc(path)
      for (const [i, line] of doc.raw.entries()) {
        for (const match of line.matchAll(adrRef)) {
          // Part of an absolute URL — points at another repo, not at us.
          if (/https?:\/\/\S*$/.test(line.slice(0, match.index))) continue
          if (existsSync(join(REPO_ROOT, match[0]))) continue
          if (isNegated(doc, i)) continue
          violations.push({
            file: doc.path,
            line: i + 1,
            reference: match[0],
            problem: `${match[0]} does not exist in this repo.`,
            fix: "If the ADR lives in stuffbucket/maximal, cite it by full URL. If it was dropped outright, say so at the citation — do not silently delete the reference.",
          })
        }
      }
    }
    expect(report("ADR cross-references", violations)).toBe("")
  })

  // -------------------------------------------------------------------------
  // 6. The ADR namespace
  // -------------------------------------------------------------------------

  /**
   * The check above can only resolve a citation of the form
   * `docs/decisions/NNNN-slug.md`. A file in `docs/decisions/` that is not
   * named that way is therefore invisible to it — uncitable by the convention
   * and unenforced by the mechanism. This closes the namespace so that gap
   * cannot reappear.
   *
   * Cheap and precision-safe by construction: it reads a directory listing and
   * tests filenames against the same shape the citation regex already assumes.
   * The only way to fail is to add a file to `docs/decisions/` that is not a
   * numbered ADR, which is exactly the event worth a red result.
   *
   * No exemptions, deliberately. The one unnumbered file this would have caught
   * (`site-runtime-version-manifest.md`) was a misfiled spec, not a decision
   * record, and was moved to `docs/spec/` rather than allow-listed here. An
   * allow-list on a check whose whole job is naming would only be a slower way
   * of not enforcing it.
   */
  it("every file in docs/decisions is a numbered ADR", () => {
    const unnumbered = allDocs()
      .filter((p) => inTree(p, "docs/decisions"))
      .map((p) => p.slice("docs/decisions/".length))
      .filter((n) => !/^\d{4}-[a-z0-9-]+\.md$/.test(n))

    expect(
      unnumbered.length === 0 ?
        ""
      : `Not named as ADRs, so no ADR can cite them and the cross-reference check above cannot see them: ${unnumbered.join(", ")}.\n`
          + "  Rename to docs/decisions/NNNN-slug.md, or move the file to docs/spec/ if it is a spec rather than a decision.\n",
    ).toBe("")
  })

  // -------------------------------------------------------------------------
  // Keep the exclusion list honest
  // -------------------------------------------------------------------------

  it("every excluded doc still exists", () => {
    const stale = [...EXCLUDED_TREES, ...EXCLUDED_FILES]
      .filter((e) => !existsSync(join(REPO_ROOT, e.path)))
      .map((e) => e.path)
    expect(
      stale.length === 0 ?
        ""
      : `Excluded from docs-reference-parity but no longer present: ${stale.join(", ")}. Remove the entry.`,
    ).toBe("")
  })
})

/**
 * Turn an inline code span into a repo-relative path to test, or null if it is
 * not a path reference at all.
 */
function normalizeCandidate(token: string): string | null {
  // `src/lib/utils.ts:23 cacheModels()` — keep the first whitespace-delimited
  // word only.
  let candidate = token.split(/\s/)[0]
  if (PLACEHOLDER.test(candidate) || candidate.includes("://")) return null
  // `src/server.ts:58-112`, `src/debug.ts:90-95`, `src/routes/x.ts:49,127`
  candidate = candidate.replace(/:\d+(?:[-,]\d+)*$/, "")
  candidate = candidate.replace(/[.,;:]+$/, "")
  if (!PATH_ROOTS.some((root) => candidate.startsWith(`${root}/`))) return null
  if (candidate.endsWith("/")) candidate = candidate.slice(0, -1)
  return candidate === "" ? null : candidate
}
