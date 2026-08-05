# Commands

```sh
bun install          # Install dependencies
bun run dev          # Dev mode with watch
bun run build        # Build to dist/ (native Bun import attributes)
bun run start        # Production start (NODE_ENV=production)

# Lint / type / test
bun run lint         # ESLint with cache (auto-fixes staged files pre-commit)
bun run lint:all     # ESLint on entire project
bun run lint:fast    # oxlint — mechanical pass, ~10ms full repo
bun run typecheck    # tsc type check only (no emit)
bun test             # Run all tests
bun test tests/foo.test.ts  # Run a single test file

# Aggregates
bun run check:fast   # lint:fast + typecheck + lint:all (the per-edit inner loop)
bun run check:deep   # check:fast + bun test + knip (end-of-task gate)
bun run deps:check   # dependency-cruiser layer rules
bun run knip         # find unused exports/files

# Mutation testing (manual only — not wired into check:deep)
bun run mutate       # Stryker; configure module under test in stryker.conf.*

# Release tooling
bun run release:notes v0.2.1  # milestone -> CHANGELOG-shaped Markdown
                              # --release-body for a GitHub Release body
bun run release:manual        # cut the version (bumpp + bun publish)

# Ops tooling under scripts/ops/ (own tsconfig + test run)
bun run check:ops    # typecheck:ops + test:ops
```

Core is headless — there is no `shell/`, no desktop-shell build, and no UI bundle to
watch. `bun run dev -- start --port 4141` runs the proxy from source.

