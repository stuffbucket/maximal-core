/**
 * Detection coverage for `claude` CLI installs.
 *
 * Everything runs against tmp dirs with fake `claude` scripts, with
 * `homeDir` / `pathDirs` / `npmPrefix` injected so the assertions don't
 * depend on what's installed on the host. Where the host *might* also
 * have a real claude (e.g. `/opt/homebrew/bin/claude`), we filter the
 * results down to our tmp paths instead of asserting on total count.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  detectClaudeInstalls,
  readClaudeVersion,
  SHIM_MARKER,
} from "~/apps/claude-code/detect"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "apps-detect-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const IS_WINDOWS = process.platform === "win32"

function makeClaude(
  dir: string,
  opts: { version?: string; marker?: boolean } = {},
): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "claude")
  const lines = ["#!/bin/sh"]
  if (opts.marker) lines.push(SHIM_MARKER)
  lines.push(`echo "${opts.version ?? "1.2.3"} (Claude Code)"`)
  fs.writeFileSync(file, lines.join("\n") + "\n")
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * A fake `claude` the host can actually EXECUTE, for the cases that let
 * `readClaudeVersion` shell out instead of injecting `readVersion`.
 *
 * `makeClaude` above writes an extensionless `#!/bin/sh` script. Windows has
 * no shebang: an extensionless file is not executable there no matter what
 * `chmod` claims, so every exec-backed case degraded to `version: null`. The
 * portable fixture is the shape a real Windows install has — npm's global
 * `claude.cmd`, which is exactly what `claudeBasenames("win32")` exists to
 * find — so on win32 this writes a batch launcher and lets the win32 basename
 * set discover it. That makes these cases real Windows coverage of
 * `readClaudeVersion` rather than a POSIX rehearsal.
 */
function makeExecutableClaude(dir: string, version = "1.2.3"): string {
  if (!IS_WINDOWS) return makeClaude(dir, { version })
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "claude.cmd")
  // `echo` takes the rest of the line literally, so the "(Claude Code)" suffix
  // needs no quoting — and must NOT be quoted, or cmd echoes the quotes too.
  fs.writeFileSync(file, `@echo off\r\necho ${version} (Claude Code)\r\n`)
  return file
}

/** mkdir -p, returning the path so it can be realpath-resolved. */
function makeDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A Windows-style claude install with an explicit basename
 *  (`claude.exe` / `claude.cmd` / …). The body is still a POSIX shell
 *  script — these tests inject `readVersion`, so the body is never run. */
function makeWinClaude(
  dir: string,
  base: string,
  opts: { version?: string } = {},
): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, base)
  fs.writeFileSync(file, `#!/bin/sh\necho "${opts.version ?? "1.2.3"}"\n`)
  fs.chmodSync(file, 0o755)
  return file
}

describe("detectClaudeInstalls", () => {
  test("dedupes a single real binary reachable via multiple PATH dirs", () => {
    const realDir = path.join(root, "real")
    const realFile = makeClaude(realDir)
    const resolved = fs.realpathSync(realFile)

    const dir1 = path.join(root, "p1")
    const dir2 = path.join(root, "p2")
    fs.mkdirSync(dir1)
    fs.mkdirSync(dir2)
    fs.symlinkSync(realFile, path.join(dir1, "claude"))
    fs.symlinkSync(realFile, path.join(dir2, "claude"))

    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir1, dir2],
      npmPrefix: null,
    })
    const mine = installs.filter((i) => i.resolvedPath === resolved)
    expect(mine).toHaveLength(1)
  })

  test("parses --version output", () => {
    const dir = path.join(root, "bin")
    const file = makeExecutableClaude(dir, "9.8.7")
    const resolved = fs.realpathSync(file)

    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
    })
    const mine = installs.find((i) => i.resolvedPath === resolved)
    expect(mine?.version).toBe("9.8.7")
  })

  test("version is null when the binary can't be run", () => {
    const dir = path.join(root, "bin")
    const file = makeClaude(dir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
      readVersion: () => null,
    })
    expect(
      installs.find((i) => i.resolvedPath === resolved)?.version,
    ).toBeNull()
  })

  test("reports the stable symlink as `path`, not the resolved version (native installer shape)", () => {
    // Mirror the native installer: ~/.local/bin/claude is a symlink to a
    // versioned binary under ~/.local/share/claude/versions/. The shim
    // must exec the SYMLINK (which auto-update repoints), so `path` must
    // be the symlink and `resolvedPath` the version it currently points at.
    const home = path.join(root, "home")
    const versioned = makeClaude(
      path.join(home, ".local", "share", "claude", "versions"),
    )
    const binDir = path.join(home, ".local", "bin")
    fs.mkdirSync(binDir, { recursive: true })
    const symlink = path.join(binDir, "claude")
    fs.symlinkSync(versioned, symlink)

    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [binDir],
      npmPrefix: null,
    })
    const mine = installs.find(
      (i) => i.resolvedPath === fs.realpathSync(symlink),
    )
    expect(mine?.path).toBe(symlink) // stable handle, NOT the version
    expect(mine?.resolvedPath).not.toBe(symlink) // resolved to the version
  })

  test("excludes our own shim via the marker line", () => {
    const dir = path.join(root, "bin")
    const file = makeClaude(dir, { marker: true })
    const resolved = fs.realpathSync(file)

    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
    })
    expect(installs.some((i) => i.resolvedPath === resolved)).toBe(false)
  })

  // The 500 ms ceiling below measures detection ONLY, and stays 500 ms on
  // every platform — that is the invariant. The CASE-level budget has to cover
  // the setup as well, and laying down 64 MB on the Windows runner's disk has
  // been seen to eat most of Bun's 5 s default on its own, timing the case out
  // before the thing under test ever ran. 30 s raises the setup allowance
  // without loosening the assertion.
  test("does not read large candidate binaries in full (perf regression guard)", () => {
    // The real `claude` is a 200 MB+ binary. Detection must only read a
    // small prefix to check for the shim marker — reading the whole file
    // made the Apps toggle lag for seconds. Here a 64 MB fake binary
    // (marker absent) must still be detected as an install, fast, without
    // a full read. We assert correctness + a generous time ceiling.
    const dir = path.join(root, "bin")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "claude")
    // 64 MB of zero bytes — no marker, plenty big to expose a full read.
    fs.writeFileSync(file, Buffer.alloc(64 * 1024 * 1024))
    fs.chmodSync(file, 0o755)
    const resolved = fs.realpathSync(file)

    const start = performance.now()
    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
      readVersion: () => "1.0.0", // don't exec the fake binary
    })
    const elapsed = performance.now() - start

    // The fake binary is a real install (no marker → not skipped).
    expect(installs.some((i) => i.resolvedPath === resolved)).toBe(true)
    // A full 64 MB read would take ~200 ms+; a 4 KB prefix read is sub-ms.
    // 500 ms is a generous ceiling that still fails a whole-file read of a
    // 200 MB+ binary (the actual bug was multi-second).
    expect(elapsed).toBeLessThan(500)
  }, 30_000)

  test("returns only the active claude (first on PATH), ignoring others", () => {
    // A claude on PATH is the active one; copies in other known install
    // dirs are intentionally ignored. Active-first short-circuits to one.
    const home = path.join(root, "home")
    makeClaude(path.join(home, ".local", "bin")) // exists but not on PATH
    const pathDir = path.join(root, "somewhere")
    const pathFile = makeClaude(pathDir)

    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [pathDir],
      npmPrefix: null,
    })
    expect(installs).toHaveLength(1)
    expect(installs[0].resolvedPath).toBe(fs.realpathSync(pathFile))
    expect(installs[0].source).toBe("path")
  })

  test("falls back to known install dirs when nothing is active on PATH", () => {
    // No claude on PATH → probe known locations + npm-global so an
    // installed-but-not-active claude can still be surfaced.
    //
    // `platform` is pinned because the fixture below is the POSIX npm layout
    // (`<prefix>/bin`). Windows npm puts the launcher in the prefix itself, so
    // on an un-pinned win32 host the npm probe would look somewhere this test
    // never wrote. That divergence is not incidental to this case — it has its
    // own dedicated case in the "Windows (platform injected)" block.
    const home = path.join(root, "home")
    const localBin = makeClaude(path.join(home, ".local", "bin"))
    const claudeLocal = makeClaude(path.join(home, ".claude", "local"))
    const npmPrefix = path.join(root, "npm")
    const npmFile = makeClaude(path.join(npmPrefix, "bin"))

    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [], // nothing active
      npmPrefix,
      platform: "linux",
    })

    const byPath = new Map(
      installs.map((i) => [fs.realpathSync(i.path), i.source]),
    )
    expect(byPath.get(fs.realpathSync(localBin))).toBe("local-bin")
    expect(byPath.get(fs.realpathSync(claudeLocal))).toBe("claude-local")
    expect(byPath.get(fs.realpathSync(npmFile))).toBe("npm-global")
  })
})

describe("detectClaudeInstalls — source classification", () => {
  test('classifies a binary under `<home>/.claude/...` as "claude-local"', () => {
    // Discover via pathDirs (origin "path") so the ONLY thing that can
    // produce "claude-local" is the .claude prefix check — not the
    // pre-set origin of the fixed `~/.claude` probe. A non-canonical
    // subdir avoids any competing fixed-probe candidate.
    //
    // homeDir is passed UN-resolved (a /tmp path that the OS resolves to
    // /private/tmp on macOS): classifySource must realpath the prefix
    // before comparing, so this also guards that symlinked-home handling.
    const home = makeDir(path.join(root, "home"))
    const dir = path.join(home, ".claude", "viaPath")
    const file = makeClaude(dir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [dir],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
      "claude-local",
    )
  })

  test('classifies `<home>/.local/bin/...` as "local-bin"', () => {
    // Same technique: reach it via pathDirs so the .local/bin prefix
    // check is the only path to "local-bin".
    const home = makeDir(path.join(root, "home"))
    const dir = path.join(home, ".local", "bin", "viaPath")
    const file = makeClaude(dir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [dir],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
      "local-bin",
    )
  })

  test('does NOT treat `<home>/.local/<other>` as "local-bin"', () => {
    // Negative test: a binary directly under `~/.local` but NOT under
    // `~/.local/bin` must fall through to "path". This kills the
    // mutant that drops "bin" from the prefix join, which would
    // otherwise match everything under `~/.local`.
    const home = makeDir(path.join(root, "home"))
    const dir = path.join(home, ".local", "share", "viaPath")
    const file = makeClaude(dir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [dir],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
      "path",
    )
  })

  test('classifies a binary under the npm prefix `/bin` as "npm-global"', () => {
    // Reach it via pathDirs (origin "path") so the npmBin prefix check
    // does the classifying, NOT the origin shortcut of the fixed npm
    // probe. This separates the two branches that otherwise mask each
    // other.
    const home = path.join(root, "home")
    const npmPrefix = makeDir(path.join(root, "npm"))
    const dir = path.join(npmPrefix, "bin", "viaPath")
    const file = makeClaude(dir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [dir],
      npmPrefix,
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
      "npm-global",
    )
  })

  test("honours the npm/homebrew origin shortcut over a plain PATH dir", () => {
    // The fixed npm probe carries origin "npm-global"; classifySource's
    // origin shortcut returns that origin before the prefix heuristics.
    // Here the file sits at the CANONICAL npm probe path AND is NOT under
    // any homebrew prefix, so the only way it reads "npm-global" without
    // the npmBin prefix also matching is the origin shortcut.
    //
    // `platform` pinned: the canonical probe path is `<prefix>/bin` only on
    // POSIX (see the sibling case above).
    const home = path.join(root, "home")
    const npmPrefix = path.join(root, "npmroot")
    const file = makeClaude(path.join(npmPrefix, "bin"))
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [],
      npmPrefix,
      platform: "linux",
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
      "npm-global",
    )
  })

  test('classifies a binary on an ordinary PATH dir as "path"', () => {
    const home = path.join(root, "home")
    const pathDir = path.join(root, "elsewhere")
    const file = makeClaude(pathDir)
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [pathDir],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
      "path",
    )
  })

  test('classifies a binary resolving under /usr/local (or /opt/homebrew) as "homebrew"', () => {
    // The homebrew prefix heuristic keys off the real (symlink-resolved)
    // path starting with /usr/local/ or /opt/homebrew/. There is no
    // injection point for those prefixes, so we place a real fixture under
    // a uniquely-named subdir of /usr/local/bin and reach it via pathDirs
    // (origin "path", so classification falls through to the prefix check).
    let brewDir: string
    try {
      brewDir = fs.mkdtempSync(
        path.join("/usr/local/bin", "maximal-brew-test-"),
      )
    } catch {
      // Not writable on this host (e.g. CI without Homebrew) — skip.
      return
    }
    try {
      const file = makeClaude(brewDir)
      const resolved = fs.realpathSync(file)
      // Sanity: the resolved path must actually sit under the brew prefix
      // for this test to exercise the intended branch.
      expect(
        resolved.startsWith("/usr/local/")
          || resolved.startsWith("/opt/homebrew/"),
      ).toBe(true)

      const installs = detectClaudeInstalls({
        homeDir: path.join(root, "home"),
        pathDirs: [brewDir],
        npmPrefix: null,
      })
      expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
        "homebrew",
      )
    } finally {
      fs.rmSync(brewDir, { recursive: true, force: true })
    }
  })

  test("detection reports a multi-digit semver from --version output", () => {
    // Pins the /\d+\.\d+\.\d+/ extraction: dropping a `+` would turn
    // "10.20.30" into "0.20.30". A real fake executable is run here
    // (no readVersion injection) so the regex in readClaudeVersion is
    // exercised end-to-end.
    const dir = path.join(root, "bin")
    const file = makeExecutableClaude(dir, "10.20.30")
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.version).toBe(
      "10.20.30",
    )
  })
})

describe("detectClaudeInstalls — Windows (platform injected)", () => {
  // `platform: "win32"` is injected so these run on the POSIX CI host.
  // The fixtures are real files on the tmp fs (we can't fake `fs`), but the
  // basename set (`claude.exe` / `claude.cmd` / `claude`) and the npm-bin
  // layout (`%APPDATA%\npm` holds `claude.cmd` directly, no `bin/`) are the
  // Windows-specific behaviour under test. `makeWinClaude` (module scope)
  // creates the fixture with an explicit basename.
  test("finds an npm-global claude.cmd on PATH (no .exe extension)", () => {
    // The reported gap: an npm-global `claude.cmd` was invisible because the
    // PATH walk only joined `dir/claude`. With the win32 basename set it's
    // found and exec'd as the active install.
    const dir = path.join(root, "npmbin")
    const file = makeWinClaude(dir, "claude.cmd")
    const resolved = fs.realpathSync(file)

    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
      platform: "win32",
      readVersion: () => "1.2.3",
    })
    expect(installs).toHaveLength(1)
    expect(installs[0].resolvedPath).toBe(resolved)
    expect(installs[0].path).toBe(path.join(dir, "claude.cmd"))
  })

  test("prefers claude.exe over claude.cmd in the same dir", () => {
    const dir = path.join(root, "both")
    makeWinClaude(dir, "claude.cmd")
    const exe = makeWinClaude(dir, "claude.exe")
    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "home"),
      pathDirs: [dir],
      npmPrefix: null,
      platform: "win32",
      readVersion: () => "1.2.3",
    })
    expect(installs).toHaveLength(1)
    expect(installs[0].path).toBe(exe) // .exe wins
  })

  test("finds the native installer claude.exe under ~/.local/bin (Phase 2)", () => {
    const home = path.join(root, "winhome")
    const file = makeWinClaude(path.join(home, ".local", "bin"), "claude.exe")
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [], // nothing active on PATH
      npmPrefix: null,
      platform: "win32",
      readVersion: () => "1.2.3",
    })
    const mine = installs.find((i) => i.resolvedPath === resolved)
    expect(mine?.source).toBe("local-bin")
  })

  test("npm-global on Windows lives in the prefix itself, not <prefix>/bin", () => {
    // POSIX npm puts the launcher in `<prefix>/bin`; Windows npm drops
    // `claude.cmd` directly in `%APPDATA%\npm` (== the prefix). Phase-2
    // probing must look in the prefix dir, and classify it npm-global.
    const home = path.join(root, "winhome2")
    const npmPrefix = path.join(root, "AppData", "Roaming", "npm")
    const file = makeWinClaude(npmPrefix, "claude.cmd")
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [],
      npmPrefix,
      platform: "win32",
      readVersion: () => "1.2.3",
    })
    const mine = installs.find((i) => i.resolvedPath === resolved)
    expect(mine?.source).toBe("npm-global")
  })

  test('classifies a binary under ~/.claude as "claude-local" on Windows', () => {
    const home = makeDir(path.join(root, "winhome3"))
    const dir = path.join(home, ".claude", "local")
    const file = makeWinClaude(dir, "claude.exe")
    const resolved = fs.realpathSync(file)
    const installs = detectClaudeInstalls({
      homeDir: home,
      pathDirs: [dir],
      npmPrefix: null,
      platform: "win32",
      readVersion: () => "1.2.3",
    })
    expect(installs.find((i) => i.resolvedPath === resolved)?.source).toBe(
      "claude-local",
    )
  })

  test("does NOT probe POSIX Homebrew dirs on Windows", () => {
    // Nothing on PATH and no fixtures anywhere → empty. Guards against the
    // win32 fallback accidentally including /opt/homebrew or /usr/local
    // (which may even hold a real claude on the macOS CI host).
    const installs = detectClaudeInstalls({
      homeDir: path.join(root, "emptyhome"),
      pathDirs: [],
      npmPrefix: null,
      platform: "win32",
      readVersion: () => "1.2.3",
    })
    expect(installs).toHaveLength(0)
  })
})

describe("readClaudeVersion", () => {
  test("extracts a semver token from noisy output", () => {
    const dir = path.join(root, "bin")
    const file = makeExecutableClaude(dir, "1.0.44")
    expect(readClaudeVersion(file)).toBe("1.0.44")
  })

  test("extracts a multi-digit semver (each component can be >1 digit)", () => {
    // Dropping a `+` from /\d+\.\d+\.\d+/ would yield "0.20.30" here.
    const dir = path.join(root, "multidigit")
    const file = makeExecutableClaude(dir, "10.20.30")
    expect(readClaudeVersion(file)).toBe("10.20.30")
  })

  test("extracts the semver from leading tool-name + trailing build text", () => {
    // The fixture wraps the value as `<value> (Claude Code)`, so passing a
    // leading tool name yields `claude 7.8.9 (Claude Code)`. The semver
    // must be plucked from the middle, not the surrounding prose.
    const dir = path.join(root, "named")
    const file = makeExecutableClaude(dir, "claude 7.8.9")
    expect(readClaudeVersion(file)).toBe("7.8.9")
  })

  test("returns null for a non-existent binary", () => {
    expect(readClaudeVersion(path.join(root, "nope"))).toBeNull()
  })
})
