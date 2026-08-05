/**
 * Build the single-file sidecar binary.
 *
 * The engine ships to a desktop host as a **compiled executable**, not as the
 * JS bundle `bun run build` produces — that emits a `#!/usr/bin/env node` text
 * script, which cannot be code-signed and therefore cannot live inside a
 * notarized app bundle. `--compile` produces a real Mach-O / PE binary.
 *
 * ## Targets
 *
 * `bun-darwin-arm64` and `bun-windows-x64`. **Intel macOS is deliberately not
 * built** — a decision, not an oversight. Adding it later means adding the
 * target here and `lipo`-ing the two darwin slices together, because `--compile`
 * emits per-arch binaries and cannot produce a universal one.
 *
 * ## The signature is broken on arrival
 *
 * `--compile` appends the bundled JS onto the bun runtime *after* the linker
 * signed it, so the ad-hoc signature it carries is already invalid:
 *
 *     flags=0x20002(adhoc,linker-signed)  Identifier=a.out
 *     spctl: invalid signature (code or signature have been modified)
 *
 * Any macOS consumer must therefore re-sign with `codesign --force`, supplying a
 * real identifier and an entitlements plist. The embedded JavaScriptCore JITs,
 * so under hardened runtime that plist needs `com.apple.security.cs.allow-jit`
 * or the binary dies at launch in exactly the builds you cannot debug easily.
 * Signing is the packaging step's job, not this script's — the app bundle's own
 * signature supersedes anything applied here.
 */
import { spawnSync } from "node:child_process"

import packageJson from "../../package.json" with { type: "json" }

/** Targets we ship. See the note above before adding one. */
export const TARGETS = ["bun-darwin-arm64", "bun-windows-x64"] as const
export type Target = (typeof TARGETS)[number]

function git(...args: Array<string>): string {
  const res = spawnSync("git", args, { encoding: "utf8" })
  return res.status === 0 ? res.stdout.trim() : ""
}

/** `0.2.0` -> stable, `0.3.0-beta.1` -> beta. Mirrors how the tag is classified
 *  at release time so a locally-built binary reports the same channel. */
function channelFor(version: string): string {
  if (!version.includes("-")) return "stable"
  return version.split("-")[1].split(".")[0]
}

export interface BuildOptions {
  target?: Target
  outfile: string
  /** Skip `--minify`/`--sourcemap` for a faster local build. */
  fast?: boolean
}

export function buildBinary(options: BuildOptions): { ok: boolean; out: string } {
  const version = packageJson.version
  const args = [
    "build",
    "--compile",
    ...(options.fast ? [] : ["--minify", "--sourcemap"]),
    ...(options.target ? [`--target=${options.target}`] : []),
    `--define`,
    `__MAXIMAL_VERSION__="${version}"`,
    `--define`,
    `__MAXIMAL_GIT_SHA__="${git("rev-parse", "--short", "HEAD")}"`,
    `--define`,
    `__MAXIMAL_GIT_BRANCH__="${git("rev-parse", "--abbrev-ref", "HEAD")}"`,
    `--define`,
    `__MAXIMAL_CHANNEL__="${channelFor(version)}"`,
    "src/main.ts",
    "--outfile",
    options.outfile,
  ]
  // `process.execPath`, not the string "bun": on a Windows runner `spawnSync`
  // gets no shell and no PATHEXT expansion, so a bare "bun" may not resolve to
  // `bun.exe`. The interpreter already running this file is by definition the
  // right one.
  const res = spawnSync(process.execPath, args, { stdio: "inherit" })
  return { ok: res.status === 0, out: options.outfile }
}

// CLI: `bun scripts/dev/build-binary.ts [--target=<t>] [--out=<path>] [--fast]`
if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=")

  const target = flag("target") as Target | undefined
  if (target && !TARGETS.includes(target)) {
    console.error(`Unknown target ${target}. Known: ${TARGETS.join(", ")}`)
    process.exit(1)
  }
  const out = flag("out") ?? `dist-bin/maximal${target?.includes("windows") ? ".exe" : ""}`
  const { ok } = buildBinary({
    target,
    outfile: out,
    fast: argv.includes("--fast"),
  })
  console.log(ok ? `built ${out}` : "build failed")
  process.exit(ok ? 0 : 1)
}
