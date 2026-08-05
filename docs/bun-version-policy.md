# Bun version policy

Pinned in `.bun-version` — read by `bun install`, by Bun's own version manager,
and at runtime by every CI workflow that needs Bun: `ci.yml`, `tooling-ci.yml`,
`watch-external-drift.yml`, `release-gates.yml`, and `release-tag-check.yml`
each `cat .bun-version` into `setup-bun`. No workflow — and no doc — holds a
copy of the version literal, so dev/CI drift is not representable — which is
the point: drift is what got us a 22-test failure on a Bun `latest` regression
once.

Bump intentionally — edit `.bun-version`, then regenerate the one committed
artifact that the version decides:

1. Pick the new Bun version (read its release notes — confirm no
   open regressions affecting our patterns: parallel test loading,
   module-export resolution, `with { type: "file" }` import
   attributes).
2. Install it locally, so the rest of these steps run on the version you are
   pinning and not the one you happened to have:
   `curl -fsSL https://bun.sh/install | bash -s bun-v<new>`.
3. Rebuild and stage the committed CLI bundle:
   `bun run build && git add -f dist/main.js`. **This step is not optional and
   it is not cosmetic** — see below.
4. Run the whole suite locally on the new version: `bun run check:deep`
   and `bun run check:ops`.
5. If green, commit `.bun-version` and `dist/main.js` together.
6. Watch the next CI run.

## The pin decides `dist/main.js`

`dist/main.js` is committed (`bin.maximal` points at it, so a git-dependency
install runs those exact bytes) and it is built by `bun build`, which bundles
with **Bun's own bundler**. Its output is therefore a function of the Bun
version. Measured on a 2x2 of {`ubuntu-latest`, `macos-latest`} x {1.3.11,
1.3.14}: both OSes produced identical bytes within a version, and the two
versions differed. The host OS makes no difference; the Bun version makes all
of it.

So a `.bun-version` bump silently invalidates the committed bundle. Committing
the bump without step 3 leaves `main` shipping a `bin` that nobody following
this document can regenerate — which is exactly how it stood before
maximal-core#31, where the committed bundle only reproduced under an *unpinned*
Bun a developer happened to have.

`dist/lib` is not affected: `build:lib` is tsup, which bundles with esbuild, a
pinned dependency in `package.json`. Bun is only the process runner there, and
its version provably does not move those bytes. That asymmetry is why
`bindings:check` was green for `dist/lib` across two years of dev-machine drift
and went red the moment `dist/main.js` came under the same gate.

`bun run bindings:check` enforces this from both sides: it compares the
committed bundle against a fresh build, and when the running Bun is not the
pinned one it reports **"could not verify"** (exit 2) rather than "stale" — a
stale report would have you regenerate on the wrong toolchain and commit bytes
CI still cannot reproduce.

Don't float `latest`. Bun ships fast; a release in a single afternoon
can ship a regression that breaks our test loader, and the difference
between "we picked this Bun" and "CI happened to pull this Bun" is
the difference between a one-line fix and an hour of triage.

Cadence: rev every ~4-6 weeks for hygiene, or sooner when a needed
feature/fix lands upstream. Don't let the pin go stale enough to
miss security fixes.
