# Bun version policy

Pinned in `.bun-version` — read by `bun install`, by Bun's own version
manager, and at runtime by every CI workflow (`ci.yml`, `tooling-ci.yml`,
`watch-external-drift.yml` each `cat .bun-version` into `setup-bun`). No
workflow holds a copy of the version literal, so dev/CI drift is not
representable — which is the point: drift is what got us a 22-test failure on
a Bun `latest` regression once.

Bump intentionally — edit `.bun-version`, nothing else:

1. Pick the new Bun version (read its release notes — confirm no
   open regressions affecting our patterns: parallel test loading,
   module-export resolution, `with { type: "file" }` import
   attributes).
2. Run the whole suite locally on the new version: `bun run check:deep`
   and `bun run check:ops`.
3. If green, commit the one-line `.bun-version` change.
4. Watch the next CI run.

Don't float `latest`. Bun ships fast; a release in a single afternoon
can ship a regression that breaks our test loader, and the difference
between "we picked this Bun" and "CI happened to pull this Bun" is
the difference between a one-line fix and an hour of triage.

Cadence: rev every ~4-6 weeks for hygiene, or sooner when a needed
feature/fix lands upstream. Don't let the pin go stale enough to
miss security fixes.
