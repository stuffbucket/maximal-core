# Bun version policy

Pinned in `.bun-version` — read by `bun install`, by Bun's own version manager,
and at runtime by every CI workflow that needs Bun: `ci.yml`, `tooling-ci.yml`,
`watch-external-drift.yml`, `watch-branch-rules.yml`, `randomized-test-order.yml`,
`release-gates.yml`, `release-tag-check.yml`, `release-artifacts.yml`, and
`publish-package.yml` each
`cat .bun-version` into `setup-bun`. No workflow holds a copy of the version
literal, so dev/CI drift is not representable — which is the point: drift is
what got us a 22-test failure on a Bun `latest` regression once.

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

Steps 3-4 are the ones that go wrong, because they depend on your PATH rather
than on anything the repo can assert. `bun run container:run -- bun run check:deep`
runs them inside an image whose Bun **is** `.bun-version` and cannot be anything
else; its tag carries the pin, so bumping the file builds a new image rather
than reusing the old one. See
[`docs/dev/container-toolchain.md`](dev/container-toolchain.md).

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
`bindings:check` stayed green for `dist/lib` under dev-machine Bun drift from
the day it landed (maximal-core#24) and went red the moment `dist/main.js` came
under the same gate (maximal-core#31).

`bun run bindings:check` enforces this from both sides: it compares the
committed bundle against a fresh build, and when the running Bun is not the
pinned one it reports **"could not verify"** (exit 2) rather than "stale" — a
stale report would have you regenerate on the wrong toolchain and commit bytes
CI still cannot reproduce.

## The pin also decides the published tarball

`bindings:check` guards the bundle in **git**. The bundle in the **tarball** is
a second artifact built at a second time: `bun publish` fires `prepack`, which
rebuilds `dist/` into what gets uploaded. Measured against Bun 1.3.14 rather
than assumed from npm's docs, because the exposure depends on it:

```
bun publish  →  prepublishOnly → prepack → prepare → (pack) → upload
bun pm pack  →                   prepack → prepare → (pack)
```

So an off-pin releaser publishes an off-pin bundle. On `main` at v0.3.2:

```
committed dist/main.js   85697a48…   (Bun 1.3.11, the pin)
tarball   dist/main.js   ffdee378…   (Bun 1.3.14, whatever was on PATH)
```

**Installing the pinned Bun does not fix this by itself.** Bun runs lifecycle
scripts through a shell whose PATH contains neither `node_modules/.bin` nor
Bun's own bindir, so a bare `bun` inside a script re-resolves from the
developer's PATH. Invoking the pin explicitly still produced the unpinned
bundle:

```
$ /path/to/1.3.11/bin/bun pm pack     # tarball dist/main.js → ffdee378… (1.3.14)
$ /tmp/bun1311/bin/bun run build      # dist/main.js → a 1.3.14 bundle
```

`bun run build` is exposed the same way, and that one is **step 3 above** (and
the by-hand release path in the runbook's § 4): the nested `bun build` inside
the npm script re-resolves `bun` from PATH, so the rebuild that blesses a new
pin gets built by whatever Bun is on PATH instead. `bindings:check` caught it as
stale. Put the pinned Bun first on your PATH; invoking it by absolute path is
not enough.

That is the same trap `check-bindings.ts` solved with `process.execPath`, and it
is why `prepack` is [`scripts/ops/prepack.ts`](../scripts/ops/prepack.ts) rather
than `bun run build && bun run build:lib`: it version-checks
`process.versions.bun` and then bundles with `process.execPath`, so the binary
that was checked is the binary that bundles. Off-pin it refuses — before writing
anything into `dist/` — instead of shipping a tarball nobody can regenerate.
`bun run release:preflight` runs the same assertion with no build, and
`release:prepare` runs it ahead of `bumpp`, because the bundle `bumpp` commits is
the bundle a git-dependency consumer executes. See
[`docs/release-runbook.md`](release-runbook.md) § 4.

Don't float `latest`. Bun ships fast; a release in a single afternoon
can ship a regression that breaks our test loader, and the difference
between "we picked this Bun" and "CI happened to pull this Bun" is
the difference between a one-line fix and an hour of triage.

Cadence: rev every ~4-6 weeks for hygiene, or sooner when a needed
feature/fix lands upstream. Don't let the pin go stale enough to
miss security fixes.
