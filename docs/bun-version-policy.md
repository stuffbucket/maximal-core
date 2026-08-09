# Bun version policy

Pinned in `.bun-version` — read by `bun install`, by Bun's own version manager,
and at runtime by every CI workflow that needs Bun: `tooling-ci.yml`,
`watch-external-drift.yml`, `watch-branch-rules.yml`, `randomized-test-order.yml`,
`release-gates.yml`, `release-tag-check.yml`, `publish-package.yml` and
`ci.yml`'s `windows` job each `cat .bun-version` into `setup-bun`;
[`publish-ci-image.yml`](../.github/workflows/publish-ci-image.yml) bakes it into
the toolchain image, and `ci.yml`'s `test` job runs in that image and `cat`s the
file to assert the two agree. No workflow holds a copy of the version
literal, so dev/CI drift is not representable — which is the point: drift is
what got us a 22-test failure on a Bun `latest` regression once.

Bump intentionally — edit `.bun-version`, then regenerate the one committed
artifact that the version decides:

1. Pick the new Bun version (read its release notes — confirm no
   open regressions affecting our patterns: parallel test loading,
   module-export resolution, `with { type: "file" }` import
   attributes).
2. Edit `.bun-version`, then build the toolchain image for the new pin:
   `bun run container:build`. The tag carries the pin, so this cannot reuse the
   old image — [`docs/dev/container-toolchain.md`](dev/container-toolchain.md).
3. Rebuild and stage the committed CLI bundle **on the pin**:
   `bun run container:run -- bun run build && git add -f dist/main.js`. **This
   step is not optional and it is not cosmetic** — see below.
4. Run the whole suite on the new version:
   `bun run container:run -- bun run check:deep`, then `bun run check:ops` and
   `bun run e2e`.
5. If green, commit `.bun-version` and `dist/main.js` together.
6. Watch the next CI run — including the `windows` job, which is native rather
   than containerised and is where a Bun bump has broken `bun install`'s
   lifecycle scripts before (maximal-core#38, #90).

Steps 3 and 4 can be run off the host PATH instead
(`curl -fsSL https://bun.sh/install | bash -s bun-v<new>`, pinned Bun FIRST on
`PATH`), but there is no reason to: `bun run build` now refuses to bundle when
the running Bun is not the pin, and the container is the only place that is
true without arranging anything.

**Ordering, once `ci.yml`'s `test` job runs in the toolchain image:** dispatch
[`publish-ci-image.yml`](../.github/workflows/publish-ci-image.yml) on your bump
branch *before* opening the PR. That job
names the image by a floating `latest` tag (it cannot compute one — see that
workflow's header), and its first step asserts the image's Bun equals
`.bun-version`. A bump PR opened against a not-yet-republished image fails that
gate by design, naming the fix, rather than quietly running the suite on the old
Bun and reporting `bindings:check` staleness with the wrong cause.

Steps 3-4 used to be the ones that went wrong, because they depended on your
PATH rather than on anything the repo could assert. Two things now close that:
`bun run build` is [`scripts/ops/build-bundle.ts`](../scripts/ops/build-bundle.ts),
which **refuses** to bundle when the running Bun is not the pin; and
`bun run container:run -- <command>` runs inside an image whose Bun **is**
`.bun-version` and cannot be anything else, so the refusal cannot fire there.
The image's tag carries the pin, so bumping the file builds a new image rather
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

`bun run build` **was** exposed the same way, and that one is **step 3 above**
(and the by-hand release path in the runbook's § 4): the nested `bun build`
inside the npm script re-resolved `bun` from PATH, so the rebuild that blesses a
new pin got built by whatever Bun was on PATH instead. `bindings:check` caught
it as stale, downstream, after the wrong bytes were already in the work tree —
three people hit exactly that in one session. `build` is now
[`scripts/ops/build-bundle.ts`](../scripts/ops/build-bundle.ts), which asserts
`process.versions.bun` against the pin and then bundles with `process.execPath`,
so the binary that was checked is the binary that bundles and there is no PATH
lookup in between. Off-pin it refuses, naming
`bun run container:run -- bun run build`.

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
