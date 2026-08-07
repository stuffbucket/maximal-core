# The pinned container toolchain

`bun run container:run -- <command>` runs any command against this work tree
inside an image where Bun is exactly `.bun-version` and cannot be anything else.

```sh
bun run container:build              # build the image for the current pin
bun run container:run -- bun run check:deep
bun run container:run -- bun test tests/secrets.test.ts
bun run container:shell              # interactive bash, same environment
```

`container:run` builds the image on first use, so `container:build` is only
needed to rebuild deliberately.

## Why

`dist/main.js` is committed and is a **function of the Bun version** — see
[`bun-version-policy.md`](../bun-version-policy.md), where the 2x2 measurement
lives. So `bindings:check` is only meaningful on the pin. Worse, `bun run build`
re-resolves a bare `bun` from PATH, so *having* the pinned Bun installed is not
enough; it has to be first. Getting that wrong does not fail loudly — it reports
the committed bundle as **stale**, which sends you off to regenerate it on the
wrong toolchain and commit bytes CI cannot reproduce. That has happened, at
scale: a dozen parallel agents each had to be told to prepend
`/tmp/bun1311/bin`, and one still emitted a 1.3.14 bundle.

CI never had this problem. Every workflow `cat .bun-version` into
[`.github/actions/setup-bun`](../../.github/actions/setup-bun/action.yml), so
the pin is structurally correct there. **The failure is local**, which is why
this landed before any change to `ci.yml`.

## The tag is the pin

The image is tagged `maximal-core-ci:bun-<version>`, read from `.bun-version` by
[`scripts/dev/container.ts`](../../scripts/dev/container.ts). A stale image is
therefore not *addressable*: bump the pin and the tag you ask for does not exist
yet, so it gets built. There is no floating name for the toolchain to drift
behind, and so nothing here needs a parity gate to keep it honest.

The Dockerfile takes `BUN_VERSION` as a build arg with **no default** and
refuses to finish if the installed Bun disagrees with it. It installs Bun with
the same `curl -fsSL https://bun.sh/install | bash -s bun-v<version>` line the
composite action uses, so the container and every CI job get Bun by an identical
path.

Nothing from the repo is `COPY`ed into the image. The tree is bind-mounted at
run time, so the image is a pure function of the toolchain: it is rebuilt when
the toolchain moves, not when the code does.

## Two decisions that look like overhead and are not

### `node_modules` is a named volume, never the host's

`oxlint`, `esbuild` (through tsup) and `jscpd` install platform-specific
binaries. One `node_modules` tree shared between a macOS host and a Linux
container leaves whichever ran last holding binaries the other cannot execute —
and the breakage presents as a toolchain bug, not as a mount. So the container
gets its own `maximal-core-node-modules` volume, populated by a `bun install` on
first use and reused after that. `$HOME` is a second volume for the same reason
and for Bun's install cache.

The host's `node_modules` is never read or written. After a container run,
`node_modules/@oxlint/binding-darwin-arm64` is still what is there.

### It runs as your uid, not as root

[`tests/config-unwritable-boot.test.ts`](../../tests/config-unwritable-boot.test.ts)
chmods a config file to `0o400` and then probes `accessSync(W_OK)` to decide
whether the fixture is constructible at all. Root bypasses DAC, so under a root
container that probe reports "not constructible" and the test falls back to
asserting the file exists. It would not go red. It would quietly stop checking
the thing it exists to check — this repo's most-repeated defect shape.

Running as the host uid also keeps container-written files out of the work tree
owned by a user the host cannot delete.

## In CI

`ci.yml`'s `test` job runs in this image
(`ghcr.io/stuffbucket/maximal-core/ci:latest`, built and pushed by
[`publish-ci-image.yml`](../../.github/workflows/publish-ci-image.yml)), so it no
longer installs Bun or Node per run.

**The image has to exist before the job can use it**, and that ordering is not
advisory. When the containerised job was first proposed alongside its publisher,
its very first run died at container creation:

```
docker pull ghcr.io/stuffbucket/maximal-core/ci:latest
Error response from daemon: manifest unknown
```

No step executed, so no amount of re-running would have helped. The publisher
therefore landed on its own first (maximal-core#98, via maximal-core#91); a
`workflow_dispatch` cannot substitute, because a workflow is only dispatchable
once it is on the default branch.

It names the **floating** `latest` tag rather than `bun-<version>`, for one
mechanical reason: `jobs.<id>.container.image` is resolved before any step of
the job runs, so it cannot read a step output. Computing the tag from
`.bun-version` would need a preceding job and a `needs:` edge — and if that job
failed, `test` would never run, so the *required* `test` status check would
never report and the PR would wedge with no way to push a fix past it. That is
worse than the drift it prevents. So the job's first step asserts
`bun --version` equals `.bun-version` and fails loudly if it does not, which is
what makes the float safe.

The consequence is an ordering rule when the pin moves: publish the image, then
open the bump PR. It is written down in
[`bun-version-policy.md`](../bun-version-policy.md).

The job also runs `--user 1001:1001` (the `runner` uid), not root — see the
section above; container jobs are root by default and
`tests/config-unwritable-boot.test.ts` now refuses to run that way.

The `windows` job stays native on
[`.github/actions/setup-bun`](../../.github/actions/setup-bun/action.yml), which
also remains in use by every other workflow.

## Why not `act`

[`act`](https://github.com/nektos/act) runs the *workflow*, on images that
*approximate* GitHub's runners. Two approximations, and the gap between them is
the class of bug this repo keeps finding late. It also cannot run
`windows-latest` at all — which is where every Windows defect in the record
actually lives (maximal-core#90) — so it does not buy the thing that hurts most.

An image we define is exact, and it is the primitive: one Dockerfile, one tag,
the same bytes on a laptop and in CI. `act` can be pointed at that image
afterwards (`-P ubuntu-latest=maximal-core-ci:bun-<version>`) if anyone wants
workflow-level rehearsal. Image first; `act` is optional and nothing here
depends on it.

## What it does not cover

**Windows.** A Linux container cannot host the `windows` job, and that job is
where `bun install`'s lifecycle scripts get exercised under Bun's built-in
Windows shell — the check that catches the maximal-core#38 class. See
maximal-core#88, #89 and #90, all labelled `needs-windows`.

**macOS-specific behaviour.** The container is Linux. Running the suite there is
additional coverage, not a replacement for running it on the host.
