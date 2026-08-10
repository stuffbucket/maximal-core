/**
 * Where everything lives, and nothing else.
 *
 * Kept apart from the code that uses it because the layout is the part most
 * likely to be reasoned about on its own — "which file is the base image, and
 * can two consumers collide?" — and because pure path computation is the part
 * worth testing without a hypervisor present.
 *
 * NOTHING here reads a manifest, a version file, or anything else belonging to
 * a project that happens to host this tool. The only inputs are environment
 * variables and explicit arguments.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

/**
 * All state, deliberately outside any project directory: a base image is tens
 * of GB, and some repositories force-track build output, so an accidental
 * `git add` is expensive and hard to undo.
 */
export function home(): string {
  const override = process.env["WINVM_HOME"]
  if (override !== undefined && override !== "") return resolve(override)
  return resolve(homedir(), ".local/state/winvm")
}

export const imagesDir = (): string => resolve(home(), "images")
export const instancesDir = (): string => resolve(home(), "instances")
export const mediaDir = (): string => resolve(home(), "media")

export const imageDir = (image: string): string => resolve(imagesDir(), image)
export const basePath = (image: string): string => resolve(imageDir(image), "base.qcow2")
export const instanceDir = (name: string): string => resolve(instancesDir(), name)

export const media = {
  iso: (): string => resolve(mediaDir(), "windows-arm64.iso"),
  tools: (): string => resolve(mediaDir(), "utm-guest-tools.iso"),
  seed: (): string => resolve(mediaDir(), "seed.iso"),
  seedDir: (): string => resolve(mediaDir(), "seed"),
} as const

/** Every per-instance file. One instance never touches another's. */
export interface Paths {
  readonly dir: string
  readonly overlay: string
  readonly vars: string
  readonly tpmDir: string
  readonly tpmSock: string
  readonly qga: string
  readonly qmp: string
  readonly pid: string
  readonly serial: string
  readonly result: string
  readonly meta: string
}

export function pathsFor(name: string): Paths {
  const dir = instanceDir(name)
  return {
    dir,
    overlay: resolve(dir, "overlay.qcow2"),
    vars: resolve(dir, "efi-vars.fd"),
    tpmDir: resolve(dir, "tpm"),
    tpmSock: resolve(dir, "tpm/swtpm-sock"),
    qga: resolve(dir, "qga.sock"),
    qmp: resolve(dir, "qmp.sock"),
    pid: resolve(dir, "qemu.pid"),
    serial: resolve(dir, "serial.log"),
    result: resolve(dir, "result.img"),
    meta: resolve(dir, "instance.json"),
  }
}

export interface InstanceMeta {
  readonly image: string
  /** VNC display number; the port is 5900 + this. Assigned once, at creation. */
  readonly vnc: number
  readonly created: string
}

export function readMeta(name: string): InstanceMeta | null {
  const f = pathsFor(name).meta
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, "utf8")) as InstanceMeta
}

export function listInstances(): readonly string[] {
  if (!existsSync(instancesDir())) return []
  return readdirSync(instancesDir()).filter((d) => existsSync(pathsFor(d).meta))
}

export function listImages(): readonly string[] {
  if (!existsSync(imagesDir())) return []
  return readdirSync(imagesDir()).filter((d) => existsSync(basePath(d)))
}

/**
 * Lowest display not already claimed. Without this, two instances started
 * independently would both take :1 and the second would fail to bind — the
 * kind of collision that only shows up when someone finally runs two at once.
 */
export function allocateVnc(): number {
  const taken = new Set(listInstances().map((n) => readMeta(n)?.vnc))
  for (let i = 1; i < 100; i += 1) if (!taken.has(i)) return i
  throw new Error("no free VNC display")
}
