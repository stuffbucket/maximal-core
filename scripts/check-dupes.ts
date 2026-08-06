/**
 * check-dupes.ts — what `bun run dupes:check` runs. jscpd, plus a down-only
 * ratchet on the pairs of files that share copy-pasted code.
 *
 *   bun run dupes                 # inventory: every clone, grouped, with numbers
 *   bun run dupes:check           # the gate (check:deep runs this)
 *   bun run dupes:check --update  # re-record after removing a duplication
 *
 * ─── What was measured before any of this was designed ───────────────────────
 * jscpd over `src`, `tests` and `scripts`, TypeScript only, at three settings:
 *
 *   min-tokens   clones   duplicated lines
 *   30            457     6.15%
 *   50            119     2.48%
 *   100            13     0.55%
 *
 * and at min-tokens 50, split by tree:
 *
 *   src        167 files   0.33%    10 clones    9 of them inside one file
 *   scripts     28 files   0.95%    11 clones
 *   tests      138 files   5.16%    96 clones
 *
 * Three things follow, and between them they picked every number in this file.
 *
 * **50 is the floor.** At 30 the cross-file matches in `src` go from 1 to 17,
 * and the new 16 are import blocks (`create-chat-completions.ts` ↔
 * `create-responses.ts`, lines 1–8) and the parallel route-handler idiom
 * (`chat-completions/handler.ts` ↔ `responses/handler.ts`, three times). Those
 * are the shape of the codebase, not a defect in it. `scripts/dev/e2e-feed.ts`
 * ↔ `e2e-seam.ts` starts matching there too — the check/reporter idiom every
 * e2e script shares. A detector that reports those gets turned off, and then
 * detects nothing.
 *
 * **`tests/**` is not gated.** 96 of the 119 clones are there, and reading them
 * they are near-identical *test bodies* — `messages-preprocess-pdf-attachments`
 * against itself 13 times, `auth-controller-lifecycle` against
 * `auth-controller` 6 times. A test that repeats its neighbour's structure with
 * one field changed is usually correct, and deduplicating it into a table costs
 * the thing tests are for: reading the failure and knowing what broke. They are
 * in `--list` so they can be looked at, and out of the gate so nobody is forced
 * to.
 *
 * **`scripts/**` is not gated either**, for a smaller reason: it is tooling,
 * not the product, and its one real pair (`release-gates.ts` ↔
 * `release-notes.ts`) is release plumbing that another workstream is actively
 * moving. Gating it would fail PRs on churn in a tree the gate has no opinion
 * about.
 *
 * ─── Why a pair of files, and not a percentage ───────────────────────────────
 * The obvious gate is jscpd's own `--threshold`: fail over N% duplication. It
 * cannot work here, and the arithmetic says so. `src` is 31,363 lines at 0.33%.
 * A 40-line function copy-pasted into a second file moves that to 0.46%. Fifty
 * of them would still sit under 1%. So any threshold loose enough to be green
 * today is loose enough to swallow every copy-paste anyone will actually
 * commit, and the gate would report success for the entire class of event it
 * exists to catch. This is the same argument `check-deps.ts` makes against
 * counting cycles, and it lands harder here because the denominator is bigger.
 *
 * So the ratchet holds a SET, as `check-deps.ts` does. The identity has to be
 * something an unrelated edit cannot perturb, which rules out the obvious
 * candidate: a clone is reported as two line ranges, and inserting a line
 * anywhere above one of them rewrites the entry. A baseline that churns on
 * every edit gets `--update`d reflexively, which is the same as not having one.
 *
 * The **unordered pair of files** is invariant under that. It also matches what
 * a reviewer wants to know — "these two files share copy-pasted code" — and it
 * is what changes when someone actually copies code: a new pair appears.
 *
 * ─── Cross-file only ─────────────────────────────────────────────────────────
 * 92 of the 119 clones are a file against itself, and in `src` it is 9 of 10:
 * two nearly-identical SSE event branches in
 * `responses-stream-translation.ts`, two arms of a settings endpoint. Those are
 * a local factoring question, visible in the diff that creates them, and the
 * reviewer is already looking at the file. Cross-file duplication is the case
 * where nobody sees both halves — which is exactly the case worth mechanizing.
 * Intra-file clones stay in `--list`.
 *
 * ─── What this does NOT catch, stated plainly ────────────────────────────────
 * This tool finds copy-paste. It does not find *reimplementation*. The question
 * that prompted building it — "was this port fix implemented twice, two
 * different ways?" — is one jscpd cannot answer, because two different
 * implementations of the same idea share no tokens. Nothing here should be read
 * as covering that. It covers the other half of the class, the literal half.
 *
 * It is also pair-granular by construction: a *second* copy-paste between two
 * files that already share one does not add a pair, so it passes. That is the
 * same limitation `check-deps.ts` accepts for its edges, for the same reason —
 * the alternative identity is not stable enough to be worth the precision.
 *
 * When the list reaches zero, delete it and this ratchet with it.
 */
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const CONFIG = path.join(ROOT, ".jscpd.json")

/** Gated. The product; the thing a consumer installs. */
const GATED_PATHS = ["src"]
/** Reported by `--list`, never gated. See the header for why each is out. */
const REPORTED_PATHS = ["src", "tests", "scripts"]

const argv = process.argv.slice(2)
const UPDATE = argv.includes("--update")
const LIST = argv.includes("--list")

// --- BEGIN KNOWN DUPLICATE PAIRS — generated by `bun run dupes:check --update` ---
const KNOWN_DUPLICATE_PAIRS = [
  "src/services/github/poll-access-token.ts <-> src/services/github/refresh-access-token.ts",
]
// --- END KNOWN DUPLICATE PAIRS ---

interface CloneFile {
  name: string
  start: number
  end: number
}
interface Clone {
  firstFile: CloneFile
  secondFile: CloneFile
  lines: number
  tokens: number
}
interface JscpdReport {
  duplicates: Clone[]
  statistics: {
    total: {
      clones: number
      duplicatedLines: number
      lines: number
      percentage: number
      sources: number
    }
  }
}

/**
 * Run jscpd and read its JSON report.
 *
 * The report goes to a temp dir **outside** the repo: writing it into the tree
 * would make the detector's own output a file the detector then scans, and
 * would need a `.gitignore` entry to stay out of commits.
 *
 * `--absolute` is not cosmetic. Without it jscpd strips the common prefix of
 * whatever paths it was given, so scanning `src tests scripts` reports
 * `lib/live/client.ts` and `dev/harness/feed.ts` — two different trees,
 * indistinguishable, and the baseline keys would collide. Absolute paths are
 * relativized against ROOT here instead, which is well-defined.
 */
async function detect(paths: string[]): Promise<JscpdReport> {
  const out = path.join(
    process.env.TMPDIR ?? "/tmp",
    `jscpd-${process.pid}-${Date.now()}`,
  )
  const entry = path.join(ROOT, "node_modules/jscpd/run-jscpd.js")
  const proc = Bun.spawn(
    [
      process.execPath,
      entry,
      ...paths,
      "--config",
      CONFIG,
      "--absolute",
      "--no-colors",
      "--reporters",
      "json",
      "--output",
      out,
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  )
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  const file = Bun.file(path.join(out, "jscpd-report.json"))
  if (!(await file.exists())) {
    console.error("✖ jscpd did not produce a report.")
    if (stderr.trim()) console.error(stderr.trim())
    process.exit(1)
  }
  const parsed = (await file.json()) as JscpdReport
  if (!Array.isArray(parsed.duplicates)) {
    console.error("✖ jscpd report had no `duplicates` array.")
    process.exit(1)
  }
  return parsed
}

const rel = (absolute: string): string =>
  path.relative(ROOT, absolute).replaceAll(path.sep, "/")

/** The unordered pair of files a clone spans, sorted so the key is canonical. */
const pairId = (a: string, b: string): string =>
  [a, b].sort((x, y) => x.localeCompare(y)).join(" <-> ")

/** Cross-file pairs only, mapped to the clones that produced them. */
function crossFilePairs(report: JscpdReport): Map<string, Clone[]> {
  const pairs = new Map<string, Clone[]>()
  for (const clone of report.duplicates) {
    const a = rel(clone.firstFile.name)
    const b = rel(clone.secondFile.name)
    if (a === b) continue
    const id = pairId(a, b)
    pairs.set(id, [...(pairs.get(id) ?? []), clone])
  }
  return pairs
}

async function writeKnown(pairs: string[]): Promise<void> {
  const self = import.meta.path
  const source = await Bun.file(self).text()
  const body = pairs.map((pair) => `  ${JSON.stringify(pair)},`).join("\n")
  const next = source.replace(
    /(\/\/ --- BEGIN KNOWN DUPLICATE PAIRS[^\n]*\nconst KNOWN_DUPLICATE_PAIRS = \[\n)[\s\S]*?(\n\]\n\/\/ --- END KNOWN DUPLICATE PAIRS ---)/,
    (_match, head: string, tail: string) => `${head}${body}${tail}`,
  )
  if (next === source) {
    console.error("✖ could not locate the generated block in check-dupes.ts.")
    process.exit(1)
  }
  await Bun.write(self, next)
}

const describeClone = (clone: Clone): string => {
  const a = rel(clone.firstFile.name)
  const b = rel(clone.secondFile.name)
  return (
    `${a}:${clone.firstFile.start}-${clone.firstFile.end}` +
    `  ==  ${b}:${clone.secondFile.start}-${clone.secondFile.end}` +
    `  (${clone.lines} lines, ${clone.tokens} tokens)`
  )
}

if (LIST) {
  const report = await detect(REPORTED_PATHS)
  const stats = report.statistics.total
  console.log(
    `${stats.clones} clone(s) over ${stats.sources} file(s): ` +
      `${stats.duplicatedLines} of ${stats.lines} lines duplicated ` +
      `(${stats.percentage.toFixed(2)}%), at min-tokens 50.\n`,
  )

  const pairs = crossFilePairs(report)
  const gated = [...pairs.keys()].filter((id) =>
    GATED_PATHS.some((dir) => id.split(" <-> ").every((f) => f.startsWith(`${dir}/`))),
  )
  console.log(`── cross-file (${pairs.size} pair(s); ${gated.length} gated) ──\n`)
  for (const [id, clones] of [...pairs.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    console.log(`${gated.includes(id) ? "GATE" : "    "}  ${id}  ×${clones.length}`)
    for (const clone of clones) console.log(`        ${describeClone(clone)}`)
  }

  const intra = report.duplicates.filter(
    (c) => rel(c.firstFile.name) === rel(c.secondFile.name),
  )
  console.log(`\n── inside one file (${intra.length} clone(s); never gated) ──\n`)
  const byFile = new Map<string, number>()
  for (const clone of intra) {
    const name = rel(clone.firstFile.name)
    byFile.set(name, (byFile.get(name) ?? 0) + 1)
  }
  for (const [name, count] of [...byFile.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    console.log(`      ${name}  ×${count}`)
  }
  process.exit(0)
}

const report = await detect(GATED_PATHS)
const pairs = crossFilePairs(report)
const current = [...pairs.keys()].sort((a, b) => a.localeCompare(b))
const known = new Set(KNOWN_DUPLICATE_PAIRS)
const added = current.filter((pair) => !known.has(pair))
const gone = KNOWN_DUPLICATE_PAIRS.filter((pair) => !pairs.has(pair))

if (UPDATE) {
  if (added.length > 0) {
    console.error(
      `\n✖ --update refuses to record ${added.length} NEW duplicated pair(s). The\n` +
        `  ratchet only releases downward; remove the duplication instead:`,
    )
    for (const pair of added) {
      console.error(`  + ${pair}`)
      for (const clone of pairs.get(pair) ?? []) {
        console.error(`      ${describeClone(clone)}`)
      }
    }
    process.exit(1)
  }
  await writeKnown(current)
  console.log(
    gone.length > 0 ?
      `✔ recorded ${current.length} duplicated pair(s) — ${gone.length} fewer than before.`
    : `✔ recorded ${current.length} duplicated pair(s) — unchanged.`,
  )
  process.exit(0)
}

let failed = false

if (added.length > 0) {
  failed = true
  console.error(
    `✖ ${added.length} new duplicated file pair(s) in ${GATED_PATHS.join(", ")}:\n`,
  )
  for (const pair of added) {
    console.error(`  + ${pair}`)
    for (const clone of pairs.get(pair) ?? []) {
      console.error(`      ${describeClone(clone)}`)
    }
  }
  console.error(
    `\n  Extract the shared part, or restructure so the copy is not needed.\n` +
      `  This list is down-only: --update will not record a new pair.`,
  )
}

if (gone.length > 0) {
  failed = true
  console.error(
    `\n✖ ${gone.length} recorded duplicated pair(s) no longer exist. Nice — now\n` +
      `  re-record so they cannot come back unnoticed:\n\n` +
      `      bun run dupes:check --update\n`,
  )
  for (const pair of gone) console.error(`  - ${pair}`)
}

if (failed) process.exit(1)

console.log(
  `✔ no new duplicated file pairs in ${GATED_PATHS.join(", ")} ` +
    `(${current.length} known, ${report.statistics.total.percentage.toFixed(2)}% overall). ` +
    `\`bun run dupes\` for the full inventory.`,
)
