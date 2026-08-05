# Commands

Every script below is defined in `package.json`.

```sh
bun install          # Install dependencies
bun run dev          # Dev mode with watch
bun run build        # Bundle src/main.ts to dist/ (bun build --target=bun)
bun run build:lib    # Library build of the consumer exports (tsup -> dist/lib)
bun run start        # Production start (NODE_ENV=production)

# Lint / type / test
bun run lint         # ESLint with cache (auto-fixes staged files pre-commit)
bun run lint:all     # ESLint on entire project
bun run lint:fast    # oxlint — mechanical pass, ~10ms full repo
bun run typecheck    # tsc type check only (no emit)
bun run typecheck:downstream  # compile the downstream/ consumer against the exports map
bun run casts:check  # fail on a new unannotated boundary cast (scripts/find-casts.ts)
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file

# Aggregates
bun run check:fast   # lint:fast + typecheck + lint:all (the per-edit inner loop)
bun run check:deep   # check:fast + casts:check + bun test + knip + deps:check +
                     # build + typecheck:downstream + bindings:check
                     # (end-of-task gate; superset of CI)
bun run deps:check   # dependency-cruiser. Only its two `error` rules affect the
                     # exit code (`not-to-test`, `no-route-imports-from-lib-or-services`).
                     # `no-circular` is `warn` with 47 standing matches and never
                     # fails — green here is NOT "no cycles". Read the output.
bun run knip         # find unused exports/files

# Secret scanning
bun run scan:secrets # manual full-repo trufflehog scan. Requires trufflehog on
                     # PATH (`brew install trufflehog`). Honors .trufflehog-exclude
                     # — which NOTHING else reads: CI runs the trufflehog action
                     # over the PR diff, and the pre-commit hook scans only staged
                     # paths. Excluding a path here does not exclude it there.

# End-to-end (spawns the real binary + a real port; outside `bun test`)
bun run e2e          # e2e:seam + e2e:feed + e2e:lifecycle
bun run e2e:binary   # same seams against a compiled binary

# Mutation testing (manual only — not wired into check:deep)
bun run mutate       # Stryker; configure module under test in stryker.conf.json

# Release tooling
bun run release:check         # scripts/ops/release-gates.ts (milestone + bump)
bun run release:notes v0.2.1  # milestone -> CHANGELOG-shaped Markdown
                              # --release-body for a GitHub Release body
bun run release:manual        # cut the version: guard, preflight, bump,
                              # rebuild dist/ on the pinned Bun, commit, tag, push
bun run release:manual --no-publish   # cut and push the tag, skip the registry
bun run release:preflight     # assert the pinned Bun without cutting anything

# Ops tooling under scripts/ops/ (own tsconfig + test run)
bun run check:ops    # typecheck:ops + test:ops
```

`bun run typecheck` (root `tsc`) covers `src/`, `tests/`, `scripts/`,
`eslint.config.js`, `tsup.config.ts` and `downstream/check.ts`. `scripts/ops/` is
additionally covered by `typecheck:ops`, which is what tooling-ci.yml runs.
Note that ESLint ignores `scripts/**` entirely (see `eslint.config.js`), so those
files are type-checked but only oxlint-linted.

Core is headless — there is no `shell/`, no desktop-shell build, and no UI bundle to
watch. `bun run dev -- start --port 4141` runs the proxy from source.

