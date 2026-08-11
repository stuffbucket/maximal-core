/**
 * Host-side primitives: shelling out, prerequisite checks, downloads.
 *
 * The prerequisite list is the one thing a new user hits first, so it is kept
 * where it can be read without following any other code path.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import { gunzipSync } from "node:zlib"

import { home } from "./paths"

/**
 * Where QEMU keeps the firmware images it ships — ASKED, NOT ASSUMED.
 *
 * The binaries are already found through PATH, so assuming a prefix for their
 * data files was the one inconsistent thing left: a hard-coded
 * `/opt/homebrew/share/qemu` finds nothing on an Intel Mac (`/usr/local`),
 * under MacPorts or Nix, or against a QEMU built from source — while
 * `qemu-system-aarch64` itself resolves perfectly well. On this machine that
 * path only works by symlink: QEMU actually lives in
 * `/opt/homebrew/Cellar/qemu-spice/…/share/qemu`.
 *
 * `-L help` makes QEMU print the directories it will search, which is the
 * authoritative answer and costs one process. Falling back to the binary's own
 * location covers a QEMU too old to support it.
 */
let dataDirs: readonly string[] | null = null
export function qemuDataDirs(): readonly string[] {
  if (dataDirs !== null) return dataDirs
  const override = process.env["WINVM_QEMU_DATA"]
  if (override !== undefined && override !== "") {
    dataDirs = [resolve(override)]
    return dataDirs
  }
  // The vendored copy comes first, so the harness does not depend on how a
  // particular QEMU packaging laid out its data files. Expanded once into the
  // state directory: the images are ~99% zero padding, which is why 128 MiB of
  // firmware is 1.6 MB in the repository. See THIRD-PARTY-LICENSE.md.
  const vendored = expandVendoredFirmware()
  if (vendored !== null) {
    dataDirs = [vendored]
    return dataDirs
  }
  const asked = spawnSync("qemu-system-aarch64", ["-L", "help"], { encoding: "utf8" })
  const listed = `${asked.stdout ?? ""}${asked.stderr ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/"))
    .map((l) => resolve(l))
  if (listed.length > 0) {
    dataDirs = listed
    return dataDirs
  }
  // Last resort: <prefix>/bin/qemu-system-aarch64 -> <prefix>/share/qemu
  const bin = (spawnSync("command", ["-v", "qemu-system-aarch64"], { shell: true, encoding: "utf8" }).stdout ?? "").trim()
  dataDirs = bin === "" ? [] : [resolve(bin, "..", "..", "share", "qemu")]
  return dataDirs
}

/**
 * Expand `firmware/*.fd.gz` into the state directory, once, and return the
 * directory holding them. Returns null when this copy of the tool has no
 * vendored firmware, so discovery still runs.
 */
function expandVendoredFirmware(): string | null {
  const src = resolve(import.meta.dir, "firmware")
  const gz = [`${CODE_NAMES[0]}.gz`, `${VARS_NAMES[0]}.gz`]
  if (!gz.every((f) => existsSync(resolve(src, f)))) return null

  const dest = resolve(home(), "firmware")
  mkdirSync(dest, { recursive: true })
  for (const f of gz) {
    const out = resolve(dest, f.replace(/\.gz$/, ""))
    // Size is the cheap integrity check: a truncated expansion would otherwise
    // reach QEMU as a corrupt pflash and fail somewhere far less obvious.
    // Stat and handle absence rather than asking whether it exists first — the
    // two-step form races anything else writing here.
    if (sizeOrZero(out) === EXPECTED_FIRMWARE_BYTES) continue
    writeFileSync(out, gunzipSync(readFileSync(resolve(src, f))))
  }
  return dest
}

/** Both EDK2 images are exactly 64 MiB; pflash requires the size to match the device. */
const EXPECTED_FIRMWARE_BYTES = 64 * 1024 * 1024

const sizeOrZero = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * First match wins. QEMU's own names come first; the others are what Debian and
 * Linaro ship, cheap to look for and harmless when absent.
 */
function findFirmware(names: readonly string[]): string | null {
  for (const dir of qemuDataDirs()) {
    for (const name of names) {
      const candidate = resolve(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const CODE_NAMES = ["edk2-aarch64-code.fd", "AAVMF_CODE.fd", "QEMU_EFI.fd"] as const
const VARS_NAMES = ["edk2-arm-vars.fd", "AAVMF_VARS.fd", "QEMU_VARS.fd"] as const

/** The AArch64 UEFI code image. Non-secure — see the docs for why that matters. */
export const firmwareCode = (): string | null => findFirmware(CODE_NAMES)
/** The matching variables template, copied per instance and converted to qcow2. */
export const firmwareVars = (): string | null => findFirmware(VARS_NAMES)

/**
 * Both images or a clear error. Without this the missing case reaches QEMU as
 * the literal string "null" and comes back as `Could not open 'null'`.
 */
export function requireFirmware(): { readonly code: string; readonly vars: string } {
  const code = firmwareCode()
  const vars = firmwareVars()
  if (code === null || vars === null) throw new Error(`UEFI firmware not found — ${firmwareHint()}`)
  return { code, vars }
}

/** Names what was looked for and where, because "firmware not found" alone is useless. */
export function firmwareHint(): string {
  const dirs = qemuDataDirs()
  return (
    `looked for ${CODE_NAMES.join(" / ")} in ${dirs.length === 0 ? "(no QEMU data directories found)" : dirs.join(", ")}` +
    " — set WINVM_QEMU_DATA to point at them"
  )
}

/**
 * WHQL-signed ARM64 virtio drivers plus qemu-ga. The practical source of both.
 *
 * DOWNLOADED, NOT VENDORED, and that is a licence decision rather than a size
 * one: the installer on this ISO bundles `qemu-ga`, which is GPL-2.0, and
 * shipping it would oblige this project to keep corresponding source available
 * for as long as it did. See THIRD-PARTY-LICENSE.md.
 *
 * Pinned by digest because the URL says "latest" — upstream can change what it
 * serves at any moment, and a test fixture that silently changes underneath a
 * harness is exactly the kind of variable this tool exists to remove.
 */
export const TOOLS_URL = "https://getutm.app/downloads/utm-guest-tools-latest.iso"
export const TOOLS_SHA256 = "65b6a69b392ee01dd314c10f3dad9ebbf9c4160be43f5f0dd6bb715944d9095b"

export const sha256Of = (path: string): string => capture("shasum", ["-a", "256", path]).split(/\s+/)[0] ?? ""

export function run(cmd: string, args: readonly string[]): number {
  return spawnSync(cmd, [...args], { stdio: "inherit" }).status ?? 1
}

export function capture(cmd: string, args: readonly string[]): string {
  return (spawnSync(cmd, [...args], { encoding: "utf8" }).stdout ?? "").trim()
}

/** Like `run`, but silent — for probes whose failure is expected and handled by the caller. */
export function quiet(cmd: string, args: readonly string[]): number {
  return spawnSync(cmd, [...args], { stdio: "ignore" }).status ?? 1
}

export function have(cmd: string): boolean {
  return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0
}

/**
 * Human-readable size, for `winvm ls`. Overlays and base images differ by orders
 * of magnitude.
 *
 * `-s` is load-bearing now that directories are measured too: plain `du -h`
 * prints a line per subdirectory and the first one is NOT the total, so a state
 * directory holding a 14 GB image reported 128 MB.
 */
export function du(path: string): string {
  if (!existsSync(path)) return "-"
  return capture("du", ["-sh", path]).split(/\s+/)[0] ?? "-"
}

export interface Check {
  readonly label: string
  readonly ok: boolean
  readonly hint: string
}

export function hostChecks(): readonly Check[] {
  return [
    { label: "qemu-system-aarch64", ok: have("qemu-system-aarch64"), hint: "brew install qemu" },
    { label: "qemu-img", ok: have("qemu-img"), hint: "brew install qemu" },
    // Windows 11 hard-requires TPM 2.0. Without an emulated one the only way
    // past Setup is the LabConfig registry bypass, an unsupported configuration.
    { label: "swtpm", ok: have("swtpm"), hint: "brew install swtpm" },
    // Reported with the path that was actually found, so a mismatched QEMU
    // install is obvious rather than a bare "missing".
    {
      label: `UEFI firmware${firmwareCode() === null ? "" : ` (${String(firmwareCode())})`}`,
      ok: firmwareCode() !== null && firmwareVars() !== null,
      hint: firmwareHint(),
    },
    // Builds the seed ISO and the FAT result volume. macOS-only, which is the
    // tool's platform limit and worth surfacing as a named check rather than a
    // confusing failure deep inside `build`.
    { label: "hdiutil", ok: have("hdiutil"), hint: "macOS built-in" },
  ]
}

export function requireHost(): void {
  const missing = hostChecks().filter((c) => !c.ok)
  if (missing.length === 0) return
  console.error("::error::missing prerequisites — run `winvm doctor`")
  for (const c of missing) console.error(`  ${c.label} -> ${c.hint}`)
  process.exit(1)
}

export function download(url: string, dest: string, sha256?: string): void {
  if (existsSync(dest)) {
    if (sha256 === undefined || sha256Of(dest) === sha256) return
    // A cached file that no longer matches is not silently re-used.
    console.warn(`warning: ${basename(dest)} does not match its pin; re-fetching`)
    rmSync(dest, { force: true })
  }
  mkdirSync(resolve(dest, ".."), { recursive: true })
  console.log(`fetching ${basename(dest)}`)
  if (run("curl", ["-fL", "--progress-bar", "-o", dest, url]) !== 0) {
    // A truncated file that looks present is worse than one that is absent:
    // the next run would skip the download and fail somewhere unrelated.
    rmSync(dest, { force: true })
    throw new Error(`download failed: ${url}`)
  }
  if (sha256 === undefined) return
  const got = sha256Of(dest)
  if (got === sha256) return
  // The pin's job is to DETECT drift, not to prevent it. Upstream publishing a
  // new build is expected and legitimate; adopting it silently is not.
  rmSync(dest, { force: true })
  throw new Error(
    `${basename(dest)} does not match its pinned digest.\n` +
      `  expected ${sha256}\n  got      ${got}\n` +
      `  Upstream has probably published a new build. Review it, then update ` +
      `TOOLS_SHA256 in host.ts to the new digest.`,
  )
}
