# Testing Strategy — maximal

**Status:** Living document, prepared for external review.
**Last updated:** 2026-08-05.
**Audience:** professional software-testing reviewers, plus contributors who
need one place that describes how this project verifies itself.

This document consolidates the project's testing process: what we test, how,
with what tooling, where the gates are, what we deliberately *don't* do, and
the known weaknesses we want a review to pressure-test. It describes the system
**as it actually is today**, and flags aspirational items explicitly as such.

For the terse in-repo pointers this expands on, see
[`docs/architecture.md` → *Testing gotchas*](../architecture.md) and the
project root [`AGENTS.md`](../../AGENTS.md).

---

## How to read & maintain this document

This document separates **durable policy** from **volatile inventory** so a
rename in the codebase can't silently make it wrong — and so keeping it true
costs human judgment only where judgment is actually required:

- **Policy & rationale** — the disposition rule (§6), the leak hazards (§5),
  which gates exist and why (§9) — is the stable core. It survives any
  file/function rename untouched.
- **Anchors** — command names (`bun run …`), config files (`eslint.config.js`,
  `bunfig.toml`, `stryker.conf.json`, `.bun-version`) and ADRs — are named
  directly. Renaming one *is* a policy change, so a doc edit is expected then.
- **Inventory** — concrete `src/…` paths, function names, example test files —
  is kept to a minimum and never used as the load-bearing content of a section.
  Counts come from the `bun test` summary rather than being hand-maintained
  here.

**So the contract is:** a pure rename never requires *rethinking* this document —
at most it re-points a reference.

**`tests/docs-reference-parity.test.ts` enforces the re-pointing half.** It
walks `docs/**`, `README.md` and `AGENTS.md` and fails the build on four
classes of dead reference: a `bun run <script>` with no such script in
`package.json`, a backticked repo path that is not on disk, a relative markdown
link that would 404 on GitHub, and a `*.yml` named as one of this repo's
workflows but absent from `.github/workflows/`.

It is tuned for **precision, not coverage** — a docs test that cries wolf gets
suppressed, and then enforces nothing. It only reads inline code spans, skips
anything holding a glob or a `<placeholder>`, skips paragraphs whose own point
is that the named thing is *absent*, and skips document classes that exist to
record a past state: `docs/archive/**`, `docs/decisions/**` (ADRs),
`docs/spec/**` (PRDs), and any file or section carrying a `>` scope banner. So
it will not catch every stale reference — but anything it does flag is real.
Re-verify the `src/…` paths in the excluded classes by hand when you touch
them.

---

## 1. What this project is (context for the test strategy)

`maximal` is a local HTTP proxy that presents an Anthropic-compatible API
(`/v1/messages`, `/chat/completions`, `/responses`, `/models`, `/embeddings`)
and brokers requests to GitHub Copilot's backend (Bedrock-hosted Claude and
GPT models), translating protocols, rewriting payloads, and managing auth. It
ships as a **CLI / standalone binary** and as a **consumable library**. There is
no UI in this repo; a decoupled tier drives the engine over `/control`.

The testing implications that shape everything below:

- **The proxy is a translation boundary.** Most defects are wrong
  *transformations* of a request/response payload, not crashes. Correctness is
  about the exact shape and field values sent upstream and returned
  downstream. This is why contract/translation tests dominate and why we care
  about mutation testing (a payload can be subtly wrong while every line is
  "covered").
- **Upstream behavior is partly undocumented.** Copilot's endpoint semantics
  (which models support `/responses`, how `thinking.display` surfaces reasoning,
  which sampling params are rejected) are established empirically and can drift.
  Tests pin *our* behavior; they cannot pin the live upstream. See §7.
- **Auth touches real user credentials on disk.** Tests must never read or
  write the developer's real `~/.local/share/maximal` state. This is enforced
  globally (see §4).

---

## 2. Test taxonomy

We do not maintain a formal test-pyramid ratio. In practice the suite
(100+ test files under `tests/`; exact file/assertion counts live in the CI
test-run summary rather than being hand-maintained here)
breaks down into these layers:

| Layer | What it covers | Example files |
|---|---|---|
| **Pure-logic / unit** | Deterministic transforms, parsers, matchers, config resolution | `find-endpoint-model.test.ts`, `copilot-error-parser.test.ts`, `messages-preprocess.test.ts`, `anthropic-id-rewrite.test.ts` |
| **Contract** | The shape of a wire payload or a public response matches a published schema — or a single source of truth still agrees with its mirrors | `auth-status-contract.test.ts`, `config-schema.test.ts` |
| **Route / handler (in-process)** | A Hono route, exercised via `server.request(...)` / `app.fetch(...)` — no network, no listening port | `*-route.test.ts`, `*-handler.test.ts`, `debug-route.test.ts` |
| **Behavioral / lifecycle** | Stateful subsystems (auth controller, recovery, rate limit) across event sequences | `auth-controller-lifecycle.test.ts`, `auth-recovery.test.ts`, `copilot-rate-limit.test.ts` |
| **Mutation (manual, targeted)** | Whether tests *would fail* if the logic were wrong — see §6 | run on demand via `bun run mutate` |

**Not present today** (gaps, see §8):
- No end-to-end test against a real (or recorded) Copilot backend.
- No formal coverage-percentage tracking (see §6 for why, and the caveat).
- No load/performance/soak testing.

---

## 3. Tooling

| Concern | Tool | Notes |
|---|---|---|
| Test runner | **`bun test`** | Native Bun runner. Fast; no Jest/Vitest layer. |
| Type checking | **`tsc`** (`bun run typecheck`) | `strict` TypeScript. Treated as a first-class gate, not advisory. |
| Lint (fast) | **oxlint** (`bun run lint:fast`) | Rust-based, runs first as a cheap filter. |
| Lint (authoritative) | **ESLint** (`bun run lint:all` = `eslint --cache .`) | Full-tree. This is what CI runs and is the source of truth. Both `lint` and `lint:all` use `--cache`; the difference is **scope** — the pre-commit `lint` only sees *staged* files, and CI runs on a fresh checkout with no cache, so a violation outside your staged set surfaces only under `lint:all`/CI. See §5. |
| Mutation testing | **StrykerJS** (`bun run mutate`) | Manual, narrow-scope. `testRunner: "command"`. See §6. |
| Dead-code / unused deps | **knip** (`bun run knip`) | Part of `check:deep`. |
| Copy-paste detection | **jscpd** (`bun run dupes`, gated by `dupes:check`) | Part of `check:deep`. Tuning in `.jscpd.json`, ratchet in `scripts/check-dupes.ts`. See §9. |
| Secret scanning | **trufflehog** + `scripts/secret-scan.sh` | Runs pre-commit (lint-staged) and in CI. |

**Runtime pin:** Bun is pinned via `.bun-version`, which every CI workflow
reads at runtime — no workflow holds a copy to drift from (see
`docs/bun-version-policy.md`). Rationale: the test runner *is* the runtime, so a
Bun version delta can change test outcomes.

---

## 4. Test isolation & safety

Three global safeguards are registered via `bunfig.toml`'s `[test] preload`
(`tests/test-setup.ts`), applied before any module loads:

1. **Credential isolation.** `COPILOT_API_HOME` is redirected to a throwaway
   temp directory so `paths.ts` resolves `APP_DIR`, `ACCOUNTS_PATH`,
   `GITHUB_TOKEN_PATH`, and logs into temp. Without this, any test that reaches
   the real registry/token helpers would read and **write the developer's real
   sign-in state** — which has corrupted real credentials during test runs in
   the past. A test may set its own `COPILOT_API_HOME` and it wins.
2. **Consola level reset.** `consola.level` is reset to Info (3) before every
   test, because some tests raise verbosity and don't restore it, leaking
   flooding debug output into later tests.
3. **`process.exit` is made to throw.** Nothing may kill the runner. Product
   code calls it in seven modules — the `/_internal/shutdown` handler, port
   acquisition, config load, shutdown — all reachable in-process, and a real
   call truncates the run *at exit 0*: no summary, no failure, and a green
   verdict for a suite that never ran. Throwing keeps the run alive and turns
   the attempt into an ordinary test failure. Code that needs a testable exit
   injects it, as `createInternalRoutes({ exit })` does. §6 records the mutant
   this was found by.

The preload also registers the **outermost `afterEach(() => mock.restore())`**
(`tests/test-setup.ts`): a defense-in-depth net that restores every `spyOn` spy
after each test. It runs last — after any file's own `afterEach` — so a spy a
file forgot to restore can't leak. A leaked `spyOn` permanently patches the real
method for every later file in the Bun worker (the spy analog of the
`mock.module` leak; see §5.2). It does **not** undo `mock.module` — that is
restored per-file (§5.1).

**Shared fixtures/helpers** live in `tests/helpers/` (`fake-executor.ts`,
`auth-flow-utils.ts`, `auth-status.ts`, `rfc-network-fixtures.ts`). Preference
order for test doubles: **injectable function options > `mock.module`** — for a
hazard reason spelled out in §5.

The preload also carries one **opt-in diagnostic**, `MAXIMAL_TEST_TRACE`, which
records module evaluation order and every `mock.module` install. It is off by
default and costs a single `process.env` read when off. See §5.7.

---

## 5. Known hazards (hard-won, must-read for contributors)

These are documented in `docs/architecture.md` → *Testing gotchas* and expanded
here because they are the failure modes most likely to bite a reviewer or a new
contributor.

### 5.1 `mock.module` persists forward across files in a run — partly lint-enforced
Bun does **not** reset module mocks between test files, and CI orders files
differently than local. An unrestored mock leaks its stub into a *sibling* file
that then reads stale state — passing locally but failing in CI (or vice versa).
This bit the project **four times** (culminating in a long #229 debugging loop),
then a fifth (#27).

**How the leak actually propagates (measured on Bun 1.3.11, the pin).**
`bun test` **interleaves** evaluation and execution: it evaluates one test file's
module body, runs that file's tests and hooks, then evaluates the next. Four
independent measurements agree:

- A six-file probe prints the same shape plain and under `--randomize`:
  `EVAL e -> TEST e -> AFTERALL e -> EVAL f -> TEST f -> AFTERALL f -> ...`.
- An eight-file probe with no instrumentation of any kind prints the same.
- On the real suite the opt-in tracer (§5.7) reports
  `first-test-starts (1 modules evaluated so far)` — the first file's tests run
  before the second file is even evaluated — and the evaluation order of all 128
  test files comes out identical to their execution order.
- The tracer does not perturb this: with it on and off, the JUnit reporter's 517
  suites are emitted in byte-identical order.

This **corrects** an earlier reading recorded here as "Bun evaluates every test
file's module body during startup, before the first test runs, so an
`afterAll` restore is structurally incapable of protecting a sibling". That is
not what 1.3.11 does and it does not reproduce. The leak is **forward-only** — a
file evaluated earlier has already finished and cannot be affected. Distance is
what makes it expensive: in the §5.7 demonstration the writer evaluated 5th and
the victim 105th, 99 files later.

**But "so the restore works" is also wrong. What breaks a restore is its
*value*.** `mock.module` mutates the live module record **in place**, so a
namespace object captured before the install is retroactively updated to hold the
stub. Restoring from it re-installs what the restore meant to undo:

```ts
const real = await import("./m")
await mock.module("./m", () => ({ ...real, TABLE: [] }))  // install: fine
await mock.module("./m", () => real)                      // restore: NO-OP
await mock.module("./m", () => ({ ...real }))             // restore: NO-OP
                                                          // `real` is already
                                                          // stubbed by now

const snapshot = { ...(await import("./m")) }   // copy taken BEFORE the install
await mock.module("./m", () => snapshot)        // restore: WORKS
```

Measured both directions on the same seed with a two-file writer/reader probe:
namespace restore -> the reader's module body sees `TABLE.length === 0`; snapshot
restore -> it sees the real table. Directly instrumented, `real.TABLE.length` is
`2` before the install and `0` after. In-repo:
`tests/poll-access-token.test.ts` stubbed `sleep` to a no-op and restored from
the namespace, so a later sibling got a `sleep` that returned instantly on **5 of
12** seeds; with the snapshot form, **0 of 12**.

It is *not* that `mock.module` refuses a Module Namespace exotic object —
installing one works fine (probed with an unrelated module's pristine namespace).
It is that the namespace is **live**. `tests/uninstall.test.ts` had this right all
along; nine other files did not, and the capture-time bug in
`tests/start-run-server.test.ts` was the whole of #27.

The rule that follows: **capture a spread copy before the first install and
restore from that** — `const real = { ...(await import("…")) }`. The
`maximal/no-live-namespace-mock-factory` lint rule (`eslint.config.js`) enforces
it; a plain selector cannot, because the broken and correct restores are
syntactically identical (`() => real`) and differ only in what `real` is bound
to, so the rule resolves the binding.

**A correct restore is still not protection.** Bun documents no ordering
guarantee for the interleave, this reading has now been got wrong twice in
opposite directions, and the phase structure is the kind of thing a minor release
changes silently. Treat a restore as version-dependent cleanup that happens to
hold today, never as the reason a shared-module mock is safe. The durable fix is
unchanged: **do not mock a shared module** — use a DI seam.

**Reproduce it deterministically.** `bun test --randomize --seed N` shuffles both
file order and within-file test order, and prints the seed it used in the run
summary (`--seed=…`) whether the run passes or fails — so a failure is always
replayable. This is the tool for this whole class, including the non-mock
variants in §5.6.

**Mitigations, in order of strength:**
- **Durable fix: don't mock a shared module across files.** Prefer the **real**
  module — the preload redirects `COPILOT_API_HOME` to a temp dir and
  `getClaudeCodeSettingsPath()` honors `CLAUDE_CONFIG_DIR`, so config/settings
  round-trips are already isolated — or **injectable function options**
  (`__setServeForTests`, `__setBootSecretsForTests`). Only stub a module with no
  env/injection seam, keep the wrapper behaviorally identical (`...actual` /
  forward `...rest`), and prove with `--randomize` over a spread of seeds that it
  can't break a later file.
- **Never stub a *data* export.** All 24 `mock.module` sites were audited in #27:
  every one replaces *function* exports and spreads `...real` — except the one
  that stubbed a data table (`SECRET_DEFS: []`), which is the one that caused the
  outage. The asymmetry is the whole lesson. A leaked function stub gets
  **called** by the sibling and usually throws or returns an obviously wrong
  shape — loud, and near the cause. A leaked empty array is **read** silently and
  yields a plausible wrong answer: `anthropic-key-precedence` saw an empty
  secrets table and concluded, reasonably and wrongly, that no
  `secrets/anthropic` entry existed. Expose a DI seam for the value instead.
- **If you must mock, capture the real module as a spread copy first.**
  `const real = { ...(await import("…")) }`, then install `() => ({ ...real, fn })`
  and restore `() => real`. Never hold the namespace itself: `mock.module`
  mutates it in place, so a restore that reads it hands back the stub. Rule 4 of
  the lint guard enforces this.
- **Lint rule (enforced, and honest about its limits).** `mockModuleLeakGuard`
  (`eslint.config.js`, scoped to `tests/**`) enforces four things:
  1. the fire-and-forget forms — `void mock.module(...)` and a bare
     `mock.module(...)` expression statement. **Its justification is now
     narrower than it was:** an unawaited install is not guaranteed to have
     landed before the same file's next `await import(...)`, so the file can
     exercise the real module while believing it stubbed one. It says nothing
     about leaks, and the rule's message no longer claims otherwise.
  2. stubbing a non-function export with a literal value (array / string /
     number / boolean / template) — the silent-corruption shape above. Object
     literals are deliberately **not** matched: `default: { ...real.default, fn }`
     is a function override nested one level down and four legitimate sites use
     it, and a rule that cries wolf gets suppressed and then enforces nothing.
  3. a deny-list of modules a sibling is known to read passively — today `srvx`
     and `~/lib/auth/secrets`. Membership is earned by an incident.
  4. `maximal/no-live-namespace-mock-factory` — a `mock.module` factory that
     reads a live namespace binding (`import * as ns`, `const ns = await
     import(…)`). This is the broken-restore shape, and it is the one part of
     the hazard that *is* statically decidable. It needs scope analysis rather
     than a selector: `() => real` is both the broken form and the correct one,
     depending only on whether `real` is a namespace or a copy, and the
     `() => ({ ...ns })` variant is broken for the same reason a selector on
     bare identifiers would miss.

  **What it cannot enforce, by construction:** whether any *given* `mock.module`
  is safe. That depends on whether another file evaluated later in the run
  imports the mocked module and when it reads the binding — a property of the
  whole run's module graph, not of the call site. No rule decides it. Treat a
  green lint as "the known footguns are absent", never as "this mock was
  checked".

This discipline is the decision of
[ADR-0011](../decisions/0011-mock-module-leakage-discipline.md). Two parts of
that ADR remain authoritative: **prefer DI / injectable options over
`mock.module`** for any shared module, and the **wrapper rule** (forward
`...rest`, preserve return shape) when a stub is unavoidable. What actually
*shipped* for enforcement is narrower than the ADR's original proposal — there
is no `tests/helpers/` allowlist. The ADR's "awaited install + awaited `afterAll`
restore" is sound on Bun 1.3.11 **provided the restore hands back a pre-install
snapshot** — but it is sound by scheduling, not by contract, so it stays a
hygiene rule rather than a licence to mock a shared module.

### 5.2 Spies leak too
`spyOn` has the same cross-file hazard as `mock.module`: a spy left unrestored
permanently patches the real method for every later file in the Bun worker — a
CI-order-dependent flake whose failure surfaces in a *different* file than the
one that leaked it. **Mitigations:**
- **Global net (defense-in-depth).** The preload's outermost
  `afterEach(() => mock.restore())` (§4) restores every spy after each test, so a
  forgotten restore can't leak forward. Note `mock.restore()` undoes `spyOn`
  spies **only** — it does *not* undo `mock.module` (§5.1).
- **Still restore your own spies per-file.** The net is a backstop, not a
  license: keep `spy.mockRestore()` in the test's own `afterEach`/`afterAll`
  (e.g. `tests/uninstall.test.ts`) so intent is local and the leak window is
  zero even within a file.

### 5.3 Green tests can still test nothing
A passing assertion does not prove the branch it claims to cover was exercised.
Mutation testing has caught classification tests whose fixture hit a *different*
code path that happened to return the same value. **Mitigation:** for
security-critical or branchy logic, run Stryker and confirm the targeted
mutants actually die. See §6.

### 5.4 Local staged lint ≠ full-tree CI lint
Both `lint` and `lint:all` pass `--cache`, so this is **not** a cached-vs-uncached
difference — it is **scope**. The pre-commit `lint` (via lint-staged) only lints
*staged* files; `bun run lint:all` (`eslint --cache .`) lints the whole tree,
which is what CI runs — on a fresh checkout with no cache. So a violation in a
file you didn't stage passes locally and fails CI. **Always run `lint:all`
before pushing.** This has produced red CI on otherwise-good PRs.

### 5.5 Fresh worktrees need setup
A `git worktree` created for isolated work has no `node_modules` — `git worktree
add` does not run an install. Run `bun install` (matches the lockfile) in the new
tree before `bun run typecheck` or `bun test`, or imports fail with an opaque
missing-module error.

### 5.6 Module-level runtime state leaks the same way mocks do
`mock.module` is the famous case, but it is a *special case* of a wider one:
anything held at module scope is shared by every test file in the Bun worker.
`src/` is full of legitimate process-global singletons — an active-clients Map, a
single-flight guard, a prime cooldown, a models cache, and the whole `state`
object — and each is one shared mutable object for the whole run. Two
symmetrical bugs follow, and this project has shipped both (three times, in the
one PR that added this section):

- **A writer that resets only `beforeEach`** leaves whatever the *last-executed*
  test recorded visible to every later file. Under the declared order the file
  usually happens to end on a test that wrote nothing, so it looks clean;
  `--randomize` removes the coincidence.
- **A reader that resets only `afterEach`** inherits the previous *file's* state
  for its own first-executed test, because `afterEach` has not run yet. Same
  coincidence, mirrored.

**Rules:**
1. If a test touches process-global state, reset it in **both** `beforeEach` and
   `afterEach`. One-sided cleanup is correct only by accident of ordering.
2. Better, remove the dependency: a test that asserts "the roster is empty" is
   asserting about every other file in the run. Take the state through an
   injectable option (`ControlRoutesOptions.listClients`) so the assertion is
   about the code under test, and let a dedicated unit test own the real
   singleton.
3. Note the failure often surfaces nowhere near the leak. A leftover
   `state.rateLimitSeconds` makes `checkRateLimit` 429 an unrelated
   `/responses` test whose body assertion then fails on `undefined` — the stack
   names the victim, never the writer. When a `--randomize` failure makes no
   local sense, look for a global the file reads but never sets.
4. `bun test --randomize --seed N` is the detector. Run a spread of seeds — one
   passing seed proves nothing, and the seed is printed in the run summary so any
   failure replays exactly.

### 5.7 `MAXIMAL_TEST_TRACE` — making the causal phase visible

Both hazards above share a diagnostic problem: the log records the wrong thing.
Bun's reporter prints one line per **test**, and the failure's stack names the
**victim**. The causal event — a `mock.module` install, or a module-scope write
to a singleton — happens while a module body is executing, and no line of a
normal run covers it. Reconstructing the `(writer, module)` pair by hand is what
makes one of these failures a multi-hour job.

`MAXIMAL_TEST_TRACE=1 bun test` records that phase. The preload
(`tests/test-setup.ts`) loads `tests/helpers/module-trace.ts`, which registers a
`Bun.plugin` loader hook and patches `mock.module`. Every line is prefixed
`[test-trace]` and goes to stdout, the stream Bun's reporter uses, so in CI the
lines interleave with the reporter's own `##[group]tests/<file>.test.ts:`
headers — that interleaving is the correlation mechanism.

```
[test-trace] enabled mode=tests bun=1.3.11 pid=50909
[test-trace] 0001 eval  tests/claude-code-reconcile.test.ts
[test-trace] 0002 first-test-starts (1 modules evaluated so far)
[test-trace] 0003 eval  tests/helpers/rfc-network-fixtures.ts
[test-trace] 0005 eval  tests/api-config.test.ts
[test-trace] 0006 mock.module ~/lib/auth/secrets -> src/lib/auth/secrets.ts \
                  <- tests/api-config.test.ts:14:12 (module-scope, after 4 evals)
```

`MAXIMAL_TEST_TRACE=all` widens the eval stream from the test tree to `src/**`
as well, which is what you want for a plain module-level singleton (§5.6) rather
than a mock.

**What it gives you.**

- **Evaluation order**, including non-test modules (helpers; with `=all`, every
  `src/` module). No reporter shows this, and locally the compact reporter shows
  no file order at all.
- **The `(writer, module)` pair for every `mock.module`** — call site from the
  stack, specifier as written, and the resolved target, so `~/lib/auth/secrets`
  and `../src/lib/auth/secrets` collapse to one path you can group by.
- **`module-scope` vs `in-test`** on each install. `module-scope` is the leaking
  shape. The repo's convention pairs a module-scope install with an `in-test`
  restore of the same target, so **an unpaired `module-scope` install is the
  leak** — one `grep` over the log finds it.
- **`first-test-starts`**, which re-verifies the §5.1 scheduling model on
  whatever Bun the run used.

**What it cannot give you, and will not pretend to.**

- **Which sibling read the leaked binding.** That needs per-binding read
  instrumentation, not module entry. The trace narrows the suspects to "modules
  evaluated after the install"; it does not name the victim.
- **Modules Bun does not route through the plugin loader**: `node:*` / `bun:*`
  builtins, `node_modules/**` (excluded on purpose — `onLoad` must return an
  object, so a matched file cannot be passed through untouched, and re-emitting
  a CJS dependency under an explicit loader breaks it), and the preload chain,
  already evaluated when the plugin registers.
- **An end-of-run summary.** `bun test` fires neither `process.on("exit")` nor
  `"beforeExit"` and exposes no run-level teardown hook, so there is nowhere to
  print a recap from. Extract one from the log:
  `grep 'test-trace.*mock.module' ci.log`.
- **Which test file is executing during the run phase.** Bun 1.3.11 has no
  `expect.getState().testPath` and no per-file hook. CI's group headers supply
  it; locally, use the call sites.
- **The ordering seed.** `bun test` only assigns one under `--randomize`, and
  prints it itself. The trace records the resulting *order*, which is what a
  seed would have been used to reconstruct.

**Cost.** Off — the default — the preload does one `process.env` read: the
tracer module is never imported, no loader hook is installed, and no byte of
output changes. On, the full suite runs within noise of an untraced run
(measured 15.8s vs 15.8s over 128 files; `=all` costs ~2s more) and adds ~210
lines to a ~720-line local log. The loader hook re-reads each matched file and
prepends a marker **without a trailing newline**, so every line number is
preserved and failure stack traces stay exact; only one line's columns shift.
(On the CLI entrypoints the marker goes after the shebang, which must stay at
offset 0.)

**Proposal (not yet shipped): CI should set it unconditionally.** The trace is
only wanted when something fails, but that cannot be known in advance, and a
plain `bun test` run assigns no seed — so a CI-only failure cannot be replayed
locally, and re-running with more logging produces a different order. That is
the asymmetry: ~200 extra lines on every green run, against a red run whose
causal record does not exist and cannot be recovered. Both test jobs should set
it — `ci.yml`:

```yaml
      - name: Run tests
        # Records module evaluation order and every mock.module install with its
        # call site (docs/dev/testing-strategy.md §5.7). Always on, not
        # on-failure: `bun test` assigns no seed, so a failing order cannot be
        # reproduced after the fact, and the run that failed is the only one that
        # could have recorded it.
        env:
          MAXIMAL_TEST_TRACE: "1"
        run: bun test
```

and `randomized-test-order.yml`, whose per-seed invocation becomes
`MAXIMAL_TEST_TRACE=1 bun test --randomize --seed "$SEED"`. That job is the one
most likely to surface this class, it is non-blocking, and its output is already
summarized into an issue rather than read line by line — so the log cost lands
where it matters least and the payoff is highest.

### 5.8 A test that names a port is asserting about the whole machine

The shared-state hazards above are about state inside the Bun worker. Ports are
the same failure with a wider blast radius: the shared resource is the *runner*,
so a sibling suite, a leftover process, or a second checkout can fail a test
that is itself correct. This project has now paid for it three times — the
fixed-port flakes in #34, the `4143 + random(100)` / `4243 + random(100)`
windows that overlapped at their seams, and `41000 + random(1000)` in
`tests/start-run-server.test.ts`, which went red on a CI runner during #58.
Every one was green in isolation. **Widening the range does not make a guess
safe**; it only makes the collision rarer and therefore harder to reproduce.

There are four ways to get a port here. They are **not** interchangeable, and
they rank by *who owns the socket when the assertion runs*:

| | Mechanism | Ownership at assertion time |
|---|---|---|
| 1 | `Bun.serve({ port: 0 })`, then read `server.port` | Never leaves. No window. |
| 2 | `startEngine` (`tests/helpers/spawn-engine.ts`) — child binds `--port 0`, reports on the ready-line | Never leaves. No window. |
| 3 | `holdPort()` (`tests/helpers/free-port.ts`) — the test binds and keeps the socket | Held by the test. No window. |
| 4 | `pickFreePort()` (same file) — bind, read the number back, release | **Passes to the code under test. Window exists.** |

Forms 1 and 2 are two observation channels for two runtimes, not duplication;
merging them would buy nothing and cost the thing that makes each work. Only 3
and 4 are the test's own bookkeeping, and only those are shared.

**Form 4 is the weakest and is a last resort.** Use it only when the API under
test takes a port *number* and binds it later — `runServer({ port })` is the
one case in this repo. Anything that can hold its own socket should.

**Enforced.** `tests/spawned-engine-ports.test.ts` is the guard, and it now
covers both doors. The original three checks cover spawned engines (`--port`
must be `0`; every spawn must route through `startEngine`). A fourth covers
in-process binds: every real `.listen(...)` / `Bun.serve({ port })` in `tests/**`
must either request `0` outright or live in a file that sources ports from
`helpers/free-port.ts`. That inversion is deliberate — the defect that shipped
was `const port = 45_872` with `listen(port, …)` at the call site, so matching
numeric *arguments* would have missed it, and tracing the value needs data flow
a text scan does not have. The guard carries its own fixture asserting it
recognises that exact shape, so it cannot rot into a no-op.

**It does not forbid port literals generally**, and must not: the `resolvePort`
policy tests pass `4141` to fake probes and bind nothing, which is correct. Only
sites that reach the network stack are matched.

---

## 6. Mutation testing (the differentiator)

### How it's configured
StrykerJS, invoked manually via `bun run mutate`. The config
(`stryker.conf.json`) narrows the **source** scope, not the test command:

- `mutate` names the module(s) under test. Override it per run rather than
  editing the file: `bunx stryker run --mutate 'src/routes/messages/utils.ts'`.
- `testRunner: "command"` runs **`bun run test:mutation`** — the whole suite
  minus six files. It is **not** narrowed to the module's own test file, and
  narrowing it is the one mistake this config used to make. See below. The
  command is a script (`scripts/dev/run-mutation-tests.ts`) because a command
  runner scores a mutant from the child's exit code alone; the script withholds
  that code until bun has proven the run finished (sweep log).
- `--concurrency` defaults to 4; 10 is comfortable on a 24-core machine.

Cost, measured on the pin (Bun 1.3.11, `--concurrency 10`): **~2.0–2.5 s per
mutant**, dominated by the ~15 s suite run divided across workers. 104 mutants
took 4m24s; 629 took 21m24s. Budget ~1.2 mutants/second/10-workers and scope
accordingly — a 400-line module is roughly 450 mutants, so ~20 minutes.

**Why the runner is the whole suite.** A command runner narrowed to one test
file reports every mutant that *only some other file* would have killed as a
survivor. Those false survivors are indistinguishable from real ones until you
hand-apply the mutation, and triaging them costs far more than the runtime
saved. The shipped config used to run a single file; re-running the same target
against the full suite produced an identical survivor set, which is the good
case — but nothing about the narrow command guaranteed that.

**Why six files are excluded.** `test:mutation` skips
`start-run-server`, `start-unauthenticated`, `start-multi-account`,
`spawned-engine-ports`, `cli-branding`, and `main-cli-global-options`. Those
bind real ports or spawn real processes (§5.8), and Stryker runs N suites
concurrently. Measured: with the full suite at concurrency 4,
`tests/start-run-server.test.ts` failed on **2 of 4** runs; with the six
excluded, **0 of 10** at concurrency 10. A flaky test under a mutation run
produces a **false kill**, which is the dangerous direction — it hides a
survivor rather than inventing one. None of the six exercises pure request-path
logic, so excluding them costs no real kills.

### Why we use it
Line/branch coverage answers "did this line execute?" Mutation testing answers
the question that actually matters for a translation proxy: **"if this line
were wrong, would a test fail?"** A concrete example from this codebase: an
extended-thinking display gate (`if (!hasThinking)`) shipped inverted. The
function had tests and green coverage — but no test fed an input that flipped
the gate, so the bug was invisible. Post-hoc Stryker flagged the exact mutant
(`if (!hasThinking) → if (true)` *survived*). That surviving mutant is the
bug's fingerprint; running mutation testing on that module beforehand would
have caught it.

### The failure shape it finds: a fixture that proves the wrong thing

Every vacuous test this repo has found by mutation had the same structure — a
fixture chosen so that the assertion passes **for a reason other than the one
the test name claims**. Three recorded instances, all found in one sweep:

- **`tests/find-endpoint-model.test.ts`** — four test titles named specific
  mutants ("kills the LogicalOperator mutant", "kills `m.id || false`") and
  killed none of the seven on `findInModels`' byName lookup. The fixtures set
  the other fields to `"unrecognised"` on the theory that this stopped the
  semantic fallback from also finding the model. But
  `` `claude-${family}-${version}` `` always parses back to the same
  `{family, version}` tuple, so anything byName matches the fallback matches
  too. Disabling byName entirely changed no observable output.
- **`tests/security/origin-guard.test.ts` › "a foreign origin is rejected"** —
  asserted `isAllowedOrigin("https://evil.example", 4141) === false`. That
  origin has an *empty* `URL.port`, so it was rejected by the port comparison
  and never reached the hostname allowlist. Deleting the allowlist check left
  the test green; so did flipping the unparseable-origin `catch` from
  `return false` to `return true`, because no fixture was unparseable.
- **`tests/anthropic-request.test.ts` › "should translate comprehensive
  Anthropic payload…"** — asserted only that the output satisfied a local Zod
  schema whose `tools` is `z.array(z.any())` and whose `tool_choice` is
  `string | object`. It stayed green with every tool mapped to `undefined`,
  `tool_choice` reduced to `""`, and the system prompt dropped.

The general rule: **a mutant that survives a test naming it is a statement
about the fixture, not about the code.** Check what else in the function could
produce the same output before concluding the assertion is doing work.

### The disposition rule for surviving mutants

> A surviving mutant is proof that **no test can distinguish the real code from
> a changed version of it.** There are exactly three honest dispositions, each
> with a required action. "Documented-equivalent" as a catch-all is **not**
> acceptable.

1. **Killable** — the behavior is observable, we just don't assert it. →
   **Write the test that kills it.** Attach it; show Survived→Killed.
2. **Dead / unreachable** — no reachable input makes this code observable. →
   **Delete the code, or encode the impossibility in the type system** so the
   branch ceases to exist. A path that can't be observed is dead code or
   redundant defense, not a test exemption.
3. **Deliberately-retained equivalent** — a provable semantic equivalence we
   consciously keep (e.g. a defensive `?.` at a trust boundary we want despite
   the contract forbidding `undefined`). → Requires a **written proof over the
   reachable input domain** plus a rationale for keeping the code. "Looks
   equivalent" / "probably fine" is rejected.

Worked bucket-3 examples from `src/lib/auth/request-auth.ts`, kept as the
reference standard for what "provable" means here:

- `isLoopbackAddress`: `if (!address) return false` → `if (false)`. Equivalent
  because the only fallthrough is `LOOPBACK_IPS.has(address)`, and
  `Set.prototype.has` returns `false` for `null`, `undefined`, and `""`. The
  guard is a readability affordance, not a behavior.
- `apiKeyAllowed`: `if (requestKey.length === 0) return false` → `if (false)`.
  Equivalent because the fallthrough is `allowList.includes("")`, and both
  producers of that list (`normalizeApiKeys` and `getConfiguredApiKeys`) filter
  on `key.length > 0`, so `""` is not a reachable member.
- `extractRequestApiKey`: dropping the trailing `.trim()` from
  `rest.join(" ").trim()`. Equivalent because `rest` comes from
  `split(/\s+/)` on an already-trimmed string, which yields no empty or
  whitespace-only elements, so the join can produce no leading/trailing space.

The anti-pattern we are eliminating: accepting a live mutant because "we can't
write a test to observe it." If a test can't observe it, that is a finding
*about the code* (bucket 2), not a license to move on.

**Status of this policy:** codified (issue #216). The three scope items are
complete — this rule is written into the testing docs (and linked from
`docs/architecture.md` → *Testing gotchas*), the previously-dismissed
"equivalent" survivors were re-adjudicated (the request-preprocess audit found
several were in fact **killable**, including one reachable via a
`selectedModel?: Model` parameter the public contract genuinely allows to be
`undefined`), and the hot-path sweep list is named below.

**Deliberate non-goal:** we do **not** gate CI on a mutation-score threshold,
and the numbers above are the argument rather than a preference. A useful sweep
of one 400-line module is ~20 minutes on a 24-core laptop; CI runners are
smaller. It is also *ratchet-hostile* in a way the `deps:check` and
`dupes:check` ratchets are not: a survivor count moves when a **test** changes,
not only when source does, so an unrelated refactor of a fixture re-scores
modules it did not touch. And the score is not the deliverable — of the 222
survivors in the sweep recorded below, three were vacuous tests, and finding
them required reading each survivor, not comparing a percentage. A number that
takes 20 minutes to produce and still needs the same manual read afterwards
buys nothing a gate can enforce. The bar remains the *per-survivor disposition
rule above*, applied during review of test/logic PRs.

### Which modules to sweep — a criterion, not a hand-list
The target set is *computable*, not a matter of taste. "Branchy, pure-logic
transforms on the request path" decomposes into three mechanical signals: a
module is reachable from `src/routes/**` in the import graph, imports no I/O
sink, and carries cyclomatic complexity above a threshold. Rank that set by a
*measured* signal — surviving-mutant density from a scheduled `bun run mutate`,
or branch-density × line-coverage — and the sweep list falls out
deterministically. Human judgment sets the thresholds and the disposition rule
above; it does **not** re-pick a file list on every rename. The canonical mutate
target of record is `stryker.conf.json`. Today's standing high-value areas are
the request-path transforms: request preprocessing, the protocol translation
layers, model dispatch/selection, the completion handler's model-resolution
gate, and domain-policy matching.

### Sweep log

Recording what a sweep found is what stops the next one re-deriving it. Keep
this terse: target, date, and the survivors that turned out to matter.

| Target | Mutants | Survivors before → after | Outcome |
|---|---|---|---|
| `src/lib/models/models.ts` | 104 | 7 → 0 | All 7 on the `byName` lookup, all "covered" by four test titles that named them. Fixed in `tests/find-endpoint-model.test.ts`. |
| `src/lib/auth/origin-guard.ts` | 49 | 5 → 1 | 4 real gaps on `isAllowedOrigin` (foreign host on the bound port, unparseable Origin, the `[::1]` allowlist entry). Fixed in `tests/security/origin-guard.test.ts`. The 1 left is the 403 body's prose `message`, deliberately unpinned — the machine-readable `error.type` is the contract clients branch on, and pinning prose only invites churn. |
| `src/lib/auth/request-auth.ts` | 219 | 42 | No vacuous tests. Three provable equivalents (above). The rest are genuinely uncovered surfaces, listed below. |
| `src/routes/messages/non-stream-translation.ts` | 329 | 172 → 78 | 1 vacuous test (the Zod-schema-only assertion). The bulk was whole unasserted features: `normalizeToolSchema`, the `thinking_budget` clamp, the `tool_choice` map, `handleSystemPrompt`'s array arm, cache-token accounting, the multi-choice stop-reason merge, non-streaming thinking blocks. All now pinned. The remaining 78 are the array-content paths (`mapContent`'s `image`/`document` arms, the tool-result split, the claude-model thinking-block filter) plus `OptionalChaining` mutants that are equivalent under a well-formed upstream response. |
| `src/routes/messages/utils.ts` | 32 | 3 | Only the `consola.warn` inside the JSON-parse `catch`. Logging, deliberately unasserted. |
| `src/lib/auth/origin-guard.ts` + `request-auth.ts` | 268 | 41 → 32 | 2026-08-05, 9m50s at `--concurrency 10`. Security-surface-only re-sweep of the two auth modules together. origin-guard held at 1 (the 403 prose `message`, still deliberate). request-auth 40 → 31: the 9 killed are the whole `MAXIMAL_SHELL_KEY` arm — `isShellKey` plus its `decideAuth` call site — which was the only cluster where an attacker-influenced value reaches the line *and* the line decides allow/deny. `requestApiKey === state.shellApiKey` → `!==`, and that same conjunct → `true`, each turn **any** presented key into a valid credential that outranks the enforce flag. Pinned in `tests/security/shell-key-bypass.test.ts`. The 31 left are deliberate: 18 attribution-only, 12 provable equivalents, 1 false survivor (below). |

**A mutant that exits the runner 0 is scored as a survivor.** The command
runner reads only the exit code, so a mutant that *terminates* the suite
successfully is indistinguishable from one no test covers.
`isLoopbackAddress`'s `if (!address) return false` → `return true` is reported
alive and is not: two tests in `tests/request-auth.test.ts` fail on it when run
directly. Under that mutant an in-process `app.request` (no socket, so
`defaultGetRequestIp` yields `null`) passes `/_internal/shutdown`'s loopback
gate at `src/routes/internal/route.ts:42`, whose handler defaults to
`process.exit(code)` — the suite stops after 9 files with **exit 0** and no
summary block, and `test:mutation` looks green. Before triaging any survivor on
a loopback-, shutdown-, or `process.exit`-adjacent line, apply it by hand and
check for a summary block, not just the exit code.

**Known-uncovered, not yet pinned** (recorded so the next sweep does not
re-derive them): `findApiKeyEntry` attribution, whose result reaches
`recordClient` and is asserted nowhere — reachable with an attacker-chosen key,
but it runs only *after* the allow/deny decision and nothing branches on its
output, so the 12 mutants on it mis-label a client rather than admit one; and
`mapContent`'s `image` and `document` arms, including the PDF-placeholder text.

Two entries previously listed here are resolved. The `MAXIMAL_SHELL_KEY` bypass
is pinned by `tests/security/shell-key-bypass.test.ts`. The default
`isEnforcing` resolver (`getConfig().auth?.enforce === true`) was **already**
covered and the note was wrong: `tests/security/cli-client-regression.test.ts`
drives the real `publicApp`, which passes no `isEnforcing` option, and sets the
flag through `writeConfig` — no config DI seam needed, and no mutant on that
line survives.


**A mis-scored mutant the `request-auth.ts` sweep found in the runner itself
(fixed).** `isLoopbackAddress`'s `if (!address) return false` → `return true`
was scored **survived**. It is not: under it an in-process `app.request` has a
null peer IP, so it passes the loopback gate on `/_internal/shutdown`, whose
handler exits the process. The suite died after 9 of 132 files **with exit code
0 and no summary**, and a command runner — which scores a mutant from the exit
code alone — read 0 as a pass. A mutant that kills the test process was
recorded as one the tests fail to catch, on the security surface where it
matters most.

Two mechanisms now enforce the triage rule *"require evidence the suite
completed; do not trust the exit code on its own"*:

- **`scripts/dev/run-mutation-tests.ts`** is what `bun run test:mutation` runs.
  It passes bun's exit code through **only** if bun wrote its
  `Ran <n> tests across <n> files.` summary to stderr — a line a dead process
  cannot have written. So a failing suite is still a kill and a clean suite is
  still a survivor; the script adds no verdict of its own and can invent
  neither. A run without the summary is inconclusive, not a pass: it exits 97
  and appends the mutant id to `reports/mutation/incomplete-runs.log`. Stryker's
  command runner reaches `MutantRunStatus.Error` only from a spawn failure, so
  a child cannot report "inconclusive" and that exit is scored as a kill — the
  ledger is how a sweep declares which of its kills were not earned.
- **`tests/test-setup.ts` makes `process.exit` throw** for the whole suite. That
  removes the mechanism, so the branch above is an alarm rather than a routine
  path: the same mutant now fails `isLoopbackAddress > rejects everything else`
  and `createAuthMiddleware loopback exemption > missing peer IP is treated as
  non-loopback`, and is killed by assertions instead of by a crash. It also
  closes the same hole in the plain `bun test` gate, where a truncated run at
  exit 0 likewise looked like a pass.

Unmutated, `/_internal/shutdown` is **not** reachable from an in-process test:
`defaultGetRequestIp` reads `Request.ip`, which `app.request` never sets, so the
handler 404s (and auth 401s ahead of it) — and the clean suite now passes with
the `process.exit` guard armed, which is the direct evidence.


---

## 7. What tests can and cannot prove here

Because the proxy sits in front of a partly-undocumented upstream, it is
important to state the boundary of our guarantees honestly:

- **Tests pin our transformation.** We can and do assert that, given input X,
  the payload we send upstream (or return downstream) is exactly Y.
- **Tests cannot pin live upstream behavior.** Claims like "`thinking.display:
  "summarized"` is what surfaces reasoning text on Copilot-served Claude" or
  "only GPT models support `/responses`" are **empirically established**, not
  contract-guaranteed, and can drift when GitHub changes the backend. Where a
  fix depends on such behavior, the test verifies that we *send the right
  thing*; the end-to-end outcome rests on captured evidence (wire logs) and
  project-recorded knowledge, and is flagged as a residual risk in the relevant
  PR.
- **Implication for reviewers:** the most valuable defensive addition here is
  not more unit tests but a **recorded-fixture / contract-canary** mechanism
  against the real upstream, so drift is detected rather than silently
  degrading. This is a gap (see §8).

---

## 8. Known gaps & candidate improvements (for the review to prioritize)

We would specifically like external judgment on these:

1. **No upstream contract canary.** Undocumented Copilot semantics can drift
   with no signal until a user reports breakage. A periodic recorded/live
   contract check would convert silent drift into a failing check. *(Highest
   strategic value, in our view.)*
2. **Mutation sweeps are manual and unscheduled.** §6 defines the disposition
   rule and a *computable* target criterion, but the pieces that would make it
   automatic — a generator that emits the target set from the import graph, and
   a scheduled `bun run mutate` that ranks by surviving-mutant density — aren't
   built yet, and results aren't archived. Risk: sweeps only run when someone
   remembers.
3. **No coverage measurement at all.** We intentionally avoid a coverage *gate*
   (§6), but we currently have no coverage *visibility* either — we cannot point
   at which modules are under-exercised without running Stryker on each. A
   reporting-only coverage signal (not a gate) may be worth adding.
4. **Cross-file test-size friction.** Large single-domain test files keep
   growing; independent PRs appending to the same file collide on merge. There
   is no `max-lines` ESLint cap in this repo today, so nothing bounds this
   mechanically. Suggests a convention for splitting test files by concern.
5. **Cross-file shared-state hazard (§5.1, §5.6)** — `mockModuleLeakGuard` bans
   the fire-and-forget `mock.module` forms, literal data stubs, a deny-list of
   known-passive modules, and the live-namespace restore factory. **Residual
   gap, and it is structural:** the rule cannot decide whether a *given* mock is
   safe, because that depends on the whole run's module graph rather than the
   call site. A correct `afterAll` restore *does* run before the next file is
   evaluated on Bun 1.3.11 — the leak is forward-only (§5.1) — but that is
   scheduling, not contract, and Bun documents no ordering guarantee, so it is
   cleanup rather than protection. The same applies to plain module-level
   singletons (§5.6), which no lint rule sees at all. So "prefer
   real/injectable deps for shared state" still rests on review. **The one
   mechanical detector we have is `bun test --randomize`**, now run nightly by
   `randomized-test-order.yml` over eight seeds — non-blocking, filing an issue
   rather than failing a build. See §9.
6. **No load/performance/soak coverage** for the proxy under sustained
   concurrent request load or long-running sidecar sessions.

---

## 9. CI gates & the local equivalents

CI (`.github/workflows/ci.yml`) runs on every pull request, on pushes to `main`
and `dev`, and — inertly, since no Merge Queue exists on a user-owned repo — in
the merge queue. Its two jobs, `test` and `windows`, are **required status
checks** on `main` alongside `release-gates.yml`'s `gate`, so they block the
merge button rather than merely reporting; the branch must also be up to date
with `main` before it can merge (`docs/admin/branch-rulesets.md`). It has **two
concurrent jobs**.

**Job `test`** (`ubuntu-latest`) — the product gate. Steps, in order:

1. Verify Node `node:sqlite` support (the app uses it).
2. Pinned Bun setup (`.github/actions/setup-bun`, version read from `.bun-version`).
3. `bun install`.
4. **`bun run lint:fast`** (oxlint) — the cheap filter. Absent from every
   workflow until `ci:check` (step 13) named it.
5. **`bun run lint:all`** (full-tree ESLint, `eslint --cache .`).
6. **`bun run typecheck`** (`tsc`).
7. **`bun run typecheck:downstream`** — compiles the simulated consumer in
   `downstream/` against the published exports map. Nothing else proves a
   downstream package can resolve and compile against `./supervisor` and
   `./control-contract`.
8. **`bun run bindings:check`** ("Committed dist is fresh") — rebuilds
   `dist/lib` and `dist/main.js` into temp dirs outside the repo and compares
   against git's *index*, so no earlier or later rebuild in this job can launder
   the result.
9. **`bun run casts:check`** (`scripts/find-casts.ts --check`) — fails on a new
   unannotated boundary cast.
10. **`bun test`** (full suite).
11. **`bun run knip`** (unused files / exports / deps).
12. **`bun run deps:check`** (dependency-cruiser via `scripts/check-deps.ts`).
    All three `error` rules affect the exit code: `no-circular` is no longer a
    `warn`, and the standing backlog is ratcheted against a recorded set of
    cycle-closing imports in that script. A new cycle fails by name; fixing one
    fails too, until the set is re-recorded (`--update`).
13. **`bun run dupes:check`** (`scripts/check-dupes.ts`) — a down-only ratchet on
    the set of `src/**` file pairs sharing a jscpd clone. A pair set, not a
    percentage: `src` is ~31k lines, so a 40-line copy moves 0.33% to 0.46% and
    any threshold green today would swallow it.
14. **`bun run ci:check`** (`scripts/ops/check-ci-coverage.ts`) — asserts every
    `check:deep` step is named by a job that is a required status check. It is
    the gate against this repo's most-repeated failure: a check that exists, is
    correct, and runs nowhere. It found `lint:fast` running in no workflow at
    all on its first run.
15. **`bun run build`**.
16. **`bun run e2e`** — the seam / feed / lifecycle / replace harnesses, against
    `src/` rather than a compiled artifact. Until this step they ran only in the
    `windows` job via `e2e:binary`, so the from-source path (what `bun run dev`
    and `bun start` use) ran in no workflow, and neither did Linux.

**Job `windows`** (`windows-latest`) — the `bun-windows-x64` release leg, run
before a tag exists: a runner-arch assertion, `bun install`, then
`build:binary`, `verify:artifact`, and `e2e:binary` against the compiled
artifact, and finally `bun test`. It exists because Windows used to be
exercised only by `release-artifacts.yml` on a tag push, which is how v0.4.2
shipped with no binaries — an inline `prepare` one-liner that Bun's Windows shell
rejects failed `bun install` outright, after the tag was already immutable.
**`bun test` runs last in this job**, deliberately after the release leg so a
unit failure cannot short-circuit ahead of a build/verify/e2e failure. It was
absent until the 22 POSIX assumptions in `tests/**` that failed there were
fixed; 1 case stays `skipIf`-ed on `win32` (in `tests/secrets.test.ts`), with
the reason at its skip site.

Security workflows (CodeQL, trufflehog) run alongside, `release-gates.yml`
checks a PR's milestone and bump, and `randomized-test-order.yml` runs nightly
(see below). There is **no** build/sign/publish pipeline on a *PR* — no dmg,
MSI, checksums, or signing — and no release automation: a release is a GitHub
milestone, tagged by hand, and it is the tag push that fires
`release-artifacts.yml` (see `docs/architecture.md` → *Release & PR conventions*
and `docs/release-runbook.md`).

### Why `--randomize` is not a PR gate

Step 9 of `test` runs `bun test` in its declared order, deliberately. `bun test
--randomize` is the only mechanical detector we have for the cross-file
shared-state class (§5.1, §5.6), but it is the wrong shape for a merge gate:

- **It fails PRs for defects they did not introduce.** The two flakes fixed
  alongside this section were latent for months and surfaced on seeds unrelated
  to any change. As a required check, that is an unrelated PR going red and a
  contributor debugging someone else's leak — the reliable path to a gate people
  learn to re-run until green, which is worse than no gate.
- **Not every failure it surfaces is seed-reproducible.** Some of the suites it
  shuffles spawn real engines on real ports; under a loaded runner those fail on
  timing, at any seed. A gate must distinguish "your change is wrong" from "the
  runner was busy", and this one cannot.
- **Reproducibility itself is fine.** Bun prints `--seed=<N>` in the run summary
  on every `--randomize` run, pass or fail, so the seed is always in the log and
  a failure replays exactly. That objection does not survive contact.

So the disposition is: **a separate scheduled job**, several seeds per run,
non-blocking, filing an issue on failure — plus `--randomize` in the local loop
when you touch a shared singleton or add a `mock.module`. Run a spread of seeds;
one passing seed proves nothing.

That job is now **`randomized-test-order.yml`** (nightly at 05:41 UTC, plus
`workflow_dispatch` with an optional pinned `seed` input to replay a reported
failure). It runs eight seeds per night — `seq $((run_number * 8))
$((run_number * 8 + 7))`, so the seeds are a function of the run number and are
known before the run starts — and on any failure it files or comments on one
idempotent `flaky-order`-labelled issue rather than going red. It does not
auto-close on a clean night: this class is intermittent, and one green run is
not evidence.

### Duplication: a ratchet on file pairs, not a percentage

`bun run dupes:check` (`scripts/check-dupes.ts`, tuning in `.jscpd.json`) runs
jscpd and fails when **a pair of files in `src/**` starts sharing copy-pasted
code that it did not share before**. `bun run dupes` prints the full inventory
across `src`, `tests` and `scripts` and gates nothing. It is in `check:deep`.

**Measured first.** jscpd over `src`, `tests` and `scripts`, TypeScript only:

| min-tokens | clones | duplicated lines |
|---|---|---|
| 30 | 457 | 6.15% |
| 50 | 119 | 2.48% |
| 100 | 13 | 0.55% |

and at min-tokens 50, split by tree: `src` **0.33%** (10 clones, 9 of them
inside a single file), `scripts` **0.95%** (11), `tests` **5.16%** (96). Across
the whole repo, 92 of the 119 clones are a file against itself, and there are
just 15 distinct cross-file pairs. In `src` there is exactly one:
`poll-access-token.ts` ↔ `refresh-access-token.ts`.

Three decisions follow, and the numbers picked all of them.

- **min-tokens 50 is the floor.** At 30, cross-file matches in `src` go from 1
  to 17, and the extra 16 are import blocks and the parallel route-handler
  idiom (`chat-completions/handler.ts` ↔ `responses/handler.ts`, three times).
  The e2e scripts' shared check/reporter idiom starts matching there too. Those
  are the shape of the codebase, not defects in it, and a detector that reports
  them gets switched off — after which it enforces nothing. `--skip-comments`
  is on; it happened to change nothing today, and is kept as cheap insurance
  against two files sharing a long doc comment.
- **A percentage threshold cannot work here, and the arithmetic says so.**
  `src` is ~31k lines at 0.33%. A 40-line function copy-pasted into a second
  file moves that to 0.46%; fifty of them still sit under 1%. Any threshold
  loose enough to be green today is loose enough to swallow every copy-paste
  anyone will actually commit. This is the same argument `scripts/check-deps.ts`
  makes against counting cycles rather than recording them, and it lands harder
  because the denominator is bigger.
- **The identity is the unordered pair of files.** A clone is reported as two
  line ranges, so keying on those makes every entry churn when a line is
  inserted above one of them — and a baseline that churns gets `--update`d
  reflexively, which is the same as not having one. The file pair is invariant
  under that, is what a reviewer actually wants to know, and is what changes
  when someone copies code.

**Scope.** Only `src/**` is gated. `tests/**` is out because 96 of the 119
clones live there and they are near-identical *test bodies* — the thing §10
calls correct. Folding those into a table costs the property tests exist for:
reading a failure and knowing what broke. `scripts/**` is out because it is
tooling rather than the product. Both stay in `bun run dupes`.

**Two limits, stated rather than buried.** It finds copy-paste, **not
reimplementation** — the question that prompted building it ("was this fix
implemented twice, two different ways?") is one jscpd cannot answer, because two
different implementations share no tokens. And it is pair-granular: a *second*
copy-paste between two files that already share one adds no pair and passes.
That is the same limitation `check-deps.ts` accepts for its edges, for the same
reason.

**Not yet in CI.** `check:deep` runs it, so it gates the local loop and anyone
following `AGENTS.md`. Adding the step to `ci.yml`'s `test` job is a one-line
change this workstream did not own; until it lands, `check:deep` is a strict
superset of CI rather than an exact match.

**Local pre-merge equivalents:**

- `bun run check:fast` = `lint:fast → typecheck → lint:all`.
- `bun run check:deep` = `check:fast → casts:check → bun test → knip →
  deps:check → dupes:check → build → typecheck:downstream → bindings:check`.
  This is a superset of the `test` job's step list above, so green here means
  green there. It says nothing about the `windows` job, which builds and
  exercises a compiled artifact on a Windows runner — nothing local reproduces
  that.
- `bun run check:ops` = `typecheck:ops → test:ops`, for `scripts/ops/` (its own
  tsconfig and test run; `tooling-ci.yml` is the CI counterpart).
- **Pre-commit hook** (simple-git-hooks → lint-staged): `bun run lint --fix` +
  `scripts/secret-scan.sh` on staged files. Note this runs the staged-file
  `lint`, not full-tree `lint:all`; §5.4 still applies — run `lint:all` yourself
  before pushing. The hooks are installed by the `prepare` script
  ([`scripts/ops/prepare.ts`](../../scripts/ops/prepare.ts)), which verifies the
  install landed — `simple-git-hooks` swallows its own errors and exits 0.

The single most common CI-only failure is a lint error in a file the local
pre-commit hook didn't lint (it only sees staged files; §5.4). Running
`check:fast` (which calls `lint:all` over the full tree) before pushing
catches it.

---

## 10. Conventions summary (quick reference for reviewers)

- Test files: `tests/<subject>.test.ts`, colocated by subject, not by layer.
- Prefer **in-process** route testing (`server.request`) over spawning a
  listener.
- Prefer **injectable dependencies** over `mock.module` (§5.1).
- Never touch real user credentials; rely on the preload isolation (§4).
- For branchy/security-critical logic, **run Stryker and adjudicate every
  survivor** per the three-bucket rule (§6).
- Run **`lint:all`** (full tree, not just staged files) before pushing (§5.4).
- Restore your spies (`spy.mockRestore()`); the global net is a backstop (§5.2).
- Keep Bun pins in lockstep (`.bun-version` ↔ CI).
