# PRD: Realtime Expert-Level Feedback for LLM Codegen

## Problem

LLM-generated code typically fails in ways type checkers and basic linters miss: floating promises, non-exhaustive switches, silent `any`, layering violations, near-duplicate reimplementations of existing helpers, unsafe data flow, and tests that exercise without pinning behavior. Catching these post-hoc (PR review, CI) is too late — the model has already built more code on top. We need feedback that fires fast enough to influence the next generation, not the next PR.

## Goal

A development loop where an LLM (or human) writing code receives expert-reviewer-quality feedback in the same window as the keystroke that produced it. Target: <1s for the inner loop, <10s for the deeper checks, all surfaced through a single coherent channel.

## Non-Goals

- Replacing human review on PRs.
- Achieving zero false positives — dataflow tools have inherent FP rates on dynamic JS; the goal is signal density, not purity.
- Deno or alternate-runtime support. Targets Bun + Hono + TypeScript — this repo builds with `bun build` / `tsup` and tests with `bun test`; there is no Vite and no vitest to hang tooling off.

## Success Criteria

- Type, lint, and architectural errors visible in <1s of save on a representative file.
- Test feedback on changed file <3s.
- Dead-code, duplication, and structural violations surfaced before the next commit.
- Security/dataflow signal available pre-PR (not blocking the inner loop).
- One unified error surface (LSP diagnostics plus a single watcher's output), not ten terminals. There is no browser dev-server overlay to route into — the target is a headless Bun process.

## Feedback Layers

### L1 — As-you-type (50–200ms)

| Tool | Role |
|---|---|
| TypeScript LSP, strict++ | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables` |
| `oxlint` | Mechanical lint pass, ~50–100× faster than ESLint |
| `ts-reset` | Patches built-in types so `JSON.parse`, `.filter(Boolean)`, etc. don't silently widen to `any` |

### L2 — On save (200ms–1s)

| Tool | Role |
|---|---|
| `tsc --watch` + `bun run lint`, behind one watcher | Unifies TS + ESLint into a single diagnostic channel. (`vite-plugin-checker` is the usual answer here, but it's Vite-only and this repo has no Vite.) |
| ESLint with `@typescript-eslint` logic rules | `no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, `switch-exhaustiveness-check`, `no-base-to-string`, `await-thenable` |
| `dependency-cruiser` or `eslint-plugin-boundaries` | Architectural layer rules (e.g. UI ↛ server) as errors |

### L3 — On file change (1–3s)

| Tool | Role |
|---|---|
| `bun test --watch` | Reruns on change; scoped by path filter (`bun test tests/foo.test.ts`) since Bun has no affected-only mode |
| `zod` / `valibot` at boundaries | Wrong-shape responses fail loudly at the boundary, not three calls deep |
| `ts-pattern` | Exhaustive matching on discriminated unions, enforced by types |

### L4 — On pause / pre-commit (3–10s)

| Tool | Role |
|---|---|
| `knip` | Dead exports/files — flags drift when new code orphans old code |
| `jscpd` | Near-duplicate detection — flags reimplementations of existing utilities |
| `ast-grep` rules | Project-specific structural patterns (e.g. no `fetch` outside `src/services/`) |

### L5 — Background, async surface (10s+)

| Tool | Role |
|---|---|
| CodeQL (default setup) or Semgrep Pro | Taint analysis: SQL injection, SSRF, prototype pollution, path traversal |
| `fast-check` | Property-based tests on critical pure functions, run in worker |
| Stryker, scoped to diff | Mutation testing — the only tool that answers "do tests pin behavior?" |

## Connective Tissue

- **Unified error sink**: all diagnostics route to the LSP channel and one watcher's output. No tool gets its own terminal pane.
- **Incremental everything**: `tsc --incremental`, `bun test` scoped to changed paths, oxlint per-file. Anything that can't stay <2s on single-file change drops out of the inner loop.
- **Strict tsconfig + path aliases + `CLAUDE.md`**: the model's mental model matches what the tools enforce, raising first-try pass rate.

## Minimum Viable Bundle

If only two additions are made to a stock Bun/Hono/TS repo:

1. **`oxlint` + one `tsc --watch` / ESLint watcher** — sub-second inner loop with all errors in one channel.
2. **`zod` parses at every external boundary** — turns a large class of "looks right, fails at runtime" bugs into immediate, localized failures.

## Recommended Bundle (full)

```
L1 (LSP):       tsc strict++ · oxlint · ts-reset
L2 (save):      tsc --watch · ESLint logic rules · dependency-cruiser
L3 (test):      bun test --watch · zod boundaries · ts-pattern
L4 (pause):     knip · jscpd · ast-grep rules
L5 (background) CodeQL · fast-check · Stryker (diff-scoped)
```

## Risks / Tradeoffs

- **False positives** in L5 (CodeQL, Stryker) can train the model — and the human — to ignore signal. Keep L5 advisory, never blocking.
- **Tool sprawl**: the value comes from the unified surface, not the tool count. Adding a tool that ships its own UI is a regression.
- **Lint rule drift**: ESLint configs can grow until full-repo lint exceeds the inner-loop budget. Keep ESLint scoped to logic rules; let oxlint handle mechanics.
- **CodeQL latency**: not viable inline; treat as a PR gate that posts back into the editor's diagnostics asynchronously.

## Open Questions

- ~~Biome vs. oxlint for L1~~ — **settled**: `lint:fast` is oxlint (mechanics), `lint:all` is ESLint (logic rules). Biome is not a dependency and isn't being evaluated.
- `dependency-cruiser` placement is **half settled**: it already runs as `deps:check` inside `check:deep`. Still open is whether to also surface it as an LSP diagnostic via its ESLint adapter.
- Whether to wire CodeQL results back into the editor's diagnostics via a custom LSP shim, or leave them as GitHub PR annotations.

## Out of Scope (for now)

- Runtime tracing / OpenTelemetry in dev — useful, but a separate workstream.
- Agent-specific harness changes (worktree orchestration, context packing). Covered elsewhere.
- Rust/Tauri-side equivalents (`clippy`, `cargo check`, MIRAI/Kani). Mirror structure, separate doc.
