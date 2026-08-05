/**
 * Source comments must not cite files or surfaces that no longer exist.
 *
 * A comment naming a deleted module is worse than no comment: it sends the next
 * reader looking for `routes/ws/route.ts` and, when they can't find it, leaves
 * them unsure whether the file or the explanation is out of date. Two survived
 * the core split (which removed the whole UI cluster — `routes/ui`,
 * `routes/settings`, `routes/ws`, `lib/ws`) and were found by a docs audit that
 * could not fix them, because they live in `src/`.
 *
 * Scope is deliberately narrow — `src/**` and `routes/`- or `lib/`-rooted paths,
 * which are unambiguous within this repo. `docs/**` reference parity is a
 * separate concern with its own guard.
 */
import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url))

/** A repo path as a comment would cite it: `routes/x/y.ts`, `lib/a/b.ts`,
 *  optionally `src/`-prefixed. Not import specifiers — those are `~/`-aliased
 *  and extensionless, and the compiler already checks them. */
const CITED_PATH =
  /\b(?:src\/)?((?:routes|lib|apps|services)\/[\w./-]+\.ts)\b/gu

/** Surfaces removed in the core split. A comment mentioning one is stale by
 *  definition — there is no UI in this repo. */
const REMOVED_SURFACES = ["/ui/diagnostics", "/ui/settings", "routes/ui"]

function sourceFiles(dir: string): Array<string> {
  const found: Array<string> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full))
    } else if (entry.name.endsWith(".ts")) {
      found.push(full)
    }
  }
  return found
}

const files = sourceFiles(SRC_DIR)

describe("source comments cite files that exist", () => {
  it("finds source files to scan (guards the walker itself)", () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it("every cited routes//lib//apps//services path resolves under src/", () => {
    const broken: Array<string> = []
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8")
      for (const match of text.matchAll(CITED_PATH)) {
        const cited = match[1]
        if (!fs.existsSync(path.join(SRC_DIR, cited))) {
          broken.push(`${path.relative(SRC_DIR, file)} cites ${cited}`)
        }
      }
    }
    expect(broken).toEqual([])
  })

  it("no comment mentions a surface removed in the core split", () => {
    const stale: Array<string> = []
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8")
      for (const surface of REMOVED_SURFACES) {
        if (text.includes(surface)) {
          stale.push(`${path.relative(SRC_DIR, file)} mentions ${surface}`)
        }
      }
    }
    expect(stale).toEqual([])
  })
})
