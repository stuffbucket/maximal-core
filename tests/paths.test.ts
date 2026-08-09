/**
 * Unit coverage for the app-data root resolver. Drives the pure
 * `resolveAppDir({ platform, homedir, copilotApiHome, appData })` overload so
 * the tests assert the win32 / POSIX / override convention deterministically on
 * any host without mutating `process.platform` or `process.env`.
 *
 * The later describes cover the data-home policy: `resolveHomePolicy` (the
 * `create`/`require` knob, defaulting to `create`) and `requireExistingHome`,
 * the only part of this module that touches the filesystem and the one thing
 * `require` turns on.
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  HOME_POLICY_ENV,
  requireExistingHome,
  resolveAppDir,
  resolveHomePolicy,
} from "~/lib/platform/paths"

const HOME = path.join("/home", "alice")
const WIN_HOME = String.raw`C:\Users\alice`
const WIN_APPDATA = String.raw`C:\Users\alice\AppData\Roaming`

describe("resolveAppDir", () => {
  it("uses ~/.local/share/maximal on linux", () => {
    expect(resolveAppDir({ platform: "linux", homedir: HOME })).toBe(
      path.join(HOME, ".local", "share", "maximal"),
    )
  })

  it("uses ~/.local/share/maximal on macOS (darwin), unchanged", () => {
    expect(resolveAppDir({ platform: "darwin", homedir: HOME })).toBe(
      path.join(HOME, ".local", "share", "maximal"),
    )
  })

  it(String.raw`uses %APPDATA%\maximal on win32`, () => {
    expect(
      resolveAppDir({
        platform: "win32",
        homedir: WIN_HOME,
        appData: WIN_APPDATA,
      }),
    ).toBe(path.join(WIN_APPDATA, "maximal"))
  })

  it("falls back to <home>/AppData/Roaming/maximal on win32 with no APPDATA", () => {
    expect(resolveAppDir({ platform: "win32", homedir: WIN_HOME })).toBe(
      path.join(WIN_HOME, "AppData", "Roaming", "maximal"),
    )
  })

  it("treats a blank/whitespace APPDATA as unset on win32", () => {
    expect(
      resolveAppDir({ platform: "win32", homedir: WIN_HOME, appData: "  " }),
    ).toBe(path.join(WIN_HOME, "AppData", "Roaming", "maximal"))
  })

  it("COPILOT_API_HOME overrides on win32", () => {
    const override = String.raw`D:\custom\maximal-home`
    expect(
      resolveAppDir({
        platform: "win32",
        homedir: WIN_HOME,
        appData: WIN_APPDATA,
        copilotApiHome: override,
      }),
    ).toBe(override)
  })

  it("COPILOT_API_HOME overrides on POSIX", () => {
    const override = "/srv/maximal-home"
    expect(
      resolveAppDir({
        platform: "linux",
        homedir: HOME,
        copilotApiHome: override,
      }),
    ).toBe(override)
  })

  it("treats a blank/whitespace COPILOT_API_HOME as unset (falls through to default)", () => {
    // DELIBERATE, and load-bearing for the fail-loud override rule
    // (maximal-core#2): "set" means non-blank. `COPILOT_API_HOME: ""` is how a
    // spawner CLEARS an inherited value — tests/helpers/spawn-engine.ts and
    // tests/main-cli-global-options.test.ts both do it — so a blank value asks
    // for the default home. It must not be read as "an override that does not
    // exist" and turned into a boot failure.
    expect(
      resolveAppDir({ platform: "linux", homedir: HOME, copilotApiHome: "  " }),
    ).toBe(path.join(HOME, ".local", "share", "maximal"))
  })

  it("logs land under <root>/logs on win32 (single-root model)", () => {
    const root = resolveAppDir({
      platform: "win32",
      homedir: WIN_HOME,
      appData: WIN_APPDATA,
    })
    expect(path.join(root, "logs")).toBe(
      path.join(WIN_APPDATA, "maximal", "logs"),
    )
  })
})

/**
 * The knob that decides whether a missing data home is created or is an error
 * (maximal-core#2). The default has to stay `create` — that is the behaviour
 * maximal has always had, and it is the right one whenever the home is
 * maximal's own directory, which is the normal case.
 */
describe("resolveHomePolicy", () => {
  it("defaults to create when unset", () => {
    expect(resolveHomePolicy(undefined)).toBe("create")
  })

  it("treats a blank/whitespace value as unset", () => {
    // Same reasoning as a blank COPILOT_API_HOME: `""` is how a spawner clears
    // an inherited variable, so it must mean the default, not a failure.
    expect(resolveHomePolicy("")).toBe("create")
    expect(resolveHomePolicy("   ")).toBe("create")
  })

  it("reads both policies, case-insensitively and around whitespace", () => {
    expect(resolveHomePolicy("create")).toBe("create")
    expect(resolveHomePolicy("require")).toBe("require")
    expect(resolveHomePolicy(" REQUIRE ")).toBe("require")
  })

  it("throws on an unrecognised value rather than falling back to create", () => {
    // The whole point of `require` is that a mistake is not absorbed. A caller
    // who typed `required` and silently got the permissive default would have
    // lost the only guarantee they asked for.
    expect(() => resolveHomePolicy("required")).toThrow(/not a policy/u)
    expect(() => resolveHomePolicy("require")).not.toThrow()
  })

  it("names the offending value and both valid policies", () => {
    let message = ""
    try {
      resolveHomePolicy("yes-please")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("yes-please")
    expect(message).toContain("create")
    expect(message).toContain("require")
  })
})

/**
 * The fail-loud path, reached only under `COPILOT_API_HOME_POLICY=require`.
 * `resolveAppDir` stays pure; this is where a home is required to already exist
 * and is canonicalized. It is what an Electron host opts into so its sidecar
 * cannot adopt the user's own instance.
 */
describe("requireExistingHome", () => {
  it("throws for a home that does not exist, and creates nothing", () => {
    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "maximal-home-guard-")),
      "not-created",
    )
    expect(() => requireExistingHome(missing)).toThrow(/does not exist/u)
    expect(fs.existsSync(missing)).toBe(false)
  })

  it("names the offending value so the error is actionable", () => {
    const missing = path.join(os.tmpdir(), "maximal-home-guard-absent-xyz")
    fs.rmSync(missing, { recursive: true, force: true })
    // Substring, never a RegExp built from the path: a Windows path is full of
    // backslashes, and `new RegExp("C:\\Users\\…", "u")` throws
    // "invalid escaped character for Unicode pattern" before it can assert
    // anything. The message must also carry the path VERBATIM — no
    // JSON-escaping — so a reader can paste it into `mkdir`.
    let message = ""
    try {
      requireExistingHome(missing)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain(HOME_POLICY_ENV)
    expect(message).toContain(missing)
  })

  it("throws when the home is a file rather than a directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-home-guard-"))
    const file = path.join(dir, "not-a-dir")
    fs.writeFileSync(file, "")
    expect(() => requireExistingHome(file)).toThrow(/not a\s+directory/u)
  })

  it("returns the canonical path for a home that exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-home-guard-"))
    expect(requireExistingHome(dir)).toBe(fs.realpathSync(dir))
  })

  it("canonicalizes through a symlink, so two names give one home", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-home-guard-"))
    const real = path.join(dir, "real")
    const link = path.join(dir, "link")
    fs.mkdirSync(real)
    fs.symlinkSync(real, link, "junction")
    expect(requireExistingHome(link)).toBe(requireExistingHome(real))
  })

  it("throws when the home exists but cannot be written to", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-home-guard-"))
    const home = path.join(dir, "read-only")
    fs.mkdirSync(home)
    fs.chmodSync(home, 0o500)
    let writable = true
    try {
      fs.accessSync(home, fs.constants.W_OK)
    } catch {
      writable = false
    }
    // Same precondition discipline as tests/config-unwritable-boot.test.ts:
    // Windows has no POSIX mode bits, and root bypasses DAC. Assert what is
    // still observable rather than silently checking nothing.
    if (writable) {
      expect(fs.statSync(home).isDirectory()).toBe(true)
      return
    }
    expect(() => requireExistingHome(home)).toThrow(/cannot be written to/u)
    fs.chmodSync(home, 0o700)
  })
})
