import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { startEngineExpectingExit } from "./helpers/spawn-engine"

interface DebugInfo {
  paths: {
    APP_DIR: string
    GITHUB_TOKEN_PATH: string
  }
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const tmpHome = path.join(os.tmpdir(), "maximal-test-foo")

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})
const decoder = new TextDecoder()
const baseEnv = {
  ...process.env,
  COPILOT_API_HOME: "",
  COPILOT_API_OAUTH_APP: "",
  COPILOT_API_ENTERPRISE_URL: "",
}

const runDebugJson = (...args: Array<string>): DebugInfo => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "./src/main.ts", ...args, "debug", "--json"],
    cwd,
    env: baseEnv,
  })
  const stdout = decoder.decode(result.stdout)
  const stderr = decoder.decode(result.stderr)

  if (result.exitCode !== 0) {
    throw new Error(
      `CLI command failed with exit code ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }

  return JSON.parse(stdout) as DebugInfo
}

/** Same spawn, but returning the outcome instead of throwing on a non-zero
 *  exit — these cases are about what the exit code and the pipes say. */
const runCli = (
  args: Array<string>,
  env: Record<string, string | undefined> = {},
): { exitCode: number | null; output: string } => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "./src/main.ts", ...args],
    cwd,
    env: { ...baseEnv, ...env },
  })
  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  }
}

describe("root-level global CLI options", () => {
  test("supports --api-home=value before the subcommand", () => {
    const info = runDebugJson(`--api-home=${tmpHome}`)

    expect(info.paths.APP_DIR).toBe(tmpHome)
    expect(info.paths.GITHUB_TOKEN_PATH).toBe(
      path.join(tmpHome, "github_token"),
    )
  })

  test("supports --oauth-app=value before the subcommand", () => {
    const info = runDebugJson("--oauth-app=opencode")

    expect(path.basename(path.dirname(info.paths.GITHUB_TOKEN_PATH))).toBe(
      "opencode",
    )
    expect(path.basename(info.paths.GITHUB_TOKEN_PATH)).toBe("github_token")
  })

  test("supports --enterprise-url=value before the subcommand", () => {
    const info = runDebugJson("--enterprise-url=ghe.example.com")

    expect(path.basename(info.paths.GITHUB_TOKEN_PATH)).toBe("ent_github_token")
  })

  test("supports combining root-level global CLI options", () => {
    const info = runDebugJson(
      `--api-home=${tmpHome}`,
      "--oauth-app=myapp",
      "--enterprise-url=ghe.example.com",
    )

    expect(info.paths.APP_DIR).toBe(tmpHome)
    expect(info.paths.GITHUB_TOKEN_PATH).toBe(
      path.join(tmpHome, "myapp", "ent_github_token"),
    )
  })
})

/**
 * maximal-core#2. The data home is normally maximal's own directory, so the
 * default policy is to look after it — a missing one is created, exactly as
 * before. `COPILOT_API_HOME_POLICY=require` is for the case where the home is
 * shared and the CALLER owns the decision: a host passes one so its sidecar
 * cannot adopt the user's own instance, and there a missing home is an error.
 *
 * Both halves are driven as real processes rather than unit-tested, because
 * what a host observes is an exit code, a message on the pipes, and whether a
 * directory appeared on disk.
 */
describe("the COPILOT_API_HOME_POLICY data-home policy", () => {
  const absent = path.join(os.tmpdir(), `maximal-absent-home-${process.pid}`)

  afterAll(() => {
    fs.rmSync(absent, { recursive: true, force: true })
  })

  test("default: a home that does not exist is CREATED, and boot succeeds", () => {
    fs.rmSync(absent, { recursive: true, force: true })

    // `setup` is the cheapest command that calls `ensurePaths` (src/setup.ts),
    // which is the thing that creates the home. No port, no ready-line.
    const result = runCli(["setup", "--unattended", "--skip-auth"], {
      COPILOT_API_HOME: absent,
    })

    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(absent)).toBe(true)
  })

  test("require: the same boot exits non-zero and creates nothing", () => {
    fs.rmSync(absent, { recursive: true, force: true })

    const result = runCli(["setup", "--unattended", "--skip-auth"], {
      COPILOT_API_HOME: absent,
      COPILOT_API_HOME_POLICY: "require",
    })

    expect(result.exitCode).not.toBe(0)
    expect(fs.existsSync(absent)).toBe(false)
  })

  test("require: `start` exits non-zero naming the directory and the policy", async () => {
    fs.rmSync(absent, { recursive: true, force: true })

    // Through the shared spawn helper, per tests/spawned-engine-ports.test.ts:
    // the ports are ephemeral even though this boot never gets far enough to
    // bind one. `startEngine` cannot express this — a boot that dies has no
    // ready-line, so it would only ever report a 30s timeout.
    const result = await startEngineExpectingExit({
      home: absent,
      env: { COPILOT_API_HOME_POLICY: "require" },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("COPILOT_API_HOME_POLICY")
    expect(result.output).toContain(absent)
    expect(fs.existsSync(absent)).toBe(false)
  })

  test("require: no silent fallback to the default home", () => {
    fs.rmSync(absent, { recursive: true, force: true })

    const result = runCli(["debug", "--json"], {
      COPILOT_API_HOME: absent,
      COPILOT_API_HOME_POLICY: "require",
    })

    expect(result.exitCode).not.toBe(0)
    expect(fs.existsSync(absent)).toBe(false)
    // The default home is what a silent fallback would have printed. `debug`
    // never got far enough to print any path at all.
    expect(result.output).not.toContain(".local/share/maximal")
  })

  test("an unrecognised policy is refused, not absorbed", () => {
    // `required` is the typo this guard exists for: absorbing it would hand the
    // caller the permissive default while they believed they had the strict one.
    const result = runCli(["debug", "--json"], {
      COPILOT_API_HOME: tmpHome,
      COPILOT_API_HOME_POLICY: "required",
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("not a policy")
  })

  test("a blank COPILOT_API_HOME still means the default home", () => {
    // The counterpart decision: "" is how a spawner clears an inherited value,
    // so it reads as unset — the lazily-created default, not a failure.
    const info = runDebugJson()

    expect(info.paths.APP_DIR).not.toBe("")
    expect(path.isAbsolute(info.paths.APP_DIR)).toBe(true)
  })
})
