# Testing Strategy — maximal

**Status:** Living document, prepared for external review.
**Last updated:** 2026-07-09.
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
| Secret scanning | **trufflehog** + `scripts/secret-scan.sh` | Runs pre-commit (lint-staged) and in CI. |

**Runtime pin:** Bun is pinned via `.bun-version`, which every CI workflow
reads at runtime — no workflow holds a copy to drift from (see
`docs/bun-version-policy.md`). Rationale: the test runner *is* the runtime, so a
Bun version delta can change test outcomes.

---

## 4. Test isolation & safety

Two global safeguards are registered via `bunfig.toml`'s `[test] preload`
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

---

## 6. Mutation testing (the differentiator)

### How it's configured
StrykerJS, invoked manually via `bun run mutate`. The config
(`stryker.conf.json`) is **deliberately narrow**: `testRunner: "command"`
pointed at a single test file, `mutate` scoped to a single module. A run takes
~30s–2min. It is **not** wired into `check:fast` or `check:deep` — it is a
manual, targeted instrument, not a CI gate.

Usage pattern: point `mutate` at one pure-logic module, point the command
runner at that module's test file, run, then read the surviving mutants.

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

**Deliberate non-goal:** we do **not** gate CI on a mutation-score threshold.
It is slow, flaky under concurrency, and a global number invites gaming. The bar
is the *per-survivor disposition rule above*, applied during review of
test/logic PRs — not a percentage.

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
   the fire-and-forget `mock.module` forms, literal data stubs, and a deny-list
   of known-passive modules. **Residual gap, and it is structural:** the rule
   cannot decide whether a *given* mock is safe, because that depends on the
   whole run's module graph rather than the call site — and an `afterAll` restore
   cannot help, since Bun links every file's imports before any hook runs. The
   same applies to plain module-level singletons (§5.6), which no lint rule
   sees at all. So "prefer real/injectable deps for shared state" still rests on
   review. **The one mechanical detector we have is `bun test --randomize`**, and
   it is not yet run on a schedule — see §9.
6. **No load/performance/soak coverage** for the proxy under sustained
   concurrent request load or long-running sidecar sessions.

---

## 9. CI gates & the local equivalents

CI (`.github/workflows/ci.yml`) runs on every push/PR and is the merge gate.
Steps, in order:

1. Verify Node `node:sqlite` support (the app uses it).
2. Pinned Bun setup (`.github/actions/setup-bun`, version read from `.bun-version`).
3. `bun install`.
4. **`bun run lint:all`** (full-tree ESLint, `eslint --cache .`).
5. **`bun run typecheck`** (`tsc`).
6. **`bun run typecheck:downstream`** — compiles the simulated consumer in
   `downstream/` against the published exports map. Nothing else proves a
   downstream package can resolve and compile against `./supervisor` and
   `./control-contract`.
7. **`bun run casts:check`** (`scripts/find-casts.ts --check`) — fails on a new
   unannotated boundary cast.
8. **`bun test`** (full suite).
9. **`bun run knip`** (unused files / exports / deps).
10. **`bun run build`**.

Security workflows (CodeQL, trufflehog) run alongside, and `release-gates.yml`
checks a PR's milestone and bump. There is **no** build/sign/publish pipeline —
no dmg, MSI, checksums, or smoke test on release — and no release automation:
a release is a GitHub milestone, tagged by hand (see `docs/architecture.md`
→ *Release & PR conventions* and `docs/release-runbook.md`).

### Why `--randomize` is not a PR gate

Step 8 runs `bun test` in its declared order, deliberately. `bun test
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

**Local pre-merge equivalents:**

- `bun run check:fast` = `lint:fast → typecheck → lint:all`.
- `bun run check:deep` = `check:fast → casts:check → bun test → knip → build →
  typecheck:downstream`. This is a superset of the CI step list above, so green
  here means green there.
- `bun run check:ops` = `typecheck:ops → test:ops`, for `scripts/ops/` (its own
  tsconfig and test run; `tooling-ci.yml` is the CI counterpart).
- **Pre-commit hook** (simple-git-hooks → lint-staged): `bun run lint --fix` +
  `scripts/secret-scan.sh` on staged files. Note this runs the staged-file
  `lint`, not full-tree `lint:all`; §5.4 still applies — run `lint:all` yourself
  before pushing.

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
