#!/usr/bin/env bun
/**
 * Run this repo's checks inside the pinned toolchain image.
 *
 *   bun run container:build              # build the image for the current pin
 *   bun run container:run -- <command>   # run <command> in it, on this tree
 *   bun run container:shell              # interactive bash in it
 *
 * ## Why this exists
 *
 * `dist/main.js` is committed and is a function of the Bun version
 * (docs/bun-version-policy.md), so `bindings:check` is only meaningful on the
 * pin — and `bun run build` re-resolves a bare `bun` from PATH, so putting the
 * pinned Bun somewhere is not enough, it has to be *first*. Getting that wrong
 * does not fail loudly: it reports the committed bundle as stale, which sends
 * you to regenerate it on the wrong toolchain. The container removes the
 * question by removing the choice.
 *
 * CI never had this problem — every workflow `cat .bun-version` into
 * `.github/actions/setup-bun`. The failure is local, which is why this ships
 * before any change to ci.yml.
 *
 * ## The tag IS the pin
 *
 * `maximal-core-ci:bun-<version>`, read from `.bun-version`. A stale image is
 * therefore not addressable: bump the pin and the tag you ask for does not
 * exist yet, so it gets built. There is no floating name for the toolchain to
 * drift behind, and so no parity gate to keep honest.
 *
 * See docs/dev/container-toolchain.md for the whole picture, including the two
 * decisions below that are load-bearing and easy to "simplify" away.
 *
 * Exit code: the container's, so this is transparent in a `&&` chain.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const DOCKERFILE_DIR = resolve(REPO_ROOT, ".github/docker")

/**
 * A named volume, NOT the host's `node_modules`. `oxlint`, `esbuild` (through
 * tsup) and `jscpd` install platform-specific binaries, so one tree shared
 * between a macOS host and a Linux container leaves whichever ran last holding
 * binaries the other cannot execute — and the breakage looks like a toolchain
 * bug, not a mount. Persisting it also means `bun install` is paid once.
 */
const NODE_MODULES_VOLUME = "maximal-core-node-modules"

/** Bun's install cache lives in `$HOME`; keeping it makes a cold run cheap. */
const HOME_VOLUME = "maximal-core-home"

/** The pinned Bun version — the single source of truth, same as every workflow. */
export function readPin(root: string = REPO_ROOT): string {
  return readFileSync(resolve(root, ".bun-version"), "utf8").trim()
}

export function imageTag(pin: string): string {
  return `maximal-core-ci:bun-${pin}`
}

function run(
  command: string,
  args: Array<string>,
  options: { readonly cwd?: string } = {},
): number {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
  })
  if (res.error) {
    console.error(`${command}: ${res.error.message}`)
    return 127
  }
  return res.status ?? 1
}

function imageExists(tag: string): boolean {
  const res = spawnSync("docker", ["image", "inspect", tag], {
    stdio: "ignore",
  })
  return res.status === 0
}

export function buildArgs(tag: string, pin: string): Array<string> {
  return [
    "build",
    "--build-arg",
    `BUN_VERSION=${pin}`,
    "--file",
    resolve(DOCKERFILE_DIR, "ci.Dockerfile"),
    "--tag",
    tag,
    // The context is the Dockerfile's own directory, not the repo root. Nothing
    // is COPYed, and a repo-root context would upload node_modules and dist on
    // every build.
    DOCKERFILE_DIR,
  ]
}

/**
 * `bun install` when the volume is empty, then the real command. Written as one
 * `bash -c` rather than two `docker run`s so a fresh volume costs one container
 * start, and `exec "$@"` so the command keeps the container's exit status and
 * signal disposition instead of bash's. A failed install exits here rather than
 * running the command against a half-populated tree and reporting its
 * confusing downstream error instead.
 */
const BOOTSTRAP =
  '[ -d node_modules/.bin ] || bun install || exit $?; exec "$@"'

export function runArgs(
  tag: string,
  command: ReadonlyArray<string>,
  options: { readonly tty: boolean; readonly user: string | null },
): Array<string> {
  return [
    "run",
    "--rm",
    // PID 1 that reaps. `e2e:lifecycle` and `e2e:replace` spawn real servers,
    // and without an init their children outlive them as zombies.
    "--init",
    ...(options.tty ? ["--interactive", "--tty"] : []),
    // Not root. tests/config-unwritable-boot.ts chmods a file to 0o400 and
    // probes `accessSync(W_OK)` to decide whether the fixture is constructible;
    // root bypasses DAC, so as root that probe says "no" and the test degrades
    // to asserting the file exists. It would not go red — it would quietly stop
    // checking anything, which is this repo's most-repeated defect shape.
    // Running as the host uid also keeps container-written files out of the
    // work tree owned by someone the host cannot delete.
    ...(options.user === null ? [] : ["--user", options.user]),
    "--volume",
    `${REPO_ROOT}:/work`,
    "--volume",
    `${NODE_MODULES_VOLUME}:/work/node_modules`,
    "--volume",
    `${HOME_VOLUME}:/home/dev`,
    "--workdir",
    "/work",
    tag,
    "bash",
    "-c",
    BOOTSTRAP,
    // $0 for the bootstrap's `exec "$@"`; the command itself starts at $1.
    "container",
    ...command,
  ]
}

/** The host uid:gid, or null on a platform that has none (Windows). */
function hostUser(): string | null {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) return null
  return `${uid}:${gid}`
}

function ensureImage(tag: string, pin: string): number {
  if (imageExists(tag)) return 0
  console.error(`Building ${tag} (Bun ${pin})…`)
  return run("docker", buildArgs(tag, pin))
}

function main(): number {
  const argv = process.argv.slice(2)
  const [subcommand, ...rest] = argv
  // `bun run container:run -- bun test` may or may not forward the separator
  // depending on how it was invoked; either way it is not part of the command.
  const command = rest[0] === "--" ? rest.slice(1) : rest

  const pin = readPin()
  const tag = imageTag(pin)

  switch (subcommand) {
    case "build": {
      return run("docker", buildArgs(tag, pin))
    }
    case "run": {
      if (command.length === 0) {
        console.error("Usage: bun run container:run -- <command> [args…]")
        return 2
      }
      const built = ensureImage(tag, pin)
      if (built !== 0) return built
      return run(
        "docker",
        runArgs(tag, command, {
          tty: process.stdin.isTTY === true,
          user: hostUser(),
        }),
      )
    }
    case "shell": {
      const built = ensureImage(tag, pin)
      if (built !== 0) return built
      return run(
        "docker",
        runArgs(tag, ["bash"], { tty: true, user: hostUser() }),
      )
    }
    default: {
      console.error(
        [
          "Usage:",
          "  bun run container:build",
          "  bun run container:run -- <command> [args…]",
          "  bun run container:shell",
        ].join("\n"),
      )
      return 2
    }
  }
}

if (import.meta.main) {
  process.exit(main())
}
