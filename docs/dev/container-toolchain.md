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
used to re-resolve a bare `bun` from PATH, so *having* the pinned Bun installed
was not enough; it had to be first. Getting that wrong did not fail loudly — it
reported the committed bundle as **stale**, which sends you off to regenerate it
on the wrong toolchain and commit bytes CI cannot reproduce. That has happened,
at scale: a dozen parallel agents each had to be told to prepend
`/tmp/bun1311/bin`, and one still emitted a 1.3.14 bundle.

`bun run build` now refuses off-pin
([`scripts/dev/../ops/build-bundle.ts`](../../scripts/ops/build-bundle.ts)), so
the silent path is closed. The refusal names this container, because inside it
the running Bun **is** the pin and the guard cannot fire — the guard compares
versions and nothing else, so `container:run -- bun run build` needs no
container awareness and cannot deadlock on one.

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

Its base image is pinned by **digest**, not just by tag
(`node:24-bookworm-slim@sha256:…`). `node:24-bookworm-slim` floats — it moves on
every upstream rebuild — so a tag-only base would make the image a function of
the day it was built as well as of `.bun-version`, and the `bun-<pin>` tag would
stop being the whole story. Refresh it with
`docker buildx imagetools inspect node:24-bookworm-slim` and take the top-level
`Digest:`, which is the multi-arch index and therefore resolves on arm64 and
amd64 alike.

Nothing from the repo is `COPY`ed into the image. The tree is bind-mounted at
run time, so the image is a pure function of the toolchain: it is rebuilt when
the toolchain moves, not when the code does.

## Linked worktrees

Most work here happens in a linked worktree (`docs/architecture.md` →
_Parallel-agent convention_), and a linked worktree's `.git` is a **file**, not a
directory:

```
gitdir: /Users/you/repo/.git/worktrees/<name>
```

That is an absolute **host** path into the main checkout. Bind-mounting only the
worktree at `/work` left it absent inside the container, so every `git` call
exited 128 — and both things that read it degraded quietly instead of going red:
`bindings:check` reported "could not run" (the committed-`dist` freshness gate,
silently off for exactly the people most likely to break it) and `getGitVersion`
returned undefined, turning one unit test into a false negative. maximal-core#124.

`scripts/dev/container.ts` now reads that pointer and mounts the common git
directory **at the absolute path the pointer already names**. Not somewhere
tidier with `GIT_DIR` set to it: [`src/lib/update/version.ts`](../../src/lib/update/version.ts)
follows the pointer with `fs`, never through the git binary, so it honours no
environment variable — the only mount that fixes both readers is the one that
makes the existing path resolve. It also means nothing has to rewrite a file in
your work tree. One mount covers both directories git needs, because git's own
layout puts the per-worktree dir at `<common>/worktrees/<id>`; a layout that is
not that is refused with a named reason rather than half-mounted.

`git config --system --add safe.directory '*'` in the Dockerfile is a
**different** problem. That one is a git dir git distrusts; this one was
genuinely not there.

### The empty `node_modules` a run leaves behind

`/work/node_modules` is a named volume mounted over a path *inside* the
bind-mounted work tree, and docker creates a mount target that does not exist —
on the host, because that is where the bind source lives. A worktree with no
`node_modules` therefore acquires an empty one that the container never writes
into, and the **host** is left worse off than before the run: Bun resolves
upward past an empty directory, and `bun build` writes its module banner
comments relative to the root it actually resolved. Byte-different output for
byte-identical sources (measured: 21 banner lines).

**Removing it was tried, and it breaks the next run.** `rmdir`ing the directory
docker created as the volume's mount target leaves the shared filesystem in a
state where the following `docker run` mounts nothing useful there. Measured,
from a fresh clone with no `node_modules`, three container runs in sequence:

| | `bindings:check` | `bun test` | `bun run build` |
|---|---|---|---|
| with the removal | ok | 0 pass, 144 errors (`Cannot find package 'consola'`) | `Could not resolve: citty` |
| without it | ok | 1763 pass, 0 fail | ok |

The packages were in the volume the whole time — a later `ls` from inside the
container listed both. The cleanup did not merely fail to help, it took the
toolchain out from under the very next command. So nothing is removed.

What is left is reported instead. #125 already closed the dangerous half: the
`node_modules/.bin` probe makes `bindings:check` and `bun run build` say "could
not verify" with `bun install` as the named fix, rather than rebuilding and
calling the result stale. So the only remaining cost was meeting that message
later with no idea where the empty directory came from, and `container:run` now
prints one line naming it at the point it appears.

The container itself needs no guard for any of this: inside it `node_modules` is
the named volume, which the bootstrap `bun install`s when it is empty.

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
(`ghcr.io/stuffbucket/maximal-core/ci:bun-<version>`, built and pushed by
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

It names the per-pin tag — the same one `scripts/dev/container.ts` builds — as a
**committed literal**, not a floating `latest` and not a computed value.
`jobs.<id>.container.image` is resolved before any step of the job runs, so it
cannot read a step output: computing the tag from `.bun-version` would need a
preceding job and a `needs:` edge, and if that job failed, `test` would never
run, so the *required* `test` status check would never report and the PR would
wedge with no way to push a fix past it. A literal in the tree needs none of
that.

`latest` was the first answer to that constraint, and it cost more than the
drift it avoided: a floating tag is shared mutable state across every open PR,
so republishing it from a bump branch flipped the image under everyone else and
took every other PR red at the `Toolchain matches the pin` step. A
`.bun-version` bump was therefore mutually exclusive with every in-flight PR
(maximal-core#126). `latest` is now published only on a push to `main` and
nothing resolves it.

The literal is the one place a version string is duplicated, so it gets a gate
on each side: [`scripts/ops/check-ci-image.test.ts`](../../scripts/ops/check-ci-image.test.ts)
fails offline when the tag and `.bun-version` disagree, and the job's first step
still asserts `bun --version` equals `.bun-version` — which is what catches an
image whose *contents* disagree with its tag, something no offline check can
see.

The consequence is an ordering rule when the pin moves: publish the image, then
open the bump PR. Missing it now fails at container creation (`manifest
unknown`) rather than at the parity step. It is written down in
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
