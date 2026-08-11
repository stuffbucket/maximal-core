/**
 * Host-side primitives: shelling out, prerequisite checks, downloads.
 *
 * The prerequisite list is the one thing a new user hits first, so it is kept
 * where it can be read without following any other code path.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { basename, resolve } from "node:path"

/** Homebrew's AArch64 UEFI code image. Non-secure — see the docs for why that matters. */
export const FIRMWARE = "/opt/homebrew/share/qemu/edk2-aarch64-code.fd"
export const FIRMWARE_VARS = "/opt/homebrew/share/qemu/edk2-arm-vars.fd"

/** WHQL-signed ARM64 virtio drivers plus qemu-ga. The practical source of both. */
export const TOOLS_URL = "https://getutm.app/downloads/utm-guest-tools-latest.iso"

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

/** Human-readable size, for `winvm ls`. Overlays and base images differ by orders of magnitude. */
export function du(path: string): string {
  if (!existsSync(path)) return "-"
  return capture("du", ["-h", path]).split(/\s+/)[0] ?? "-"
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
    { label: `UEFI firmware (${FIRMWARE})`, ok: existsSync(FIRMWARE), hint: "brew install qemu" },
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

export function download(url: string, dest: string): void {
  if (existsSync(dest)) return
  mkdirSync(resolve(dest, ".."), { recursive: true })
  console.log(`fetching ${basename(dest)}`)
  if (run("curl", ["-fL", "--progress-bar", "-o", dest, url]) !== 0) {
    // A truncated file that looks present is worse than one that is absent:
    // the next run would skip the download and fail somewhere unrelated.
    rmSync(dest, { force: true })
    throw new Error(`download failed: ${url}`)
  }
}
