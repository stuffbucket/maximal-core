import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import { jobBlock } from "./check-ci-coverage"
import { repoPath } from "./check-rulesets"

/**
 * `ci.yml`'s `test` job names the toolchain image by the pin's own tag —
 * `…/ci:bun-<version>` — as a COMMITTED LITERAL, because
 * `jobs.<id>.container.image` is resolved before any step runs and so cannot be
 * computed (see publish-ci-image.yml's header). A literal is not derived from
 * `.bun-version`, so the two can drift, and the only thing that used to notice
 * was the job's own first step: a container-creation failure or a red parity
 * gate, minutes into CI.
 *
 * This is that check, offline and in `bun run check:ops`. It is the exact form
 * — a tag can be mapped back to a Bun version, which is the concrete reason the
 * tag was chosen over an immutable digest (maximal-core#126); a digest would
 * only admit a structural assertion.
 *
 * Textual parsing for the reason check-rulesets.ts gives: the ops lane has no
 * `node_modules`, so a YAML parser here would mean a new install in three
 * workflows.
 */
function containerImage(yaml: string, jobId: string): string | undefined {
  const block = jobBlock(yaml, jobId)
  if (block === undefined) return undefined
  for (const line of block.split("\n")) {
    if (/^\s*#/u.test(line)) continue
    // The value is not `\S+`: `${{ github.repository }}` contains spaces.
    const match = /^\s*image:\s*(\S.*?)\s*$/u.exec(line)
    if (match) return match[1]
  }
  return undefined
}

describe("container image parsing", () => {
  const yaml = [
    "jobs:",
    "  test:",
    "    container:",
    "      # image: ghcr.io/x/ci:decoy",
    "      image: ghcr.io/x/ci:bun-9.9.9",
    "  windows:",
    "    runs-on: windows-latest",
    "",
  ].join("\n")

  test("reads the job's container image, ignoring comments", () => {
    expect(containerImage(yaml, "test")).toBe("ghcr.io/x/ci:bun-9.9.9")
  })

  test("an uncontainerised or absent job yields nothing rather than throwing", () => {
    expect(containerImage(yaml, "windows")).toBeUndefined()
    expect(containerImage(yaml, "nope")).toBeUndefined()
  })
})

describe("toolchain image parity with .bun-version", () => {
  test("ci.yml's test job names the pin's own tag", async () => {
    const pin = (await fs.readFile(repoPath(".bun-version"), "utf8")).trim()
    const yaml = await fs.readFile(repoPath(".github/workflows/ci.yml"), "utf8")
    const image = containerImage(yaml, "test")
    // Not `latest`, and not some other pin's tag: bumping `.bun-version`
    // without moving this line in the same commit fails here, before CI.
    expect(image).toBe(`ghcr.io/\${{ github.repository }}/ci:bun-${pin}`)
  })
})
