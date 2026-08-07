# The pinned toolchain image. Built and run by `scripts/dev/container.ts`;
# see docs/dev/container-toolchain.md for why this exists.
#
# Nothing from the repo is COPYed in. The source tree is bind-mounted at run
# time, so this image is a pure function of the toolchain and only has to be
# rebuilt when the toolchain moves — not when the code does.
#
# Build context is this directory, not the repo root: a repo-root context would
# upload node_modules and dist on every build for a Dockerfile that reads
# neither.

# Node 24 for unflagged `node:sqlite` — ci.yml's `test` job verifies that import
# explicitly before anything else runs, and src/lib/platform/sqlite.ts depends
# on it.
FROM node:24-bookworm-slim

# No default: a build that forgets to pass it fails here rather than floating to
# whatever `bun.sh/install` serves today. scripts/dev/container.ts reads
# .bun-version and passes it.
ARG BUN_VERSION

# `git` is not optional — scripts/ops/check-bindings.ts and
# scripts/dev/verify-build.ts both spawn it. `unzip` is what Bun's install
# script needs to unpack the release tarball.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# The same command .github/actions/setup-bun/action.yml runs, so the container
# and every CI job install Bun by the identical path. BUN_INSTALL=/usr/local
# rather than the default $HOME/.bun: containers run as the host's uid (see the
# runner script), which has no home directory in this image, and a Bun under
# root's $HOME would not be on that uid's PATH.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

# Refuse to produce an off-pin image at all, rather than producing one that
# reports the wrong cause later. Same posture as scripts/ops/prepack.ts, which
# asserts the running Bun before it writes anything into dist/.
RUN test "$(bun --version)" = "${BUN_VERSION}" \
  || { echo "bun $(bun --version) != requested ${BUN_VERSION}" >&2; exit 1; }

# The work tree is bind-mounted and owned by the host uid, which git treats as
# "dubious ownership" and refuses to read. Without this, `bindings:check` exits
# 2 ("could not verify") instead of comparing against the index — a stale-vs-
# unverifiable distinction that file goes out of its way to preserve.
RUN git config --system --add safe.directory '*'

# Containers run as the HOST's uid (see scripts/dev/container.ts for why), which
# has no entry in this image's /etc/passwd and therefore no home directory.
# Plenty of the toolchain writes to $HOME — Bun's install cache above all — and
# an unset or unwritable one fails as ENOENT somewhere unhelpful. A world-
# writable directory named by ENV works for any uid without a run-time flag.
ENV HOME=/home/dev
RUN mkdir -p /home/dev && chmod 0777 /home/dev

# `/work/node_modules` is a named volume (scripts/dev/container.ts). Docker
# seeds a fresh named volume from whatever the image has at that path — so this
# empty, world-writable directory is what decides the volume's ownership. Drop
# it and the volume is created root-owned 0755, and `bun install` as the host
# uid dies with a bare `bun is unable to write files: AccessDenied`.
RUN mkdir -p /work/node_modules && chmod 0777 /work /work/node_modules

WORKDIR /work
