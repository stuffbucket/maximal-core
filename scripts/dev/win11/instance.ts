/**
 * Instance lifecycle: create, reset, destroy.
 *
 * An instance is a thin qcow2 OVERLAY whose backing file is a base image. That
 * one choice is what makes reset instant, concurrency free, and disk cost
 * proportional to what changed rather than to a whole Windows install.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { requireFirmware, run } from "./host"
import { makeResultVolume } from "./media"
import type { InstanceMeta, Paths } from "./paths"
import { allocateVnc, basePath, pathsFor, readMeta } from "./paths"

/**
 * Firmware variables as qcow2, converted from the raw image QEMU ships.
 *
 * A copy would be simpler and is what this used to do, but a writable RAW
 * pflash makes the whole machine unsnapshottable — `savevm` reports "Device
 * 'pflash1' is writable but does not support snapshots" and refuses. The
 * conversion preserves the 64 MiB virtual size, which pflash requires.
 */
export function makeVars(dest: string): void {
  rmSync(dest, { force: true })
  run("qemu-img", ["convert", "-f", "raw", "-O", "qcow2", requireFirmware().vars, dest])
}

/**
 * Make a base image read-only. NOT ceremony: writing to a backing file while
 * overlays reference it silently corrupts every one of them, and the damage
 * surfaces later, elsewhere, as an unbootable guest.
 */
export function sealBase(image: string): void {
  chmodSync(basePath(image), 0o444)
}

function createOverlay(p: Paths, image: string): void {
  // Absolute backing path, so the instance keeps working regardless of the
  // process working directory.
  run("qemu-img", ["create", "-f", "qcow2", "-b", basePath(image), "-F", "qcow2", p.overlay])
}

export function ensureInstance(name: string, image: string): Paths {
  const p = pathsFor(name)
  if (readMeta(name) !== null) {
    // Instances created before firmware variables moved to qcow2 still have the
    // raw file. Convert in place rather than fail to launch or, worse, silently
    // hand them a blank NVRAM and lose their boot entries.
    if (!existsSync(p.vars)) {
      const legacy = resolve(p.dir, "efi-vars.fd")
      if (existsSync(legacy)) {
        run("qemu-img", ["convert", "-f", "raw", "-O", "qcow2", legacy, p.vars])
        rmSync(legacy, { force: true })
      } else {
        makeVars(p.vars)
      }
    }
    return p
  }

  if (!existsSync(basePath(image))) {
    console.error(
      `::error::no base image "${image}". Build one with \`winvm build --iso <win11.iso>\`, ` +
        "or adopt an installed disk with `winvm adopt <disk.qcow2>`.",
    )
    process.exit(1)
  }
  mkdirSync(p.tpmDir, { recursive: true })
  createOverlay(p, image)
  makeVars(p.vars)
  makeResultVolume(p.result)
  const meta: InstanceMeta = { image, vnc: allocateVnc(), created: new Date().toISOString() }
  writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`)
  console.log(`created instance "${name}" from image "${image}" (vnc :${String(meta.vnc)})`)
  return p
}

/**
 * Back to exactly the base state, without a reinstall.
 *
 * Deleting the overlay is not sufficient on its own. Firmware variables and TPM
 * state live outside the disk image and persist across it: a guest that wrote
 * boot entries or sealed anything to the TPM is not truly back at the base
 * until those go too. The result volume is recreated so a stale transcript
 * cannot be mistaken for a fresh one.
 */
export function resetInstance(name: string, meta: InstanceMeta): void {
  const p = pathsFor(name)
  rmSync(p.overlay, { force: true })
  createOverlay(p, meta.image)
  makeVars(p.vars)
  rmSync(p.tpmDir, { recursive: true, force: true })
  mkdirSync(p.tpmDir, { recursive: true })
  rmSync(p.result, { force: true })
  makeResultVolume(p.result)
}
