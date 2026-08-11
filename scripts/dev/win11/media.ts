/**
 * Media the guest boots and reads: the seed ISO, and the writable result volume.
 *
 * Both exist because a Windows install has no other way to talk to its host
 * before the guest agent is installed — which is exactly when a failed install
 * most needs to explain itself.
 */
import type { Dirent } from "node:fs"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { resolve } from "node:path"

import { capture, download, quiet, run } from "./host"
import { media, mediaDir } from "./paths"

const ASSETS = resolve(import.meta.dir, "assets")

/**
 * A 64 MB FAT volume the guest writes its provisioning transcript to, and the
 * host mounts afterwards. Also carries startup.nsh: the UEFI shell auto-runs it
 * from a volume it can see, and this FAT image is mapped earlier than the
 * hdiutil-built ISO9660 seed.
 */
export function makeResultVolume(dest: string): void {
  // Deliberately NO "already exists, leave it alone" guard.
  //
  // This volume is not just an output: it carries autounattend.xml,
  // SetupComplete.cmd, provision.ps1 and startup.nsh, and since the answer file
  // is honoured from HERE rather than from the ISO seed, reusing an existing one
  // means the guest installs from the PREVIOUS run's assets — you edit the answer
  // file, rebuild, and nothing changes. The stale provision.log reads as the new
  // run's transcript at the same time. Every caller creates or resets, so making
  // this unconditional costs nothing and removes both failures.
  rmSync(dest, { force: true })
  run("dd", ["if=/dev/zero", `of=${dest}`, "bs=1m", "count=64", "status=none"])

  const dev = capture("hdiutil", ["attach", "-nomount", dest]).split(/\s+/)[0]
  if (dev === undefined || dev === "") throw new Error("could not attach result image")
  run("newfs_msdos", ["-F", "32", "-v", "MAXRESULT", dev])
  run("hdiutil", ["detach", dev])

  const mounted = capture("hdiutil", ["attach", dest]).split(/\s+/)[0]
  if (mounted !== undefined && mounted !== "") {
    writeFileSync("/Volumes/MAXRESULT/startup.nsh", readFileSync(resolve(ASSETS, "startup.nsh")))
    // The answer file goes here TOO, not only on the seed ISO.
    //
    // Windows Setup scans attached volumes for `autounattend.xml`, and a FAT
    // removable volume is the location it has always honoured. An ISO9660 seed
    // built by hdiutil is not reliably picked up on 25H2 — Setup came up
    // interactively at "Select language settings" with the file present at the
    // ISO root, which is indistinguishable from having supplied no answer file
    // at all. Writing it to both costs 12 KB and removes the ambiguity.
    writeFileSync("/Volumes/MAXRESULT/autounattend.xml", readFileSync(resolve(ASSETS, "autounattend.xml")))
    // Provisioning rides here too: `specialize` copies whichever volume it
    // finds first into C:\\Windows\\Setup\\Scripts.
    writeFileSync("/Volumes/MAXRESULT/SetupComplete.cmd", readFileSync(resolve(ASSETS, "SetupComplete.cmd")))
    writeFileSync("/Volumes/MAXRESULT/provision.ps1", readFileSync(resolve(ASSETS, "provision.ps1")))
    run("hdiutil", ["detach", mounted])
  }
}

/**
 * Find the Windows 11 ARM64 ISO the caller wants installed.
 *
 * The ISO is ~8 GB and belongs to the user, not to this tool: it is never
 * copied, never cached and never redistributed — only symlinked into the state
 * directory, which is why answering this once is enough forever afterwards.
 *
 * Sources, in order, so that configuring it never means committing anything:
 *
 *   1. `--iso <path>`            explicit, wins over everything
 *   2. `WINVM_ISO`               declare it once in a shell profile
 *   3. the existing symlink      what a previous `--iso` already recorded
 *   4. unprotected folders       ~/vm, ~/isos, the state dir — matched by name
 *   5. a prompt                  only when someone is actually there to answer
 *
 * Step 5 is gated on a TTY on purpose: a build that blocks forever waiting for
 * input nobody can give is worse than one that fails saying what it needed.
 */
export function resolveWindowsIso(explicit: string | undefined): string | null {
  const fromFlag = explicit ?? process.env["WINVM_ISO"]
  if (fromFlag !== undefined && fromFlag !== "") {
    const path = resolve(fromFlag.replace(/^~(?=\/)/, homedir()))
    if (!existsSync(path)) {
      console.error(`::error::no such ISO: ${path}`)
      return null
    }
    return path
  }
  if (existsSync(media.iso())) return media.iso()

  const found = discoverIsos()
  if (found.length === 1) {
    console.log(`using ${found[0]}`)
    return found[0] ?? null
  }
  if (found.length > 1) {
    console.log("found more than one candidate; pass --iso to choose:")
    for (const f of found) console.log(`  ${f}`)
    return null
  }
  return promptForIso()
}

/**
 * Windows 11 ARM64 media is named like `Win11_25H2_English_Arm64_v2.iso`, so the
 * architecture is in the filename. Matching on it keeps an x64 ISO sitting in
 * the same folder from being picked up silently.
 *
 * DELIBERATELY DOES NOT LOOK IN ~/Downloads OR ~/Desktop. Those are TCC-
 * protected on macOS, and merely attempting to read them raises a consent
 * dialog against whichever terminal is running this — a background build
 * demanding permission to your Downloads folder is not acceptable behaviour
 * from a dev tool, and catching the resulting EPERM does not prevent the
 * prompt. Only unprotected locations are searched; anywhere else is named with
 * `--iso` or `WINVM_ISO`.
 */
function discoverIsos(): readonly string[] {
  const roots = [resolve(homedir(), "vm"), resolve(homedir(), "isos"), mediaDir()]
  const out: string[] = []
  for (const root of roots) {
    for (const entry of listDir(root)) {
      const path = resolve(root, entry.name)
      if (entry.isFile() && /arm64.*\.iso$/i.test(entry.name)) out.push(path)
      // One level down, because people keep these in a folder per VM.
      else if (entry.isDirectory()) {
        for (const inner of listDir(path)) {
          if (inner.isFile() && /arm64.*\.iso$/i.test(inner.name)) out.push(resolve(path, inner.name))
        }
      }
    }
  }
  return [...new Set(out)]
}

/**
 * Listing that cannot throw. The searched folders are unprotected, but a missing
 * one, a dangling symlink or an odd permission bit should skip that root rather
 * than abort the search with a stack trace on someone's first run.
 */
function listDir(dir: string): readonly Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function promptForIso(): string | null {
  if (process.stdin.isTTY !== true) return null
  console.log(`No Windows 11 ARM64 ISO found. Get one from:\n  ${ISO_SOURCE}`)
  const answer = prompt("Path to the ISO (blank to cancel):")?.trim() ?? ""
  if (answer === "") return null
  const path = resolve(answer.replace(/^~(?=\/)/, homedir()).replace(/^['"]|['"]$/g, ""))
  if (!existsSync(path)) {
    console.error(`::error::no such ISO: ${path}`)
    return null
  }
  return path
}

export const ISO_SOURCE =
  "https://www.microsoft.com/en-us/software-download/windows11arm64 " +
  "(multi-edition ARM64, no sign-in; the generated link expires after 24h)"

/**
 * Confirm the ISO really is ARM64 Windows before a 12-minute install finds out.
 *
 * Cheap and decisive: the media boots `\efi\boot\bootaa64.efi`, which an x64 ISO
 * simply does not carry. A mount that fails proves nothing, so that case passes
 * with a warning rather than blocking a legitimate build.
 */
export function checkIsoIsArm64(iso: string): boolean {
  const mnt = mkdtempSync(resolve(tmpdir(), "winvm-iso-"))
  try {
    if (quiet("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mnt, iso]) !== 0) {
      console.warn(`warning: could not mount ${iso} to check its architecture; continuing`)
      return true
    }
    const ok = existsSync(resolve(mnt, "efi/boot/bootaa64.efi")) || existsSync(resolve(mnt, "EFI/BOOT/BOOTAA64.EFI"))
    if (!ok) {
      console.error(
        `::error::${iso} has no \\efi\\boot\\bootaa64.efi, so it is not Windows ARM64 media.\n  ${ISO_SOURCE}`,
      )
    }
    return ok
  } finally {
    quiet("hdiutil", ["detach", mnt])
    rmSync(mnt, { recursive: true, force: true })
  }
}

/** What the guest reported about its own provisioning, read back off the result volume. */
export interface ProvisionResult {
  /** `provision.ps1`'s verdict: "ok", "failed: <reason>", or null if it never ran. */
  readonly status: string | null
  /**
   * "ok" when viostor came out as a boot-start driver, meaning the finished
   * image can boot on virtio-blk and therefore supports live snapshots.
   * Reported separately from `status` because it is a capability, not a
   * requirement: an image without it is still a perfectly good Windows guest.
   */
  readonly virtio: string | null
  /** The provisioning transcript, or "" if there is none. */
  readonly log: string
}

/**
 * Read the guest's own verdict on an install.
 *
 * This is the ONLY evidence that exists before the guest agent does, and it is
 * what makes "the VM powered off" separable from "the install worked" — the two
 * are otherwise identical from the host, because a crash, a kill and a
 * successful provision all end with QEMU gone.
 *
 * Mounted read-only at a private mountpoint rather than at /Volumes/MAXRESULT:
 * every instance's volume carries that same label, so the shared path would
 * collide between two concurrent guests.
 */
export function readResult(image: string): ProvisionResult {
  const mnt = mkdtempSync(resolve(tmpdir(), "winvm-result-"))
  try {
    if (quiet("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mnt, image]) !== 0) {
      return { status: null, virtio: null, log: "" }
    }
    const read = (n: string): string | null => {
      const f = resolve(mnt, n)
      return existsSync(f) ? readFileSync(f, "utf8") : null
    }
    // The trim is load-bearing, not tidiness: provision.ps1 runs under Windows
    // PowerShell 5.1, whose `-Encoding UTF8` writes a BOM, so status.txt reads
    // back as "﻿ok". U+FEFF is whitespace to String.prototype.trim, which
    // is the only reason a byte-equality check against "ok" succeeds.
    return {
      status: read("status.txt")?.trim() ?? null,
      virtio: read("virtio.txt")?.trim() ?? null,
      log: read("provision.log") ?? "",
    }
  } finally {
    quiet("hdiutil", ["detach", mnt])
    rmSync(mnt, { recursive: true, force: true })
  }
}

/**
 * The seed ISO: the answer file, the provisioning script, and whatever the
 * caller wants staged inside the guest.
 *
 * The payload contract is deliberately dumb — every `.zip` is expanded into
 * `C:\payload`, everything else is copied there, and a `setup.ps1` runs last.
 * That keeps this tool ignorant of what any particular consumer installs.
 */
export function buildSeed(payloadDir: string | undefined, bunVersion: string | undefined): void {
  const dir = media.seedDir()
  mkdirSync(resolve(dir, "payload"), { recursive: true })
  copyFileSync(resolve(ASSETS, "autounattend.xml"), resolve(dir, "autounattend.xml"))
  copyFileSync(resolve(ASSETS, "provision.ps1"), resolve(dir, "provision.ps1"))
  copyFileSync(resolve(ASSETS, "SetupComplete.cmd"), resolve(dir, "SetupComplete.cmd"))

  if (payloadDir !== undefined) {
    const src = resolve(payloadDir)
    if (!existsSync(src)) throw new Error(`no such payload directory: ${src}`)
    run("cp", ["-R", `${src}/.`, resolve(dir, "payload")])
  }

  // A convenience, not a coupling: `--bun <version>` fetches the exact release
  // asset. Callers who want something else use `--payload`.
  if (bunVersion !== undefined) {
    download(
      `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-windows-aarch64.zip`,
      resolve(dir, "payload", "bun-windows-aarch64.zip"),
    )
  }

  rmSync(media.seed(), { force: true })
  run("hdiutil", [
    "makehybrid", "-iso", "-joliet",
    "-default-volume-name", "WINVMSEED",
    "-o", media.seed(), dir,
  ])
}
