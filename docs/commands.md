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
bun run bindings:check  # committed dist/lib + dist/main.js vs a fresh build.
                     # Off-pin Bun → "could not verify" (exit 2), never "stale".
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file

# Aggregates
bun run check:fast   # lint:fast + typecheck + lint:all (the per-edit inner loop)
bun run check:deep   # preflight + check:fast + casts:check + bun test + knip +
                     # deps:check + dupes:check + ci:check + build +
                     # typecheck:downstream + bindings:check (end-of-task gate;
                     # every step of it also runs in a required CI job — that is
                     # what ci:check asserts, `preflight` excepted and recorded)
bun run preflight    # fail if node_modules is missing, before any check that
                     # would blame something else for it (scripts/preflight.ts).
                     # Only checks that node_modules exists — not that the
                     # install is complete or current. Never installs for you.
bun run deps:check   # dependency-cruiser (scripts/check-deps.ts). All three
                     # `error` rules fail the build. `not-to-test` and
                     # `no-route-imports-from-lib-or-services` are absolute;
                     # `no-circular` is ratcheted against the set of imports
                     # that close a cycle, recorded in scripts/check-deps.ts.
                     # A new one fails and is named; fixing one also fails,
                     # until you re-record it. The recorded set is the only
                     # statement of how many cycles there are — no count is
                     # written down anywhere else, here included.
bun run deps:check --list    # the standing cycles, grouped by component
bun run deps:check --update  # re-record after fixing cycles (refuses to add)
bun run knip         # find unused exports/files

# Secret scanning
bun run scan:secrets # manual full-repo trufflehog scan. Requires trufflehog on
                     # PATH (`brew install trufflehog`). Honors .trufflehog-exclude
                     # — which NOTHING else reads: CI runs the trufflehog action
                     # over the PR diff, and the pre-commit hook scans only staged
                     # paths. Excluding a path here does not exclude it there.

# End-to-end (spawns the real binary + a real port; outside `bun test`)
bun run e2e          # e2e:seam + e2e:feed + e2e:lifecycle + e2e:replace
bun run e2e:binary   # the same four harnesses against a compiled binary
                     # --binary=<path> runs them against an existing artifact
                     # instead of compiling a throwaway one

# Mutation testing (manual only — not wired into check:deep)
bun run mutate       # Stryker; configure module under test in stryker.conf.json

# Release tooling
bun run release:check pr <n>              # scripts/ops/release-gates.ts — one PR's
bun run release:check milestone vX.Y.Z    # title + milestone, or the whole
bun run release:check version vX.Y.Z      # milestone, or tag vs package.json.
                                          # A subcommand is required; bare prints usage.
bun run release:notes v0.2.1  # milestone -> CHANGELOG-shaped Markdown
                              # --release-body for a GitHub Release body
bun run release:manual vX.Y.Z  # cut the version. Refuses (exit 1, nothing written)
                               # on a missing tag, a dirty tree, an off-pin Bun, or
                               # a milestone release:notes would not emit for; then
                               # bumps, rebuilds dist/ on the pinned Bun, writes the
                               # CHANGELOG entry itself, commits all three, tags,
                               # pushes, and runs `bun publish --access public`.
bun run release:manual vX.Y.Z --no-publish   # cut the tag, skip the registry
bun run release:preflight     # assert the pinned Bun without cutting anything

# Ops tooling under scripts/ops/ (own tsconfig + test run)
bun run check:ops    # typecheck:ops + test:ops
bun run ci:check     # every step of check:deep also runs in a job that is a
                     # REQUIRED status check (scripts/ops/check-ci-coverage.ts).
                     # A check wired into check:deep and into no workflow — the
                     # shape dupes:check and .dependency-cruiser.cjs both had —
                     # fails here by name. Offline; it is in check:deep and in
                     # ci.yml. Deliberate exclusions live in that file, each
                     # with its reason.
bun run rules:check  # the live branch rulesets on `main` vs the floor recorded
                     # in scripts/ops/check-rulesets.ts. Needs the network, so it
                     # is NOT in check:deep; the daily watch-branch-rules.yml
                     # runs it and files an issue. Exit 1 drift, 2 unreadable.
                     # `bypass_actors` is only visible to a token that can read
                     # repo administration — unauthenticated or from Actions it
                     # reports that assertion as unverified, never as drift.
                     # docs/admin/branch-rulesets.md
bun run watch:drift  # the daily external-surface pin watch (docs/admin/external-drift-watch.md)
```

`bun run typecheck` (root `tsc`) covers `src/`, `tests/`, `scripts/`,
`eslint.config.js`, `tsup.config.ts` and `downstream/check.ts`. `scripts/ops/` is
additionally covered by `typecheck:ops`, which is what tooling-ci.yml runs.
Note that ESLint ignores `scripts/**` entirely (see `eslint.config.js`), so those
files are type-checked but only oxlint-linted.

Core is headless — there is no `shell/`, no desktop-shell build, and no UI bundle to
watch. `bun run dev -- start --port 4141` runs the proxy from source.

