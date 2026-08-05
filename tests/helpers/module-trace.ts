/**
 * Opt-in module-evaluation tracer for `bun test`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The cross-file leak class documented in `docs/dev/testing-strategy.md` §5.1
 * and §5.6 is caused by something the test log never shows. Bun's reporter
 * prints one line per *test*, in *execution* order. But a `mock.module`
 * installed at module scope takes effect during the **evaluation** phase, and a
 * module-scope singleton is written during evaluation too. The causal event
 * therefore happens in a phase no line of the log covers, and the stack trace of
 * the eventual failure names the victim file, never the writer.
 *
 * This module makes that phase observable. It is loaded ONLY when
 * `MAXIMAL_TEST_TRACE` is set (see `tests/test-setup.ts`), so a normal run pays
 * one `process.env` read and nothing else.
 *
 * WHAT IT RECORDS
 * ---------------
 *  - `NNNN eval <file>` — a module body started executing, in real order.
 *    Implemented with a `Bun.plugin` `onLoad` hook that prepends a marker call
 *    to the module source. The marker sits *after* the import declarations in
 *    evaluation order (ESM evaluates a module's dependencies before its body),
 *    so it is a true "body entered" event, not a "file was read" event.
 *  - `NNNN mock.module <specifier> <- <file>:<line>:<col>` — every
 *    `mock.module` install, attributed to its call site by stack trace, with the
 *    resolved target path when it differs from the written specifier (so
 *    `~/lib/auth/secrets` and `../src/lib/auth/secrets` collapse to one target),
 *    whether it landed at `module-scope` or `in-test`, and how many module
 *    evaluations preceded it. This is the (writer, module) pair that otherwise
 *    has to be inferred. The repo's convention pairs a `module-scope` install
 *    with an `in-test` restore of the same target, so an UNPAIRED
 *    `module-scope` install is the leak.
 *  - `NNNN first-test-starts` — the first test hook to fire, so the
 *    evaluate/execute boundary is visible in the same stream. Its count
 *    re-verifies Bun's scheduling model on whatever version the run used.
 *
 * Every line is prefixed `[test-trace]` and written to stdout, the same stream
 * Bun's reporter uses, so in GitHub Actions the lines interleave with the
 * reporter's own `##[group]tests/<file>.test.ts:` headers and `(pass)`/`(fail)`
 * lines. That interleaving IS the correlation mechanism — the trace deliberately
 * does not go to a side channel.
 *
 * WHAT IT PROVABLY CANNOT RECORD
 * ------------------------------
 *  - **Which sibling read a leaked binding.** That needs instrumentation of
 *    every imported binding's access, not of module entry. The trace narrows the
 *    suspects to "modules evaluated after the install"; it does not name the
 *    victim.
 *  - **Modules Bun does not route through the plugin loader** — `node:*` and
 *    `bun:*` builtins, `node_modules/**` (deliberately excluded: `onLoad` must
 *    return an object, so a matched file cannot be waved through untouched, and
 *    re-emitting a CJS dependency under an explicit loader breaks it), and the
 *    preload chain itself, which has already been evaluated when the plugin
 *    registers.
 *  - **An end-of-run summary.** `bun test` does not fire `process.on("exit")` or
 *    `"beforeExit"` (verified on 1.3.11), and Bun exposes no run-level teardown
 *    hook, so there is nowhere to print a recap from. Extract one from the log
 *    instead: `grep 'test-trace.*mock.module' ci.log`.
 *  - **Which test file is executing during the run phase.** Bun 1.3.11 has no
 *    `expect.getState().testPath` and no per-file hook. In CI the reporter's
 *    group headers supply it; locally the default reporter prints no per-test
 *    lines, so run-phase events are located by their call site instead.
 *  - **The run's ordering seed.** `bun test` only assigns one under
 *    `--randomize`, and it prints it itself. The trace records the *resulting*
 *    order, which is the thing a seed would have been used to reconstruct.
 */
import { beforeAll, beforeEach, mock } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/** Repo root: this file is `<root>/tests/helpers/module-trace.ts`. */
const ROOT = path.resolve(import.meta.dir, "..", "..")

const PREFIX = "[test-trace]"

/**
 * `tests` traces the test tree only. `all` adds `src/**`, which is what you want
 * when chasing a plain module-level singleton (§5.6) rather than a mock.
 */
type TraceMode = "tests" | "all"

type TraceGlobal = typeof globalThis & {
  __maximalTestTraceEval?: (file: string) => void
}

let evaluations = 0
let runPhase = false
let step = 0
/** The module whose body is currently executing, if one is. */
let evaluating: string | undefined

function emit(line: string): void {
  process.stdout.write(`${PREFIX} ${line}\n`)
}

function tick(): string {
  step += 1
  return String(step).padStart(4, "0")
}

function relative(absolute: string): string {
  const rel = path.relative(ROOT, absolute)
  return rel && !rel.startsWith("..") ? rel : absolute
}

/**
 * First stack frame outside this file — the `mock.module` caller. Bun frames
 * look like `    at fn (/abs/path.ts:12:9)` or `    at /abs/path.ts:12:9`.
 */
function callSite(stack: string | undefined): {
  file: string | undefined
  display: string
} {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = /(\/[^\s()]+):(\d+):(\d+)\)?$/.exec(line.trim())
    if (!match) continue
    const [, file, row, column] = match
    if (file === import.meta.path) continue
    return { file, display: `${relative(file)}:${row}:${column}` }
  }
  return { file: undefined, display: "<unknown call site>" }
}

function noteEval(file: string): void {
  evaluations += 1
  evaluating = file
  emit(`${tick()} eval  ${file}`)
}

/**
 * Prepend the marker WITHOUT a trailing newline. Every line number in the file
 * is preserved, so failure stack traces stay accurate; only column numbers on
 * one line shift.
 *
 * A shebang is only a shebang at offset 0, so for the CLI entrypoints
 * (`src/main.ts`, `src/debug.ts`, …) the marker goes at the start of line 2
 * instead. Getting this wrong is a syntax error inside a module body, which
 * surfaces as the run hanging rather than failing.
 */
function markSource(absolute: string): string {
  const source = readFileSync(absolute, "utf8")
  const marker = `globalThis.__maximalTestTraceEval?.(${JSON.stringify(relative(absolute))});`
  if (!source.startsWith("#!")) return marker + source
  const firstLineEnd = source.indexOf("\n")
  if (firstLineEnd === -1) return source
  return (
    source.slice(0, firstLineEnd + 1) + marker + source.slice(firstLineEnd + 1)
  )
}

/**
 * Anchored at the repo root and at first-party source dirs, because the filter
 * is the only safe way to opt a file out of the loader hook (see the
 * `node_modules` note in the header comment).
 */
function filterFor(mode: TraceMode): RegExp {
  const root = ROOT.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  const dirs = mode === "all" ? "(?:src|tests)" : "tests"
  return new RegExp(`^${root}/${dirs}/.+\\.tsx?$`)
}

function traceMockModule(specifier: string, stack: string | undefined): void {
  const site = callSite(stack)
  let resolved: string | undefined
  try {
    const from = site.file ? path.dirname(site.file) : path.join(ROOT, "tests")
    resolved = relative(Bun.resolveSync(specifier, from))
  } catch {
    resolved = undefined
  }
  const target = resolved && resolved !== specifier ? ` -> ${resolved}` : ""
  // `module-scope` is the leaking shape: the install happens while the file's
  // own body is still running, so it is live for every module evaluated after
  // it and no per-file teardown has had a chance to exist yet. `in-test` means
  // the call came from a test or hook, where the file's own teardown can undo
  // it before the next file is evaluated.
  const scope =
    evaluating !== undefined && site.file && site.file.endsWith(evaluating) ?
      "module-scope"
    : "in-test"
  emit(
    `${tick()} mock.module ${specifier}${target} <- ${site.display} `
      + `(${scope}, after ${String(evaluations)} evals)`,
  )
}

/**
 * Install the tracer. Called from the `bunfig.toml` preload, before any test
 * file is loaded, so the `mock.module` patch and the loader plugin are both in
 * place for the whole run.
 */
export function installModuleTrace(raw: string): void {
  const mode: TraceMode = raw === "all" ? "all" : "tests"

  emit(`enabled mode=${mode} bun=${Bun.version} pid=${String(process.pid)}`)

  const traceGlobal: TraceGlobal = globalThis
  traceGlobal.__maximalTestTraceEval = noteEval

  Bun.plugin({
    name: "maximal-module-trace",
    setup(build) {
      build.onLoad({ filter: filterFor(mode) }, (args) => ({
        contents: markSource(args.path),
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      }))
    },
  })

  // `mock.module` is a writable, configurable own property of the single `mock`
  // object every importer of `bun:test` receives, so patching it here covers
  // every call site in the run without touching `bun:test` itself.
  const realMockModule = mock.module.bind(mock)
  mock.module = (specifier: string, factory: () => unknown) => {
    traceMockModule(specifier, new Error("trace").stack)
    return realMockModule(specifier, factory)
  }

  // Registered in the preload, so these are the OUTERMOST hooks and run before
  // any file's own. Clearing `evaluating` here closes the current module body,
  // so a `mock.module` from a hook or a test is attributed to the run phase
  // rather than to module scope.
  beforeAll(() => {
    evaluating = undefined
  })

  // The count this prints is a per-run check on Bun's scheduling: `1` means Bun
  // interleaves (evaluate a file, run its tests, evaluate the next); a number
  // near the file count would mean it evaluates everything up front.
  beforeEach(() => {
    evaluating = undefined
    if (runPhase) return
    runPhase = true
    emit(
      `${tick()} first-test-starts (${String(evaluations)} modules evaluated so far)`,
    )
  })
}
