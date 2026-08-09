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
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync } from "node:fs"
import { isAbsolute, posix, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../..")
const DOCKERFILE_DIR = resolve(REPO_ROOT, ".github/docker")

/** Where the work tree is mounted. Hard-coded in the image's `WORKDIR` too. */
export const WORKDIR = "/work"

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

// --- the linked-worktree git dir ---

/** One `--volume host:container` pair. */
export interface Mount {
  readonly hostPath: string
  readonly containerPath: string
}

export interface GitDirMount {
  /** Empty for a plain checkout, whose `.git` rides in on the work tree mount. */
  readonly mounts: ReadonlyArray<Mount>
  /** Why this tree's git dir cannot be mounted. Refuse rather than degrade. */
  readonly objection?: string
}

/**
 * A LINKED WORKTREE'S `.git` IS A FILE, AND WHAT IT POINTS AT IS OUTSIDE /work.
 *
 *     gitdir: /Users/you/repo/.git/worktrees/<name>
 *
 * That is an absolute HOST path into the main checkout. Bind-mounting only the
 * worktree at `/work` leaves it absent inside the container, so every `git` call
 * exits 128 — and the two things that read it both degrade quietly rather than
 * going red: `bindings:check` reports "could not run" (the committed-`dist`
 * freshness gate, silently off) and `getGitVersion` returns undefined (one unit
 * test, a false negative). See maximal-core#124.
 *
 * `git config --system --add safe.directory '*'` in the Dockerfile is a
 * DIFFERENT problem — that one is about a git dir git distrusts. This one is
 * genuinely not there.
 *
 * MOUNTED AT ITS OWN ABSOLUTE PATH, not somewhere tidier with `GIT_DIR` set to
 * point at it. `src/lib/update/version.ts` reads `.git` and follows the pointer
 * with `fs`, never through the git binary, so it honours no environment
 * variable — the only mount that fixes both readers is the one that makes the
 * path the pointer already names resolve. It also means nothing has to rewrite
 * a file in the developer's work tree.
 *
 * One mount covers both directories git needs, because git's own layout puts
 * the per-worktree dir at `<common>/worktrees/<id>`. That is asserted rather
 * than assumed: a layout this does not cover is refused, not half-mounted.
 */
export function gitDirMount(root: string = REPO_ROOT): GitDirMount {
  let pointer: string
  try {
    pointer = readFileSync(resolve(root, ".git"), "utf8")
  } catch {
    // EISDIR — a plain checkout, already inside the work tree mount. ENOENT —
    // not a checkout at all, which is not this script's business to diagnose.
    return { mounts: [] }
  }
  const match = /^gitdir: (\S.*)$/mu.exec(pointer)
  if (match === undefined || match === null) {
    return { mounts: [], objection: `${resolve(root, ".git")} is a file but does not name a gitdir.` }
  }
  const target = match[1].trim()
  // A relative pointer (`git worktree --relative-paths`) resolves against the
  // directory holding the `.git` file — which is `root` on the host and
  // `/work` in the container, so the two answers differ and both are needed.
  const hostGitDir = isAbsolute(target) ? target : resolve(root, target)
  const containerGitDir = isAbsolute(target) ? target : posix.resolve(WORKDIR, target)

  let hostCommon = hostGitDir
  let containerCommon = containerGitDir
  try {
    const rel = readFileSync(resolve(hostGitDir, "commondir"), "utf8").trim()
    hostCommon = isAbsolute(rel) ? rel : resolve(hostGitDir, rel)
    containerCommon = isAbsolute(rel) ? rel : posix.resolve(containerGitDir, rel)
  } catch {
    // No `commondir` — the pointer names a main git directory directly.
  }

  if (!existsSync(hostCommon)) {
    return { mounts: [], objection: `${resolve(root, ".git")} points at ${hostCommon}, which does not exist.` }
  }
  // Docker would happily create a missing bind source as an empty root-owned
  // directory, so an unusable path must be refused here rather than mounted.
  if (!containerCommon.startsWith("/") || containerCommon === "/") {
    return {
      mounts: [],
      objection:
        `${resolve(root, ".git")} points at ${target}, which is not a path this container can mount.`,
    }
  }
  if (containerGitDir !== containerCommon && !containerGitDir.startsWith(`${containerCommon}/`)) {
    return {
      mounts: [],
      objection:
        `${resolve(root, ".git")} points at ${containerGitDir}, which is not inside its common dir `
        + `${containerCommon}; this script only knows how to mount git's own worktree layout.`,
    }
  }
  return { mounts: [{ hostPath: hostCommon, containerPath: containerCommon }] }
}

/** Where docker creates the named volume's mount target, on the HOST. */
export function nodeModulesPath(root: string = REPO_ROOT): string {
  return resolve(root, "node_modules")
}

/**
 * `/work/node_modules` is a named volume mounted over a path INSIDE the
 * bind-mounted work tree, and docker creates a mount target that does not
 * exist — on the host, because that is where the bind source lives. So a
 * checkout with no `node_modules` acquires an empty one that the container
 * never writes into, and the host is left worse off than before the run: `bun
 * build` resolves upward to a sibling checkout's `node_modules` and writes its
 * module banner comments relative to THAT root, producing byte-different output
 * for byte-identical sources (measured: 21 banner lines). That is reported as
 * staleness, and following the fix command it prints commits the wrong bytes.
 *
 * This is the ONE destructive thing this script does to a work tree, so every
 * way it could reach something a developer cares about is closed:
 *
 *   - `lstatSync().isDirectory()` — a symlinked `node_modules` is left alone.
 *     `readdirSync` would follow the link and answer about its TARGET, and
 *     `rmdirSync` would then act on the link; neither is what anyone meant.
 *   - `rmdirSync`, never `rm -r`. It is not merely that this code declines to
 *     recurse: `rmdir(2)` FAILS with ENOTEMPTY on a directory with anything in
 *     it, so a populated tree is unreachable from here at the syscall level,
 *     not merely by convention. The `readdirSync` guard means one is not even
 *     attempted.
 *   - Every failure is swallowed and reported as `false`. The caller ignores
 *     the answer, so a run's exit status is the container's and nothing else —
 *     cleanup cannot turn a green run red.
 *   - The caller only asks when `node_modules` did NOT exist before the run,
 *     so this can only ever remove a directory THIS run caused to appear.
 *
 * The one window that cannot be closed is a `bun install` started in this same
 * tree while the container was running: it creates `node_modules` and this
 * could remove it between its `mkdir` and its first write. That is acceptable
 * because the loser is a command the developer is watching, whose failure is an
 * ENOENT they can simply re-run — as against the silent, committable wrong
 * bytes it exists to prevent. `rmdirSync` is atomic and empties-only, so even
 * in that race a populated `node_modules` is never at risk.
 *
 * The container itself needs no guard for this: inside it `node_modules` is the
 * named volume, which the bootstrap `bun install`s when it is empty.
 */
export function pruneEmptyNodeModules(root: string = REPO_ROOT): boolean {
  const dir = nodeModulesPath(root)
  try {
    if (!lstatSync(dir).isDirectory()) return false
    if (readdirSync(dir).length > 0) return false
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
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
  options: {
    readonly tty: boolean
    readonly user: string | null
    readonly mounts?: ReadonlyArray<Mount>
  },
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
    `${REPO_ROOT}:${WORKDIR}`,
    "--volume",
    `${NODE_MODULES_VOLUME}:${WORKDIR}/node_modules`,
    "--volume",
    `${HOME_VOLUME}:/home/dev`,
    // Empty unless this is a linked worktree — see `gitDirMount`.
    ...(options.mounts ?? []).flatMap((m) => ["--volume", `${m.hostPath}:${m.containerPath}`]),
    "--workdir",
    WORKDIR,
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

/**
 * One container run, plus the two things a linked worktree needs around it: the
 * git dir mounted in (refusing loudly if it cannot be), and the empty
 * `node_modules` docker leaves behind taken back out.
 */
function runInContainer(tag: string, command: ReadonlyArray<string>, tty: boolean): number {
  const git = gitDirMount()
  if (git.objection !== undefined) {
    console.error(
      `container: REFUSING to run — git would not work inside the container.\n\n  ${git.objection}\n\n`
        + "Every `git` call would exit 128, which `bindings:check` reports as \"could not run\"\n"
        + "rather than as a failure. Run from the main checkout instead.\n",
    )
    return 1
  }
  // Only a `node_modules` that was NOT there beforehand can be this run's
  // residue, so that is the only one the prune is ever offered. Sampled before
  // the run for the same reason the prune is empties-only: a directory the
  // developer already had is never a candidate, whatever is or is not in it.
  const hadNodeModules = existsSync(nodeModulesPath())
  const status = run(
    "docker",
    runArgs(tag, command, { tty, user: hostUser(), mounts: git.mounts }),
  )
  if (!hadNodeModules) pruneEmptyNodeModules()
  return status
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
      return runInContainer(tag, command, process.stdin.isTTY === true)
    }
    case "shell": {
      const built = ensureImage(tag, pin)
      if (built !== 0) return built
      return runInContainer(tag, ["bash"], true)
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
