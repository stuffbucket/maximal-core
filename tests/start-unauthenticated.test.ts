/**
 * Boot-time behavior when no GitHub token exists on disk.
 *
 * Regression guard for the "dozens of browser tabs" bug: when the Tauri
 * shell spawned the sidecar with no token cached, the proxy used to fire
 * the GitHub device-code flow (opening a browser) *before* binding its
 * port, so the dashboard couldn't load to let the user recover. The fix:
 * boot the server unconditionally, leave `state.githubToken` undefined
 * when absent, and gate `/v1/*` and friends with `requireGithubAuth`.
 *
 * This test starts the real `start` subprocess against a fresh
 * `COPILOT_API_HOME` (so no token record exists) and asserts:
 *   1. The engine binds and announces its ports (no auth blocking startup).
 *   2. `/_debug/state` reports `github_token_present: false`.
 *   3. Upstream-touching routes 401 with `{ error: "not_authenticated" }`.
 *
 * Ports are ephemeral and read back off the ready-line — see
 * `tests/helpers/spawn-engine.ts` for why guessing one was the flake.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Engine } from "./helpers/spawn-engine"

import { startEngine } from "./helpers/spawn-engine"

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-unauth-"))

let engine: Engine

beforeAll(async () => {
  engine = await startEngine({
    home: tmpHome,
    // /_debug lives on the private control listener (maximal-core#10) and is
    // 404 unless verbose.
    args: ["--verbose"],
  })
})

afterAll(async () => {
  await engine.stop()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("start in unauthenticated mode", () => {
  test("HTTP server is listening", async () => {
    const res = await fetch(`${engine.proxyUrl}/`)
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("Server running")
  })

  test("GET /status returns the maximal identity marker, no auth needed", async () => {
    // The Claude Code shim probes this to confirm the port is really Maximal
    // (vs some other process that grabbed it). Must work with no API key and
    // even with a bogus one.
    const headerCases: Array<Record<string, string>> = [
      {},
      { "x-api-key": "definitely-not-valid" },
    ]
    for (const headers of headerCases) {
      const res = await fetch(`${engine.proxyUrl}/status`, { headers })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        service: string
        status: string
        version: string
        uptime_ms: number
        subsystems: {
          copilot: {
            authenticated: boolean
            ready: boolean
            account_type: string
          }
          models: { cached: number }
        }
      }
      // Top level = "Maximal, all up" — the identity + liveness signal.
      expect(body.service).toBe("maximal")
      expect(body.status).toBe("ok")
      expect(typeof body.version).toBe("string")
      expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
      // Subsystems namespace per-part health. This server booted with no
      // GitHub token, so copilot is unauthenticated and not ready —
      // proving the readiness signal reflects real state.
      expect(body.subsystems.copilot.authenticated).toBe(false)
      expect(body.subsystems.copilot.ready).toBe(false)
      expect(typeof body.subsystems.copilot.account_type).toBe("string")
      expect(body.subsystems.models.cached).toBeGreaterThanOrEqual(0)
    }
  })

  test("the two listeners bound distinct, real ports", () => {
    // Guards the seam this test now depends on: an engine that reported the
    // requested port rather than the bound one would hand back 0 for both.
    expect(engine.proxyPort).toBeGreaterThan(0)
    expect(engine.controlPort).toBeGreaterThan(0)
    expect(engine.controlPort).not.toBe(engine.proxyPort)
  })

  test("/_debug/state reports github_token_present: false", async () => {
    // The control listener, not the public one — /_debug moved there (#10).
    const res = await fetch(`${engine.controlUrl}/_debug/state`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      runtime: { github_token_present: boolean }
    }
    expect(body.runtime.github_token_present).toBe(false)
  })

  test("POST /v1/messages returns 401 not_authenticated", async () => {
    const res = await fetch(`${engine.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-sonnet", messages: [] }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; hint: string }
    expect(body.error).toBe("not_authenticated")
    expect(body.hint).toContain("Settings")
  })

  test("GET /chat/completions also gates on github auth", async () => {
    const res = await fetch(`${engine.proxyUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("not_authenticated")
  })
})
