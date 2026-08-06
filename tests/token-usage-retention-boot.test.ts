/**
 * Boot-time token-usage retention must not be able to kill the process.
 *
 * `startTokenUsageRetention()` is called from `finalizeBoot` — AFTER both
 * listeners are bound, after `printReadyBanner`, and after the ready-line has
 * been emitted to a supervisor. Its sweep fires `pruneTokenUsageEvents()`, whose
 * first act is to open the SQLite file. `void promise.then(...)` attaches a
 * fulfilment handler only, so a rejection there is an UNHANDLED rejection, and
 * neither Bun nor Node tolerates one by default: the process exits.
 *
 * The trigger is ordinary local-state damage, not exotic input. The store lives
 * at `$APP_DIR/copilot-api.sqlite`; a SIGKILL mid-write, a disk-full, or a
 * restored/synced partial file leaves bytes that SQLite rejects with
 * `SQLITE_NOTADB`, and an installer-owned or read-only file yields
 * `SQLITE_CANTOPEN`. Either way the user sees the proxy announce that it is
 * ready and then die, with a raw SQLite stack and no mention of the database —
 * and a supervisor that already parsed the ready-line sees a healthy start
 * followed by an unexplained exit.
 *
 * Usage bookkeeping is a non-essential side feature. It must degrade to "no
 * retention sweep", never take the proxy with it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { closeUsageStore, startTokenUsageRetention } from "~/lib/token-usage"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

let tmpDir: string
let stop: (() => void) | undefined

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maximal-retention-"))
  await closeUsageStore()
})

afterEach(async () => {
  stop?.()
  stop = undefined
  // The fixture database is deliberately unusable, so closing it fails too.
  // That is cleanup of the fixture, not the behaviour under test.
  await closeUsageStore().catch(() => {})
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Run the boot sweep against `dbPath` and report any unhandled rejection it
 * produces. Installing a listener is also what suppresses the default
 * terminate-the-process behaviour, so the assertion below is exactly the
 * condition that would have been a crash in production.
 */
async function unhandledRejectionFrom(dbPath: string): Promise<unknown> {
  process.env[DB_PATH_ENV] = dbPath

  let captured: unknown
  const onUnhandled = (reason: unknown) => {
    captured = reason
  }
  process.on("unhandledRejection", onUnhandled)
  try {
    stop = startTokenUsageRetention()
    // Let the open + init reject and the rejection be reported.
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  return captured
}

describe("startTokenUsageRetention survives an unusable database", () => {
  // A truncated / partially-written store — what a SIGKILL mid-write or a
  // disk-full leaves behind. SQLite: SQLITE_NOTADB, thrown from the schema init.
  test("a corrupt database file does not produce an unhandled rejection", async () => {
    const dbPath = path.join(tmpDir, "corrupt.sqlite")
    fs.writeFileSync(dbPath, "not a sqlite database")

    expect(await unhandledRejectionFrom(dbPath)).toBeUndefined()
  })

  // An unopenable path — a directory, a root-owned file, a read-only volume.
  // SQLite: SQLITE_CANTOPEN, thrown from the open itself.
  test("an unopenable database path does not produce an unhandled rejection", async () => {
    const dbPath = path.join(tmpDir, "a-directory.sqlite")
    fs.mkdirSync(dbPath)

    expect(await unhandledRejectionFrom(dbPath)).toBeUndefined()
  })
})
