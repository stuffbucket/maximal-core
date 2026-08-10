/**
 * Instance lifecycle: create, reset, destroy.
 *
 * An instance is a thin qcow2 OVERLAY whose backing file is a base image. That
 * one choice is what makes reset instant, concurrency free, and disk cost
 * proportional to what changed rather than to a whole Windows install.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

import { FIRMWARE_VARS, run } from "./host"
import { makeResultVolume } from "./media"
import type { InstanceMeta, Paths } from "./paths"
import { allocateVnc, basePath, pathsFor, readMeta } from "./paths"

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
  if (readMeta(name) !== null) return p

  if (!existsSync(basePath(image))) {
    console.error(
      `::error::no base image "${image}". Build one with \`winvm build --iso <win11.iso>\`, ` +
        "or adopt an installed disk with `winvm adopt <disk.qcow2>`.",
    )
    process.exit(1)
  }
  mkdirSync(p.tpmDir, { recursive: true })
  createOverlay(p, image)
  copyFileSync(FIRMWARE_VARS, p.vars)
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
  copyFileSync(FIRMWARE_VARS, p.vars)
  rmSync(p.tpmDir, { recursive: true, force: true })
  mkdirSync(p.tpmDir, { recursive: true })
  rmSync(p.result, { force: true })
  makeResultVolume(p.result)
}
