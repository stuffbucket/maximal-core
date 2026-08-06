#!/usr/bin/env bun
/**
 * check-ci-coverage.ts — what `bun run ci:check` runs. Every step of
 * `check:deep` must also run in a required CI job, or it is a red build.
 *
 * WHY: `dupes:check` landed in `check:deep` and in no workflow (#61);
 * `.dependency-cruiser.cjs` sat in the repo, correct and uninvoked, for
 * months. A gate that runs nowhere makes the build green for free.
 *
 * THE EXPECTATION IS DERIVED, NOT RECORDED. Both sides are read from the repo
 * — `check:deep` from package.json, the steps from the workflows — so there is
 * no baseline to bump. `EXCLUDED` is the one hand-written part, and it is a
 * policy like `check-rulesets.ts`'s `EXPECTED`, not a last-reviewed value like
 * `external-drift-baseline.json`: typed, unit-tested, `why` required, and
 * stale entries fail (see below). It is empty today.
 *
 * "RUNS IN CI" = named by a step of a job that is a REQUIRED status check
 * (`CHECK_JOBS` in check-rulesets.ts), not "appears somewhere in a workflow".
 * A comment is not a step, and a job that is not required — or is path-filtered
 * like tooling-ci.yml's — can be red with the merge button still green.
 * `check:deep` is composite and CI runs its constituents as separate named
 * steps, so composite members are expanded to the scripts CI actually names.
 * The match is on the invocation `bun run <script>` (arguments are not
 * compared); `bun test` is matched as the literal command.
 *
 * ONE DIRECTION ONLY. A CI step that is not in `check:deep` does not fail
 * here. CI legitimately runs what `check:deep` cannot — `bun install`, the
 * Windows artifact leg, `test:ops` — so the reverse assertion would need a
 * second, churnier exclusion list to buy nothing: those steps do run, and are
 * blocking. The hole this closes is a check that runs NOWHERE.
 *
 * Exit codes: 0 every member is covered · 1 a member runs in no required job,
 * or `EXCLUDED` is stale · 2 the repo could not be read (a renamed job, an
 * unparseable script).
 */

import fs from "node:fs"

import { CHECK_JOBS, repoPath } from "./check-rulesets"

/** A `check:deep` member deliberately not run in CI. `why` is mandatory. */
export interface Exclusion {
  /** The script name, or the raw command, as `check:deep` runs it. */
  readonly step: string
  readonly why: string
}

/**
 * Empty on purpose: everything `check:deep` runs is currently a required CI
 * step. An entry here is a claim that a check does not belong in CI, and it is
 * checked in both directions — a step that is excluded but does run, or that
 * `check:deep` no longer runs at all, fails this gate rather than lingering.
 */
export const EXCLUDED: ReadonlyArray<Exclusion> = []

// --- what check:deep runs ---

/** One command `check:deep` ultimately runs. */
export interface Step {
  /** `<script>` for `bun run <script>`, else the raw command. Its identity. */
  readonly name: string
  /** True when `name` is a package.json script rather than a raw command. */
  readonly isScript: boolean
  /** Scripts it was reached through, `check:deep` first. */
  readonly via: ReadonlyArray<string>
}

/** `&&` is the whole grammar this reads; anything else is refused, not guessed. */
const isUnparseable = (body: string): boolean => /[|;&]/u.test(body.replaceAll("&&", ""))

/**
 * `check:deep` flattened to the commands CI has to name. A member that is
 * itself a composite script (`check:fast`) is expanded, because CI runs its
 * constituents as separate steps; a single-command script is not, because CI
 * invokes it by name.
 */
export function expand(
  scripts: Readonly<Record<string, string>>,
  entry = "check:deep",
  via: ReadonlyArray<string> = [],
): Array<Step> {
  const body = scripts[entry]
  if (body === undefined) throw new Error(`package.json has no \`${entry}\` script`)
  if (via.includes(entry)) throw new Error(`\`${entry}\` is defined in terms of itself`)
  if (isUnparseable(body)) {
    throw new Error(
      `\`${entry}\` uses shell this check cannot read (only \`&&\` is supported): ${body}`,
    )
  }

  const chain = [...via, entry]
  const out: Array<Step> = []
  for (const part of body.split("&&").map((p) => p.trim())) {
    if (part === "") continue
    const script = /^bun run (\S+)/u.exec(part)?.[1]
    if (script !== undefined && (scripts[script] ?? "").includes("&&")) {
      out.push(...expand(scripts, script, chain))
      continue
    }
    out.push({ name: script ?? part, isScript: script !== undefined, via: chain })
  }
  return out
}

// --- what a required job runs ---

/** A required status check's job, and every shell line its steps execute. */
export interface Job {
  /** `<job id> (<workflow path>)`, as reported. */
  readonly label: string
  readonly commands: ReadonlyArray<string>
}

/**
 * The lines of one top-level job. Textual, for the reason check-rulesets.ts
 * gives: the ops lane has no `node_modules`, so a YAML parser here would mean a
 * new install in three workflows.
 */
export function jobBlock(yaml: string, jobId: string): string | undefined {
  const lines = yaml.split("\n")
  const start = lines.findIndex((l) => l.startsWith(`  ${jobId}:`))
  if (start < 0) return undefined
  const out: Array<string> = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*$/u.test(line)) {
      out.push(line)
      continue
    }
    if (/^ {0,2}\S/u.test(line)) break // column 0 or another job id
    out.push(line)
  }
  return out.join("\n")
}

/**
 * The shell lines a block's `run:` steps execute — inline scalars and block
 * scalars alike, with YAML comments dropped. A `bun run x` inside a `#` comment
 * is documentation, and this check exists precisely because documentation and
 * execution drift apart.
 */
export function runLines(block: string): Array<string> {
  const lines = block.split("\n")
  const out: Array<string> = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (/^\s*#/u.test(line)) continue
    const key = /^(\s*(?:- )?)run:(.*)$/u.exec(line)
    if (!key) continue
    const indent = (key[1] ?? "").length
    const inline = (key[2] ?? "").trim()
    if (inline !== "" && !/^[|>][+-]?$/u.test(inline)) {
      out.push(inline)
      continue
    }
    for (i += 1; i < lines.length; i += 1) {
      const body = lines[i] ?? ""
      if (body.trim() === "") continue
      if (body.search(/\S/u) <= indent) break
      if (!/^\s*#/u.test(body)) out.push(body.trim())
    }
    i -= 1
  }
  return out
}

const escape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)

/** Whether `commands` invoke `step` — by script name, or as the literal command. */
export function runsStep(commands: ReadonlyArray<string>, step: Step): boolean {
  const pattern = step.isScript
    ? new RegExp(String.raw`(?:^|[\s(])bun run ${escape(step.name)}(?![\w:./-])`, "u")
    : new RegExp(String.raw`(?:^|[\s(])${escape(step.name)}(?:\s+-|\s*$)`, "u")
  return commands.some((command) => pattern.test(command))
}

// --- evaluation (pure) ---

export interface Report {
  readonly covered: Array<{ step: Step; jobs: Array<string> }>
  readonly missing: Array<Step>
  readonly excluded: Array<Exclusion>
  /** An `EXCLUDED` entry that no longer describes reality. Blocking. */
  readonly stale: Array<string>
}

export function coverage(
  steps: ReadonlyArray<Step>,
  jobs: ReadonlyArray<Job>,
  excluded: ReadonlyArray<Exclusion> = EXCLUDED,
): Report {
  const report: Report = { covered: [], missing: [], excluded: [], stale: [] }

  for (const step of steps) {
    const where = jobs.filter((job) => runsStep(job.commands, step)).map((job) => job.label)
    const exclusion = excluded.find((e) => e.step === step.name)
    if (exclusion) {
      report.excluded.push(exclusion)
      if (where.length > 0) {
        report.stale.push(
          `\`${step.name}\` is excluded — "${exclusion.why}" — but ${where.join(", ")} runs it. Delete the exclusion.`,
        )
      }
      continue
    }
    if (where.length === 0) report.missing.push(step)
    else report.covered.push({ step, jobs: where })
  }

  const names = new Set(steps.map((s) => s.name))
  for (const entry of excluded) {
    if (!names.has(entry.step)) {
      report.stale.push(
        `\`${entry.step}\` is excluded but \`check:deep\` no longer runs it. Delete the exclusion.`,
      )
    }
  }

  return report
}

export const exitCodeFor = (report: Report): number =>
  report.missing.length > 0 || report.stale.length > 0 ? 1 : 0

export function render(report: Report, jobs: ReadonlyArray<Job>): string {
  const lines: Array<string> = []
  for (const { step, jobs: where } of report.covered) {
    lines.push(`ok      ${step.name.padEnd(22)} ${where.join(", ")}`)
  }
  for (const entry of report.excluded) {
    lines.push(`skip    ${entry.step.padEnd(22)} excluded: ${entry.why}`)
  }
  for (const step of report.missing) {
    const via = step.via.slice(1)
    lines.push(
      `MISSING ${step.name.padEnd(22)} ${via.length > 0 ? `via ${via.join(" > ")}; ` : ""}no required job runs ${step.isScript ? `\`bun run ${step.name}\`` : `\`${step.name}\``}`,
    )
  }
  for (const problem of report.stale) lines.push(`STALE   ${problem}`)

  if (report.missing.length > 0) {
    lines.push(
      "",
      `Every \`check:deep\` step must run in one of: ${jobs.map((j) => j.label).join(", ")}.`,
      "Add a step to the workflow, or record the step in `EXCLUDED` in this file with the reason it does not belong in CI.",
    )
  }
  return lines.join("\n")
}

// --- entry point ---

/** The required jobs, read from disk. Throws if a job named as required is gone. */
export function readJobs(check: ReadonlyArray<{ context: string; workflow: string }> = CHECK_JOBS): Array<Job> {
  return check.map(({ context, workflow }) => {
    const block = jobBlock(fs.readFileSync(repoPath(workflow), "utf8"), context)
    if (block === undefined) {
      throw new Error(
        `${workflow} defines no \`${context}\` job, but \`${context}\` is a required status check (see CHECK_JOBS in check-rulesets.ts).`,
      )
    }
    return { label: `${context} (${workflow})`, commands: runLines(block) }
  })
}

export function readScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(repoPath("package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
  return pkg.scripts ?? {}
}

if (import.meta.main) {
  try {
    const jobs = readJobs()
    const report = coverage(expand(readScripts()), jobs)
    console.error(render(report, jobs))
    const code = exitCodeFor(report)
    if (code === 0) console.error("Every `check:deep` step runs in a required CI job.")
    process.exit(code)
  } catch (err) {
    console.error(`check-ci-coverage: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
}
