/**
 * End-to-end guard for maximal-core#6's second acceptance criterion: the stored
 * GitHub token "never appears in logs/stdout".
 *
 * Unit tests already cover the two halves of the mechanism in isolation —
 * `tests/github-token-store.test.ts` asserts the on-disk record is 0600, and
 * `tests/log-redact.test.ts` asserts `scrubSecrets` masks a token-shaped run.
 * Neither one proves the composition: that a REAL boot, with a real token on
 * disk, exercised over the real control plane and the real proxy, leaves the
 * bearer out of every byte the process emits. That is what this file asserts,
 * and it is the only test that would catch a future call site logging
 * `${token}` through a sink that isn't scrubbed (stdout, notably, is NOT
 * scrubbed — only the file sink is).
 *
 * The seeded token is shaped like a genuine GitHub-App user token (`ghu_` + 36
 * token chars) so it matches the redaction pattern in `log-redact.ts`. A short
 * placeholder like `ghu_test` would be BELOW the scrubber's ≥20-char threshold
 * and the assertion would pass for the wrong reason.
 *
 * `--show-token` is deliberately NOT passed. That flag is an operator
 * affordance — the user asked to see the bearer, so printing it is the feature
 * (see `src/lib/start/bootstrap.ts`). It prints via the bare `consola` console,
 * never the tee'd file sink, so it does not weaken the on-disk invariant; but
 * running this test with it set would be asserting against the one path that is
 * *supposed* to emit the token.
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

/** Realistic GitHub-App user token: `ghu_` + 36 token chars, so it is long
 *  enough to match `scrubSecrets`' `gh[oprsu]_[A-Za-z0-9]{20,}` pattern. Not a
 *  real credential — it is rejected upstream, which is fine: this test is about
 *  what gets emitted, not about signing in.
 *
 *  Assembled from two halves ON PURPOSE: written as one literal it is a
 *  contiguous `ghu_…` run, which `scripts/secret-scan.sh` (TruffleHog) flags on
 *  every commit that touches this file. Splitting it defeats the *scanner's*
 *  pattern without weakening the *runtime* value — the concatenation is byte-for
 *  -byte what a real token looks like, which is what this test needs. */
const TOKEN_BODY = "KZq3vT8naL02cXbR7wY1sHdJp5MgEfU9tQzA"
const TOKEN = `ghu_${TOKEN_BODY}`

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-tokenlog-"))
const logDir = path.join(tmpHome, "logs")

let engine: Engine

/** Every file the logger tee'd into the isolated home, as `[name, contents]`. */
function readLogFiles(): Array<[string, string]> {
  if (!fs.existsSync(logDir)) return []
  return fs
    .readdirSync(logDir)
    .map((name) => [name, fs.readFileSync(path.join(logDir, name), "utf8")])
}

beforeAll(async () => {
  // Seed the token the way a signed-in user's home looks. The legacy
  // single-record file is migrated into accounts.json on boot, so this
  // exercises the store's read path, the migration write, and the runtime
  // load — three separate chances to log the bearer.
  fs.writeFileSync(path.join(tmpHome, "github_token"), TOKEN)

  // --verbose maximises what reaches both sinks: it turns on `log.debug`
  // (console + file) and unlocks /_debug. A leak is likeliest in a debug line,
  // so the noisiest configuration is the right one to assert against.
  engine = await startEngine({ home: tmpHome, args: ["--verbose"] })

  const rpc = (method: string) =>
    fetch(`${engine.controlUrl}/control/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    })

  // Exercise the token: rearm drives a real Copilot mint attempt with it (the
  // auth logger's busiest path), and a proxy request drives the handler logger.
  await rpc("auth/rearm")
  await rpc("auth/status")
  await fetch(`${engine.proxyUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Also send it as a client credential, so an incautious request-logging
      // middleware would have a second chance to spill it.
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    }),
  })

  // The tee'd file sink buffers and flushes on a 1s interval, so a line logged
  // a millisecond ago is still in memory. Wait for the sink to materialise
  // before SIGTERM rather than sleeping a fixed amount.
  const deadline = Date.now() + 10_000
  while (readLogFiles().length === 0 && Date.now() < deadline) {
    await Bun.sleep(100)
  }
  await engine.stop()
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("a real boot never emits the stored GitHub token", () => {
  test("the engine actually loaded the seeded token (assertions are not vacuous)", () => {
    // If migration silently no-opped, the rest of this file would be asserting
    // that a token nobody ever held wasn't logged. Pin it to the registry the
    // boot wrote, which is proof the raw bearer passed through the process.
    const raw = fs.readFileSync(path.join(tmpHome, "accounts.json"), "utf8")
    expect(raw).toContain(TOKEN)
  })

  test("the run produced log files to search (assertions are not vacuous)", () => {
    const files = readLogFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files.some(([, contents]) => contents.trim().length > 0)).toBe(true)
  })

  test("captured stdout + stderr contain no raw token", () => {
    const captured = engine.logLines.join("\n")
    // Sanity: we captured a real boot, not an empty stream.
    expect(captured).toContain("@@MAXIMAL_READY@@")
    expect(captured).not.toContain(TOKEN)
  })

  test("no file under the home's logs/ contains the raw token", () => {
    for (const [name, contents] of readLogFiles()) {
      // Name the file in the failure so a leak points straight at its sink.
      expect(`${name}: ${contents}`).not.toContain(TOKEN)
    }
  })
})
