import fs from "node:fs/promises"
import path from "node:path"

type SqliteValue = string | number | null

export const MINIMUM_NODE_SQLITE_VERSION = "22.13.0"

export interface SqliteStatement {
  all: (...values: Array<SqliteValue>) => Array<unknown>
  get: (...values: Array<SqliteValue>) => unknown
  run: (...values: Array<SqliteValue>) => unknown
}

export interface SqliteDatabase {
  close?: () => void
  exec: (sql: string) => unknown
  prepare: (sql: string) => SqliteStatement
}

interface SqliteDbStoreOptions {
  getPath: () => string
  initialize?: (db: SqliteDatabase) => void
  /** Opener seam. Defaults to the real {@link openSqliteDatabase}; tests inject
   *  a fake so the failure paths are drivable on every platform. */
  open?: (dbPath: string) => Promise<SqliteDatabase>
}

const isBunRuntime = (): boolean =>
  Boolean((globalThis as { Bun?: unknown }).Bun)

function parseNodeVersion(version: string): Array<number> {
  return version.split(".", 3).map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
}

interface SqliteRuntimeSupportInput {
  isBun?: boolean
  nodeVersion?: string
}

export function isNodeSqliteSupportedVersion(version: string): boolean {
  const current = parseNodeVersion(version)
  const minimum = parseNodeVersion(MINIMUM_NODE_SQLITE_VERSION)

  for (const [index, minimumPart] of minimum.entries()) {
    const currentPart = current[index] ?? 0
    if (currentPart > minimumPart) return true
    if (currentPart < minimumPart) return false
  }

  return true
}

export function isSqliteRuntimeSupported(
  input: SqliteRuntimeSupportInput = {},
): boolean {
  if (input.isBun ?? isBunRuntime()) {
    return true
  }

  return isNodeSqliteSupportedVersion(
    input.nodeVersion ?? process.versions.node,
  )
}

function getUnsupportedNodeSqliteMessage(nodeVersion: string): string {
  return (
    `SQLite-backed token usage requires Bun or Node.js >= ${MINIMUM_NODE_SQLITE_VERSION}. `
    + `Detected Node.js ${nodeVersion}. Upgrade Node.js or run the CLI with Bun, for example `
    + "`bunx --bun @stuffbucket/maximal@latest start` or `maximal start`."
  )
}

export class UnsupportedNodeSqliteRuntimeError extends Error {
  constructor(nodeVersion: string, cause?: unknown) {
    super(getUnsupportedNodeSqliteMessage(nodeVersion), { cause })
    this.name = "UnsupportedNodeSqliteRuntimeError"
  }
}

async function openBunDatabase(dbPath: string): Promise<SqliteDatabase> {
  const specifier = ["bun", "sqlite"].join(":")
  // casts-keep: module namespace from import("bun:sqlite"), a runtime built-in — a namespace object is not parseable data, so there is nothing to validate; guarded by isBunRuntime() at the only call site
  const sqlite = (await import(specifier)) as {
    Database: new (filename: string) => SqliteDatabase
  }
  return new sqlite.Database(dbPath)
}

async function loadNodeSqliteModule(): Promise<{
  DatabaseSync: new (location: string) => SqliteDatabase
}> {
  const nodeVersion = process.versions.node
  if (!isNodeSqliteSupportedVersion(nodeVersion)) {
    throw new UnsupportedNodeSqliteRuntimeError(nodeVersion)
  }

  const specifier = ["node", "sqlite"].join(":")
  try {
    // casts-keep: module namespace from import("node:sqlite"), a runtime built-in — a namespace object is not parseable data; the one failure mode (module absent) is the catch below, rethrown as UnsupportedNodeSqliteRuntimeError
    return (await import(specifier)) as {
      DatabaseSync: new (location: string) => SqliteDatabase
    }
  } catch (error) {
    throw new UnsupportedNodeSqliteRuntimeError(nodeVersion, error)
  }
}

async function openNodeDatabase(dbPath: string): Promise<SqliteDatabase> {
  const sqlite = await loadNodeSqliteModule()
  return new sqlite.DatabaseSync(dbPath)
}

export async function openSqliteDatabase(
  dbPath: string,
): Promise<SqliteDatabase> {
  const dir = path.dirname(dbPath)
  if (dbPath !== ":memory:" && dir !== ".") {
    await fs.mkdir(dir, { recursive: true })
  }
  return isBunRuntime() ? openBunDatabase(dbPath) : openNodeDatabase(dbPath)
}

export class SqliteDbStore {
  private dbPromise: Promise<SqliteDatabase> | null = null
  private readonly options: SqliteDbStoreOptions
  constructor(options: SqliteDbStoreOptions) {
    this.options = options
  }

  getDb(): Promise<SqliteDatabase> {
    this.dbPromise ??= this.open()
    return this.dbPromise
  }

  async close(input?: {
    beforeClose?: (db: SqliteDatabase) => void
  }): Promise<void> {
    const currentDbPromise = this.dbPromise
    this.dbPromise = null

    if (!currentDbPromise) {
      return
    }

    const db = await currentDbPromise
    input?.beforeClose?.(db)
    db.close?.()
  }

  private async open(): Promise<SqliteDatabase> {
    const openImpl = this.options.open ?? openSqliteDatabase
    const db = await openImpl(this.options.getPath())
    try {
      this.options.initialize?.(db)
    } catch (error) {
      // `initialize` runs AFTER the handle exists, and a store that SQLite
      // opens but will not read — a file truncated by a SIGKILL mid-write or a
      // full disk — throws right here on the first PRAGMA. Rejecting without
      // closing stranded that handle: `dbPromise` keeps the rejection cached,
      // so nothing ever reaches the database again to close it, and it is held
      // for the life of the process.
      //
      // On POSIX that is an invisible fd leak. On Windows an open handle also
      // LOCKS the file, so the user cannot delete or replace the corrupt store
      // to recover while the proxy is running, and no second process can open
      // it either. Close before rethrowing; the rejection is unchanged.
      try {
        db.close?.()
      } catch {
        // Best effort — never mask the initialize failure with a close failure.
      }
      throw error
    }
    return db
  }
}

// ────────────────────────────────────────────────────────────────────
// Versioned migration framework.
//
// Each SQLite-backed store owns an ordered list of Migration steps. The
// runner uses SQLite's built-in `PRAGMA user_version` as the schema
// version counter: migration[i] advances the DB from version i to i+1.
// On open, every migration whose target version exceeds the current
// user_version runs, in order, each wrapped in its own transaction so a
// failure rolls back cleanly and leaves user_version untouched (the next
// boot retries from the same point). Steps may run arbitrary DDL AND
// data backfill, so existing rows migrate forward rather than being
// stranded under an old shape.
// ────────────────────────────────────────────────────────────────────

export interface Migration {
  /** Human-readable label for logs/errors. Order in the array is what
   *  determines version, not this string. */
  name: string
  /** Apply the schema/data change. Runs inside a transaction. */
  up: (db: SqliteDatabase) => void
}

function getUserVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined
  return typeof row?.user_version === "number" ? row.user_version : 0
}

function setUserVersion(db: SqliteDatabase, version: number): void {
  // PRAGMA doesn't accept bound parameters; version is an integer we
  // compute, never user input.
  db.exec(`PRAGMA user_version = ${Math.floor(version)}`)
}

/**
 * Run any migrations whose target version exceeds the DB's current
 * `user_version`, in array order, each in its own transaction. Returns
 * the resulting schema version. Idempotent: a fully-migrated DB is a
 * no-op. Throws (after rollback) if a step fails, so a broken migration
 * never advances the version or leaves a half-applied change committed.
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: Array<Migration>,
): number {
  let current = getUserVersion(db)
  for (let target = current + 1; target <= migrations.length; target++) {
    const migration = migrations[target - 1]
    db.exec("BEGIN")
    try {
      migration.up(db)
      setUserVersion(db, target)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw new Error(
        `SQLite migration failed at step ${target} (${migration.name}): `
          + (error instanceof Error ? error.message : String(error)),
        { cause: error },
      )
    }
    current = target
  }
  return current
}
