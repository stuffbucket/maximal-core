import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  gitDirMount,
  imageTag,
  locate,
  nodeModulesNote,
  readPin,
  runArgs,
  WORKDIR,
} from "../scripts/dev/container"

// Every case here is a FIXTURE tree, never the tree this suite is running in:
// the whole defect is that a linked worktree and a plain checkout produce
// different answers, and a test that read the ambient one would assert whichever
// the developer happened to be standing in.

const made: Array<string> = []

// The container is Linux, so a mount DESTINATION is always a POSIX path. On
// Windows every fixture path is `C:\…`, which is not one — the code refuses
// there by design, and the cases below split on that rather than pretending
// either platform's answer is the other's.
const isWindows = process.platform === "win32"

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

describe("locate — the host/container path universes", () => {
  // These run on EVERY platform by injecting the host flavour, which is the
  // point: Windows is where conflating the two universes goes wrong, and it is
  // the platform least likely to be the one running the test. This is the third
  // Windows-only path-handling defect found in a day (see maximal-core#90), and
  // the first one whose semantics are pinned from a POSIX runner.

  it("a relative pointer is two different places, and says so", () => {
    const from = { host: "/repo/wt", container: WORKDIR }
    const located = locate("../../.git/worktrees/x", from, path.posix)
    expect(located.host).toBe("/.git/worktrees/x")
    expect(located.container).toBe("/.git/worktrees/x")
    expect(locate("worktrees/x", from, path.posix)).toEqual({
      host: "/repo/wt/worktrees/x",
      container: "/work/worktrees/x",
    })
  })

  it("a relative WINDOWS pointer keeps `\\` on the host and `/` in the container", () => {
    const located = locate(
      String.raw`..\..\.git\worktrees\x`,
      { host: String.raw`C:\repo\a\b`, container: WORKDIR },
      path.win32,
    )
    expect(located.objection).toBeUndefined()
    expect(located.host).toBe(String.raw`C:\repo\.git\worktrees\x`)
    expect(located.container).toBe("/.git/worktrees/x")
  })

  // The category error itself: `path.posix.resolve` on a `C:\…` string returns
  // something that is neither universe's path, and every later comparison then
  // fails for the wrong reason. There is no honest mount, so there is a refusal.
  it("an absolute WINDOWS pointer has no container equivalent, and is refused", () => {
    const located = locate(
      String.raw`C:\repo\.git\worktrees\x`,
      { host: String.raw`C:\repo\wt`, container: WORKDIR },
      path.win32,
    )
    expect(located.host).toBe(String.raw`C:\repo\.git\worktrees\x`)
    expect(located.container).toBe("")
    expect(located.objection).toContain("no container equivalent")
  })

  it("an absolute POSIX pointer is the same string in both", () => {
    const located = locate(
      "/repo/.git/worktrees/x",
      { host: "/repo/wt", container: WORKDIR },
      path.posix,
    )
    expect(located).toEqual({
      host: "/repo/.git/worktrees/x",
      container: "/repo/.git/worktrees/x",
    })
  })
})

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
  //
  // The two platforms have genuinely DIFFERENT correct answers here, so both
  // are pinned rather than either being skipped. A container path is always
  // POSIX because the container is Linux; git on Windows writes `C:\…` into the
  // pointer, and no mount destination can be that, so there the honest answer
  // is a refusal that says so.
  it("mounts a linked worktree's common git dir at the path its pointer names", () => {
    const { worktree, commonGitDir } = worktreeFixture()
    const result = gitDirMount(worktree)
    if (isWindows) {
      expect(result.mounts).toEqual([])
      expect(result.objection).toContain("no container equivalent")
      return
    }
    expect(result).toEqual({
      mounts: [{ hostPath: commonGitDir, containerPath: commonGitDir }],
    })
  })

  // One mount, not two: git's own layout puts the per-worktree dir inside the
  // common one, which is why mounting the common dir resolves both hops. Stated
  // on the HOST paths, so the assertion is the platform's own answer —
  // separator-correct everywhere, case-insensitive on Windows.
  it("the per-worktree dir the pointer names is inside the single mount", () => {
    const { worktree, commonGitDir } = worktreeFixture({ relative: true })
    const mount = gitDirMount(worktree).mounts[0]
    expect(mount.hostPath).toBe(commonGitDir)
    const rel = path.relative(
      mount.hostPath,
      path.join(commonGitDir, "worktrees", "agent-1"),
    )
    expect(rel.startsWith("..")).toBe(false)
    expect(path.isAbsolute(rel)).toBe(false)
  })

  // `git worktree --relative-paths`. The pointer resolves against the directory
  // holding the `.git` file, which is the worktree root on the host and /work
  // in the container — so the two answers are different places, and the
  // container one is what has to be mounted at. This case is identical on both
  // platforms precisely because the container side is derived from `/work`
  // rather than carried over from the host.
  it("resolves a relative pointer against /work for the container side", () => {
    const { worktree, commonGitDir } = worktreeFixture({ relative: true })
    const { mounts, objection } = gitDirMount(worktree)
    expect(objection).toBeUndefined()
    expect(mounts).toHaveLength(1)
    expect(mounts[0].hostPath).toBe(commonGitDir)
    // The fixture's pointer walks three levels up from the worktree root, which
    // from /work leaves the mount — so the container path is NOT the host one.
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
  // mount would leave git working for some commands and not others. Built from
  // RELATIVE pointers so it reaches the containment check itself on both
  // platforms, rather than tripping an earlier guard on one of them.
  it("objects when the per-worktree dir is not inside its own common dir", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, "elsewhere"), { recursive: true })
    fs.mkdirSync(path.join(root, "common"), { recursive: true })
    fs.writeFileSync(path.join(root, "elsewhere", "commondir"), "../common\n")
    fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n")
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

describe("nodeModulesNote", () => {
  // Docker creates the named volume's mount TARGET on the host, so a checkout
  // with no node_modules acquires an empty one the container never writes into
  // — and Bun then resolves upward past it, which is how a HOST rebuild gets
  // `../../../node_modules/…` banners. maximal-core#124.
  //
  // It is REPORTED, not removed. Removing it was measured to break the very
  // next container run (see the note's own comment), which is a worse failure
  // than the residue — so nothing here deletes anything, and these cases pin
  // that the note fires on exactly the state that warrants it.
  it("names the empty directory and the one command that fixes it", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, "node_modules"))
    const note = nodeModulesNote(root)
    expect(note).toContain(path.join(root, "node_modules"))
    expect(note).toContain("bun install")
    // Still there — this is a note, not a cleanup.
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(true)
  })

  it("says nothing about an installed one", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true })
    expect(nodeModulesNote(root)).toBeUndefined()
  })

  // `readdirSync` follows a symlink and answers about its TARGET, so without an
  // lstat a symlinked node_modules pointing at an empty dir would be reported
  // as this run's residue when it is nothing of the kind.
  it("says nothing about a symlinked node_modules, even one pointing at an empty dir", () => {
    const root = tmpdir()
    const target = path.join(root, "shared")
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(root, "node_modules"))
    expect(nodeModulesNote(root)).toBeUndefined()
  })

  it("says nothing about a directory that has anything at all in it", () => {
    const root = tmpdir()
    fs.mkdirSync(path.join(root, "node_modules", "something"), {
      recursive: true,
    })
    expect(nodeModulesNote(root)).toBeUndefined()
  })

  it("fails soft on a file, so it can never turn a green run red", () => {
    const root = tmpdir()
    fs.writeFileSync(path.join(root, "node_modules"), "not a directory")
    expect(nodeModulesNote(root)).toBeUndefined()
  })

  it("says nothing when there is nothing there", () => {
    expect(nodeModulesNote(tmpdir())).toBeUndefined()
  })
})

describe("the tag is the pin", () => {
  it("names the version, so a bumped pin is not an addressable image", () => {
    expect(imageTag("1.2.3")).toBe("maximal-core-ci:bun-1.2.3")
    expect(imageTag(readPin())).toBe(`maximal-core-ci:bun-${readPin()}`)
  })
})
