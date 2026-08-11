/**
 * Media the guest boots and reads: the seed ISO, and the writable result volume.
 *
 * Both exist because a Windows install has no other way to talk to its host
 * before the guest agent is installed — which is exactly when a failed install
 * most needs to explain itself.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { capture, download, run } from "./host"
import { media } from "./paths"

const ASSETS = resolve(import.meta.dir, "assets")

/**
 * A 64 MB FAT volume the guest writes its provisioning transcript to, and the
 * host mounts afterwards. Also carries startup.nsh: the UEFI shell auto-runs it
 * from a volume it can see, and this FAT image is mapped earlier than the
 * hdiutil-built ISO9660 seed.
 */
export function makeResultVolume(dest: string): void {
  if (existsSync(dest)) return
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
