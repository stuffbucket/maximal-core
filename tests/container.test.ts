import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  gitDirMount,
  imageTag,
  pruneEmptyNodeModules,
  readPin,
  runArgs,
  WORKDIR,
} from "../scripts/dev/container"

// Every case here is a FIXTURE tree, never the tree this suite is running in:
// the whole defect is that a linked worktree and a plain checkout produce
// different answers, and a test that read the ambient one would assert whichever
// the developer happened to be standing in.

const made: Array<string> = []

function tmpdir(): string {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "maximal-container-"),
  )
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/** A main checkout and a linked worktree of it, laid out the way git does. */
function worktreeFixture(options: { relative?: boolean } = {}): {
  main: string
  worktree: string
  commonGitDir: string
} {
  const root = tmpdir()
  const main = path.join(root, "repo")
  const commonGitDir = path.join(main, ".git")
  const perWorktree = path.join(commonGitDir, "worktrees", "agent-1")
  const worktree = path.join(main, ".claude", "worktrees", "agent-1")
  fs.mkdirSync(perWorktree, { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })
  fs.writeFileSync(path.join(perWorktree, "commondir"), "../..\n")
  const target =
    options.relative === true ?
      path.relative(worktree, perWorktree)
    : perWorktree
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${target}\n`)
  return { main, worktree, commonGitDir }
}

describe("gitDirMount", () => {
  it("mounts nothing for a plain checkout — its .git is a directory inside /work", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, ".git"))
    expect(gitDirMount(root)).toEqual({ mounts: [] })
  })

  it("mounts nothing, and does not object, outside a checkout entirely", () => {
    expect(gitDirMount(tmpdir())).toEqual({ mounts: [] })
  })

  // The bug: the absolute host path in the `.git` file does not exist inside
  // the container, so every `git` call exits 128 and `bindings:check` reports
  // "could not run". maximal-core#124.
  it("mounts a linked worktree's common git dir at the path its pointer names", () => {
    const { worktree, commonGitDir } = worktreeFixture()
    expect(gitDirMount(worktree)).toEqual({
      mounts: [{ hostPath: commonGitDir, containerPath: commonGitDir }],
    })
  })

  // One mount, not two: git's own layout puts the per-worktree dir inside the
  // common one, which is why mounting the common dir resolves both hops.
  it("the per-worktree dir the pointer names is inside the single mount", () => {
    const { worktree, commonGitDir } = worktreeFixture()
    const mount = gitDirMount(worktree).mounts[0]
    expect(
      path
        .join(commonGitDir, "worktrees", "agent-1")
        .startsWith(`${mount.containerPath}/`),
    ).toBe(true)
  })

  // `git worktree --relative-paths`. The pointer resolves against the directory
  // holding the `.git` file, which is the worktree root on the host and /work
  // in the container — so the two paths are genuinely different and the
  // container side is the one that has to be mounted at.
  it("resolves a relative pointer against /work for the container side", () => {
    const { worktree, commonGitDir } = worktreeFixture({ relative: true })
    const { mounts, objection } = gitDirMount(worktree)
    expect(objection).toBeUndefined()
    expect(mounts).toHaveLength(1)
    expect(mounts[0].hostPath).toBe(commonGitDir)
    // The fixture's pointer is `../../../.git/worktrees/agent-1`, which from
    // /work walks off the mount — so the container path is NOT the host one.
    expect(mounts[0].containerPath).toBe("/.git")
    expect(mounts[0].containerPath).not.toBe(mounts[0].hostPath)
  })

  // Docker would create a missing bind SOURCE as an empty root-owned directory,
  // which is the silent degradation this whole issue is about, one level down.
  it("objects when the pointer names something that is not there", () => {
    const root = tmpdir()
    fs.writeFileSync(
      path.join(root, ".git"),
      "gitdir: /nowhere/at/all/.git/worktrees/x\n",
    )
    expect(gitDirMount(root).objection).toContain("does not exist")
    expect(gitDirMount(root).mounts).toEqual([])
  })

  it("objects on a .git file that names no gitdir at all", () => {
    const root = tmpdir()
    fs.writeFileSync(
      path.join(root, ".git"),
      "this is not a worktree pointer\n",
    )
    expect(gitDirMount(root).objection).toContain("does not name a gitdir")
  })

  // A layout this does not understand is refused, not half-mounted: a partial
  // mount would leave git working for some commands and not others.
  it("objects when the per-worktree dir is not inside its own common dir", () => {
    const root = tmpdir()
    const gitDir = path.join(root, "elsewhere")
    const common = path.join(root, "common")
    fs.mkdirSync(gitDir, { recursive: true })
    fs.mkdirSync(common, { recursive: true })
    fs.writeFileSync(path.join(gitDir, "commondir"), `${common}\n`)
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir}\n`)
    expect(gitDirMount(root).objection).toContain("not inside its common dir")
    expect(gitDirMount(root).mounts).toEqual([])
  })
})

describe("runArgs", () => {
  const base = { tty: false, user: "501:20" } as const

  it("mounts the work tree, both volumes and nothing else without extra mounts", () => {
    const args = runArgs("img", ["bun", "test"], base)
    const volumes = args.filter((_, i) => args[i - 1] === "--volume")
    expect(volumes).toHaveLength(3)
    expect(volumes.some((v) => v.endsWith(`:${WORKDIR}`))).toBe(true)
  })

  it("adds one --volume per extra mount, source:destination", () => {
    const args = runArgs("img", ["bun", "test"], {
      ...base,
      mounts: [
        { hostPath: "/host/repo/.git", containerPath: "/host/repo/.git" },
      ],
    })
    const volumes = args.filter((_, i) => args[i - 1] === "--volume")
    expect(volumes).toContain("/host/repo/.git:/host/repo/.git")
    expect(volumes).toHaveLength(4)
  })

  // The bootstrap's `exec "$@"` needs a $0, and the command has to survive
  // whole — a mount inserted in the wrong place would silently eat an argument.
  it("still ends in the bootstrap, its $0 and the verbatim command", () => {
    const args = runArgs("img", ["bun", "run", "bindings:check"], {
      ...base,
      mounts: [{ hostPath: "/a", containerPath: "/b" }],
    })
    expect(args.slice(-4)).toEqual([
      "container",
      "bun",
      "run",
      "bindings:check",
    ])
  })
})

describe("pruneEmptyNodeModules", () => {
  // Docker creates the named volume's mount TARGET on the host, so a checkout
  // with no node_modules acquires an empty one the container never writes into
  // — and Bun then resolves upward past it, which is how a rebuild gets
  // `../../../node_modules/…` banners. maximal-core#124.
  it("removes an empty node_modules", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, "node_modules"))
    expect(pruneEmptyNodeModules(root)).toBe(true)
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false)
  })

  it("never touches an installed one", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true })
    expect(pruneEmptyNodeModules(root)).toBe(false)
    expect(fs.existsSync(path.join(root, "node_modules", ".bin"))).toBe(true)
  })

  // `readdirSync` follows a symlink and answers about its TARGET, so without an
  // lstat this would consult someone else's directory and then act on the link.
  it("leaves a symlinked node_modules alone, even one pointing at an empty dir", () => {
    const root = tmpdir()
    const target = path.join(root, "shared")
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(root, "node_modules"))
    expect(pruneEmptyNodeModules(root)).toBe(false)
    expect(fs.lstatSync(path.join(root, "node_modules")).isSymbolicLink()).toBe(
      true,
    )
    expect(fs.existsSync(target)).toBe(true)
  })

  // Not "this code declines to recurse" — `rmdir(2)` cannot remove a non-empty
  // directory at all, so a populated tree is unreachable from here.
  it("is a no-op on a directory holding only an empty subdirectory", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, "node_modules", "left-behind"), {
      recursive: true,
    })
    expect(pruneEmptyNodeModules(root)).toBe(false)
    expect(fs.existsSync(path.join(root, "node_modules", "left-behind"))).toBe(
      true,
    )
  })

  it("fails soft on a file, so cleanup can never turn a green run red", () => {
    const root = tmpdir()
    fs.writeFileSync(path.join(root, "node_modules"), "not a directory")
    expect(pruneEmptyNodeModules(root)).toBe(false)
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(true)
  })

  it("is a no-op when there is nothing there", () => {
    expect(pruneEmptyNodeModules(tmpdir())).toBe(false)
  })
})

describe("the tag is the pin", () => {
  it("names the version, so a bumped pin is not an addressable image", () => {
    expect(imageTag("1.2.3")).toBe("maximal-core-ci:bun-1.2.3")
    expect(imageTag(readPin())).toBe(`maximal-core-ci:bun-${readPin()}`)
  })
})
