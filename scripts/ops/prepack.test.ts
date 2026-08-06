import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CHECK_FLAG,
  type CommandRunner,
  LIB_BUILD_ARGV,
  main,
  mainBuildArgv,
  OUT_DIR,
  pinObjection,
  prepack,
  realRunner,
} from "./prepack"

// Offline and deterministic: the runner is injected, so nothing here invokes a
// bundler or writes to dist/. The parity guards are the deliberate exception —
// they read the real package.json, which is the point of them.
//
// Nothing here may assert on the AMBIENT environment (no node_modules, no
// particular Bun): release-gates.yml runs `check:ops` with no `bun install`.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")

const PINNED = "1.3.11"

interface Invocation {
  command: string
  args: Array<string>
}

/** A runner that records every spawn and reports the given exit statuses. */
function recorder(statuses: Array<number> = []): {
  calls: Array<Invocation>
  run: CommandRunner
} {
  const calls: Array<Invocation> = []
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args: [...args] })
    return { status: statuses[calls.length - 1] ?? 0, output: "" }
  }
  return { calls, run }
}

function silent(): { lines: Array<string>; log: (line: string) => void } {
  const lines: Array<string> = []
  return { lines, log: (line) => lines.push(line) }
}

function readScripts(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
  return pkg.scripts
}

describe("parity with the real package.json", () => {
  // The whole guard is worthless if `prepack` stops routing through it: Bun
  // fires `prepack` on `bun publish` AND `bun pm pack`, so this is the only
  // hook that sees every path to a tarball.
  test("`prepack` is this script, not a bare `bun run build`", () => {
    expect(readScripts().prepack).toBe("bun scripts/ops/prepack.ts")
  })

  // `bumpp` commits, tags and pushes before `bun publish` is reached, so the
  // assertion has to run ahead of it or the cheap failure becomes a public tag
  // with nothing published behind it. That ordering used to be a `&&` chain and
  // is now `scripts/ops/release.ts`, which additionally has to guard the tree
  // BEFORE `bumpp` and rebuild `dist/` INSIDE it — an order no chain can state.
  // The ordering itself is asserted in `release.test.ts`; this only pins that
  // both release phases still go through the file that owns it.
  test("both release phases route through the wrapper that owns the ordering", () => {
    expect(readScripts()["release:prepare"]).toBe("bun scripts/ops/release.ts prepare")
    expect(readScripts()["release:tag"]).toBe("bun scripts/ops/release.ts tag")
  })

  test("`release:preflight` asserts without building", () => {
    expect(readScripts()["release:preflight"]).toBe(`bun scripts/ops/prepack.ts ${CHECK_FLAG}`)
  })

  // The published build must be THE build. If `build` grows a flag and this
  // does not, the tarball ships a bundle no other gate has ever looked at.
  test("the bundle build is argv-identical to `bun run build`", () => {
    expect(readScripts().build).toBe(`bun ${mainBuildArgv().join(" ")}`)
  })

  test("the outDir is the `dist` that `files` ships", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      files: Array<string>
    }
    expect(pkg.files).toContain(OUT_DIR)
  })

  // Bun runs lifecycle scripts with neither node_modules/.bin nor its own
  // bindir on PATH, so `tsup` and `bunx` are both unresolvable there. `bun x`
  // off the interpreter we already hold is the only form that works.
  test("the lib build resolves tsup through the interpreter, not PATH", () => {
    expect(LIB_BUILD_ARGV).toEqual(["x", "tsup"])
  })

  // Same PATH limitation, same failure: a bare `simple-git-hooks` in `prepare`
  // exits 127 under the pack lifecycle and aborts the publish AFTER prepack has
  // already rewritten dist/. So the invocation must go through `bun x`.
  //
  // Not an equality assertion any more, because `prepare` also has to VERIFY
  // its own result: `simple-git-hooks` catches every install error and exits 0
  // (its cli.js `.catch(e => console.log(...))`), so a failed hook install
  // reads as success and the pre-commit lint + secret scan silently stop
  // existing. `prepare` therefore ends by checking the hook file is actually
  // there, at `git rev-parse --git-path hooks` — which resolves through the
  // common dir, so a linked worktree (where simple-git-hooks always fails,
  // upstream bug: it joins `.git/hooks` onto cwd rather than the resolved git
  // dir) still passes off the main checkout's hook.
  //
  // The body now lives in `scripts/ops/prepare.ts` rather than an inline shell
  // string. The inline version used `> /dev/null 2>&1` and `$(…)`, which Bun's
  // built-in shell rejects on Windows (`expected a command or assignment but
  // got: "Redirect"`), failing `bun install` outright there. Nothing caught it:
  // ci.yml is Linux-only and the sole Windows leg runs on a tag push, so it
  // surfaced only after v0.4.2 was tagged, leaving that release asset-less.
  test("`prepare` resolves its binary through the interpreter too", () => {
    const prepare = readScripts().prepare
    expect(prepare).toBe("bun scripts/ops/prepare.ts")
    // No bare invocation anywhere in the chain — neither in the script entry
    // nor in the file it delegates to.
    expect(prepare).not.toMatch(/(?:^|[;&|]\s*)simple-git-hooks/)
    const body = fs.readFileSync(path.join(import.meta.dir, "prepare.ts"), "utf8")
    expect(body).toContain('process.execPath, ["x", "simple-git-hooks"]')
    expect(body).not.toMatch(/spawnSync\(\s*"(?:bun|simple-git-hooks)"/)
  })

  // The other half of the same fix: `prepare` must not exit 0 when the hook
  // was not installed. Guarded so it is a no-op outside a git repo, which is
  // how a git-dependency or tarball install sees it.
  test("`prepare` verifies the hook landed, and no-ops outside a git repo", () => {
    const body = fs.readFileSync(path.join(import.meta.dir, "prepare.ts"), "utf8")
    expect(body).toContain("rev-parse")
    expect(body).toContain("--git-path")
    expect(body).toContain("pre-commit")
    // The no-op-outside-a-repo path and the it-lied path are distinct exits.
    expect(body).toContain("process.exit(0)")
    expect(body).toContain("process.exit(1)")
  })

  // `engines.node` is a DECLARATION, not a gate: `bun install` ignores it
  // entirely (verified — a package declaring `node: ">=99"` installs clean), so
  // the only thing that ever enforces it is a consumer's npm/pnpm. That makes it
  // exactly the kind of field that goes stale unnoticed.
  //
  // It went stale: it read `>=22` while `src/lib/platform/sqlite.ts` refuses to
  // open a database below `MINIMUM_NODE_SQLITE_VERSION` (22.13.0) and throws
  // `UnsupportedNodeSqliteRuntimeError`. Node 22.0-22.12 satisfied the declared
  // range and then died at runtime on the first token-usage write.
  //
  // Read as text rather than imported: this suite runs under `check:ops` with no
  // `bun install`, and pulling in a `~/`-aliased src module would drag the
  // engine's import graph into an offline tooling test.
  test("`engines.node` is the floor src/lib/platform/sqlite.ts actually enforces", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      engines: { node: string }
    }
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src", "lib", "platform", "sqlite.ts"),
      "utf8",
    )
    const declared = /MINIMUM_NODE_SQLITE_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1]
    expect(declared).toBeDefined()
    expect(pkg.engines.node).toBe(`>=${declared}`)
  })
})

describe("pinObjection", () => {
  test("the pinned Bun may publish", () => {
    expect(pinObjection(PINNED, PINNED)).toBeUndefined()
  })

  test("an off-pin Bun is refused, naming both versions and the fix", () => {
    const objection = pinObjection("1.3.14", PINNED)
    expect(objection).toBeDefined()
    expect(objection).toContain("1.3.14")
    expect(objection).toContain(PINNED)
    expect(objection).toContain(".bun-version")
    expect(objection).toContain(`bash -s bun-v${PINNED}`)
  })

  test("not running under Bun at all is refused, not crashed on", () => {
    const objection = pinObjection(undefined, PINNED)
    expect(objection).toBeDefined()
    expect(objection).toContain("not running under Bun")
  })
})

describe("prepack", () => {
  test("the pinned Bun builds the bundle then the bindings", () => {
    const { calls, run } = recorder()
    const { log } = silent()
    expect(prepack({ bun: "/pin/bun", running: PINNED, pinned: PINNED, run, log })).toBe(0)
    expect(calls).toEqual([
      { command: "/pin/bun", args: mainBuildArgv() },
      { command: "/pin/bun", args: [...LIB_BUILD_ARGV] },
    ])
  })

  // The load-bearing one. A refusal that had already rewritten dist/ would
  // leave the releaser's working tree carrying the very bytes it just refused
  // to publish — and dist/main.js is committed, so those bytes are a `git add`
  // away from becoming the artifact `bindings:check` guards.
  test("an off-pin Bun is refused with nothing built", () => {
    const { calls, run } = recorder()
    const { lines, log } = silent()
    expect(prepack({ bun: "/other/bun", running: "1.3.14", pinned: PINNED, run, log })).toBe(1)
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain("REFUSING")
  })

  test("--check asserts the pin and builds nothing", () => {
    const { calls, run } = recorder()
    const { log } = silent()
    expect(
      prepack({ checkOnly: true, bun: "/pin/bun", running: PINNED, pinned: PINNED, run, log }),
    ).toBe(0)
    expect(calls).toEqual([])
  })

  test("--check refuses an off-pin Bun, which is the point of running it early", () => {
    const { run } = recorder()
    const { log } = silent()
    expect(
      prepack({ checkOnly: true, bun: "/other/bun", running: "1.3.14", pinned: PINNED, run, log }),
    ).toBe(1)
  })

  // Bundling with a binary other than the one that was version-checked is the
  // exact trap `bun run build` falls into (see the header): the pinned Bun's
  // own `pm pack` still produced an unpinned bundle, because the inner `bun`
  // re-resolved from PATH.
  test("the bundler defaults to this process, never a PATH lookup", () => {
    const { calls, run } = recorder()
    const { log } = silent()
    expect(prepack({ running: PINNED, pinned: PINNED, run, log })).toBe(0)
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[0]?.command).not.toBe("bun")
  })

  test("a failed bundle build stops before the bindings build, and is not a refusal", () => {
    const { calls, run } = recorder([3])
    const { log } = silent()
    expect(prepack({ bun: "/pin/bun", running: PINNED, pinned: PINNED, run, log })).toBe(2)
    expect(calls).toHaveLength(1)
  })

  test("a failed bindings build is fatal too", () => {
    const { calls, run } = recorder([0, 1])
    const { log } = silent()
    expect(prepack({ bun: "/pin/bun", running: PINNED, pinned: PINNED, run, log })).toBe(2)
    expect(calls).toHaveLength(2)
  })

  test("an unreadable pin is a cannot-run, never a silent pass", () => {
    const { calls, run } = recorder()
    const { lines, log } = silent()
    // A real directory with no .bun-version in it, so the real read throws.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-prepack-"))
    try {
      expect(prepack({ bun: "/pin/bun", running: PINNED, root, run, log })).toBe(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
    expect(calls).toEqual([])
    expect(lines.join("\n")).toContain(".bun-version")
  })

  test("the pin is read from .bun-version when it is not injected", () => {
    const { calls, run } = recorder()
    const { log } = silent()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-prepack-"))
    try {
      fs.writeFileSync(path.join(root, ".bun-version"), `${PINNED}\n`)
      expect(prepack({ bun: "/pin/bun", running: PINNED, root, run, log })).toBe(0)
      expect(prepack({ bun: "/pin/bun", running: "9.9.9", root, run, log })).toBe(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
    expect(calls).toHaveLength(2)
  })

  test("the outDir is overridable, and reaches the bundle build", () => {
    const { calls, run } = recorder()
    const { log } = silent()
    prepack({ bun: "/pin/bun", running: PINNED, pinned: PINNED, run, log, outDir: "/tmp/x" })
    expect(calls[0]?.args).toEqual(mainBuildArgv("/tmp/x"))
  })
})

describe("main", () => {
  const injected = (argv: Array<string>): Array<Invocation> => {
    const { calls, run } = recorder()
    const { log } = silent()
    main(argv, { bun: "/pin/bun", running: PINNED, pinned: PINNED, run, log })
    return calls
  }

  test(`${CHECK_FLAG} selects the preflight, which builds nothing`, () => {
    expect(injected([CHECK_FLAG])).toEqual([])
  })

  // The default must be the BUILD. A prepack that quietly degraded to an
  // assertion would leave `bun publish` shipping whatever stale dist/ happened
  // to be on disk, which is a worse failure than the one this file exists for.
  test("no flag runs the real build", () => {
    expect(injected([])).toHaveLength(2)
  })

  test("an unrelated flag does not select the preflight", () => {
    expect(injected(["--verbose"])).toHaveLength(2)
  })
})

describe("realRunner", () => {
  // The one test in this suite that spawns anything, and it earns it. Bun's
  // `spawnSync` defaults the child's environment to the snapshot the process
  // STARTED with, so a variable set at runtime never reaches the child unless
  // `env` is passed explicitly. `release.ts` hands the rendered CHANGELOG block
  // to `bumpp`'s execute hook that way, and without the explicit `env` the
  // release is green with no changelog entry in the commit — the quietest
  // failure this repo could ship. No network, no node_modules, no dist/: the
  // child is the interpreter already running these tests.
  test("a variable set at runtime reaches the child process", () => {
    const key = "MAXIMAL_PREPACK_ENV_PROBE"
    const previous = process.env[key]
    const out = path.join(os.tmpdir(), `prepack-env-probe-${String(process.pid)}`)
    process.env[key] = "set-after-startup"
    try {
      const result = realRunner(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(out)}, String(process.env[${JSON.stringify(key)}]))`,
      ])
      expect(result.status).toBe(0)
      expect(fs.readFileSync(out, "utf8")).toBe("set-after-startup")
    } finally {
      fs.rmSync(out, { force: true })
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })
})
