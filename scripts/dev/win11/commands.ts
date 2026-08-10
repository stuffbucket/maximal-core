/**
 * The verbs. Each one is short enough to read in full; anything that needed
 * more room lives in a sibling module.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { imageName, instanceName } from "./args"
import { FIRMWARE_VARS, TOOLS_URL, download, du, hostChecks, requireHost, run } from "./host"
import { ensureInstance, resetInstance, sealBase } from "./instance"
import { buildSeed, makeResultVolume } from "./media"
import type { InstanceMeta } from "./paths"
import {
  allocateVnc,
  basePath,
  home,
  imageDir,
  instanceDir,
  listImages,
  listInstances,
  media,
  mediaDir,
  pathsFor,
  readMeta,
} from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"

const ISO_HELP =
  "https://www.microsoft.com/en-us/software-download/windows11arm64 " +
  "(multi-edition ARM64, no sign-in; the generated link expires after 24h)"

export function doctor(): number {
  const checks = hostChecks()
  for (const c of checks) console.log(`${c.ok ? "ok  " : "MISS"}  ${c.label}${c.ok ? "" : `  -> ${c.hint}`}`)
  const missing = checks.filter((c) => !c.ok)
  console.log(missing.length === 0 ? `\nhost is ready · state: ${home()}` : `\n${missing.length} prerequisite(s) missing`)
  return missing.length === 0 ? 0 : 1
}

export function ls(): number {
  console.log(`state: ${home()}\n`)
  const images = listImages()
  console.log(images.length === 0 ? "images: (none — run `winvm build`)" : "images:")
  for (const i of images) console.log(`  ${i.padEnd(18)} ${du(basePath(i))}`)

  const names = listInstances()
  console.log(names.length === 0 ? "\ninstances: (none)" : "\ninstances:")
  for (const n of names) {
    const m = readMeta(n)
    const p = pathsFor(n)
    const pid = qemu.pidOf(p)
    const state = pid === null ? "stopped" : `running (pid ${String(pid)})`
    console.log(
      `  ${n.padEnd(18)} ${du(p.overlay).padEnd(7)} image=${m?.image ?? "?"} vnc=:${String(m?.vnc)} ${state}`,
    )
  }
  return 0
}

/**
 * Adopt an already-installed disk as a base image — how you avoid reinstalling
 * when a good guest already exists, and how a flat single-disk layout migrates
 * into base+overlay.
 */
export function adopt(args: Args): number {
  requireHost()
  const src = args.positional[0]
  if (src === undefined) {
    console.error("::error::usage: winvm adopt <disk.qcow2> [--image <name>]")
    return 1
  }
  const from = resolve(src)
  if (!existsSync(from)) {
    console.error(`::error::no such disk: ${from}`)
    return 1
  }
  const image = imageName(args)
  if (existsSync(basePath(image))) {
    console.error(`::error::image "${image}" already exists at ${basePath(image)}`)
    return 1
  }
  mkdirSync(imageDir(image), { recursive: true })
  // Rename rather than copy: these files are tens of GB, and a copy would need
  // the space twice over.
  if (run("mv", [from, basePath(image)]) !== 0) return 1
  sealBase(image)
  console.log(`adopted as image "${image}" (${du(basePath(image))}), now read-only`)
  return 0
}

export async function build(args: Args): Promise<number> {
  requireHost()
  const image = imageName(args)
  if (existsSync(basePath(image))) {
    console.error(`::error::image "${image}" already exists — use --image <other>, or remove it deliberately`)
    return 1
  }

  mkdirSync(mediaDir(), { recursive: true })
  const isoArg = args.flags.get("iso")
  if (isoArg !== undefined) {
    const src = resolve(isoArg)
    if (!existsSync(src)) {
      console.error(`::error::no such ISO: ${src}`)
      return 1
    }
    rmSync(media.iso(), { force: true })
    run("ln", ["-s", src, media.iso()]) // ~8 GB; never copy
  }
  if (!existsSync(media.iso())) {
    console.error(`::error::pass a Windows 11 ARM64 ISO: winvm build --iso <path>\n${ISO_HELP}`)
    return 1
  }

  download(TOOLS_URL, media.tools())
  buildSeed(args.flags.get("payload"), args.flags.get("bun"))

  // Build in a scratch instance so a failed install cannot leave a half-made
  // base image that later runs would happily use.
  const scratch = `build-${image}`
  const p = pathsFor(scratch)
  mkdirSync(p.tpmDir, { recursive: true })
  run("qemu-img", ["create", "-f", "qcow2", p.overlay, "64G"])
  copyFileSync(FIRMWARE_VARS, p.vars)
  makeResultVolume(p.result)
  const meta: InstanceMeta = { image, vnc: allocateVnc(), created: new Date().toISOString() }
  writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`installing Windows (unattended, ~20 min) · watch: vnc://127.0.0.1:${String(5900 + meta.vnc)}`)
  qemu.launch(scratch, p, meta, { installMedia: true, ephemeral: false })

  // provision.ps1 powers the guest off when it finishes; that is the signal.
  const deadline = Date.now() + 60 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000))
    if (!qemu.isRunning(p)) {
      mkdirSync(imageDir(image), { recursive: true })
      run("mv", [p.overlay, basePath(image)])
      sealBase(image)
      rmSync(p.dir, { recursive: true, force: true })
      console.log(`base image ready: ${basePath(image)} (${du(basePath(image))})\nnext: winvm start`)
      return 0
    }
  }
  console.error(`::error::install did not finish within an hour — see ${p.serial}`)
  return 1
}

export async function start(args: Args): Promise<number> {
  requireHost()
  const name = instanceName(args)
  const p = pathsFor(name)
  if (qemu.isRunning(p)) {
    console.log(`instance "${name}" already running`)
    return 0
  }
  ensureInstance(name, imageName(args))
  const meta = readMeta(name)
  if (meta === null) return 1

  qemu.launch(name, p, meta, { installMedia: false, ephemeral: args.flags.has("ephemeral") })
  process.stdout.write("booting")
  const up = await qga.waitFor(p.qga, 300_000)
  process.stdout.write("\n")
  if (!up) {
    console.error(
      `::error::guest agent never answered. Look at vnc://127.0.0.1:${String(5900 + meta.vnc)} or ${p.serial}`,
    )
    return 1
  }
  console.log(`instance "${name}" up (vnc :${String(meta.vnc)})`)
  return 0
}

export async function stop(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.log(`instance "${name}" is not running`)
    return 0
  }
  await qga.shutdown(p.qga)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (!qemu.isRunning(p)) {
      console.log(`instance "${name}" stopped`)
      return 0
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.error("::error::guest did not shut down — `winvm kill` if it is wedged")
  return 1
}

export function kill(args: Args): number {
  const name = instanceName(args)
  const p = pathsFor(name)
  const pid = qemu.pidOf(p)
  if (pid === null) {
    console.log(`instance "${name}" is not running`)
    return 0
  }
  process.kill(pid, "SIGKILL")
  rmSync(p.pid, { force: true })
  console.log(`killed instance "${name}"`)
  return 0
}

export function reset(args: Args): number {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is running — stop it first`)
    return 1
  }
  const meta = readMeta(name)
  if (meta === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  resetInstance(name, meta)
  console.log(`instance "${name}" reset to image "${meta.image}"`)
  return 0
}

export function destroy(args: Args): number {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is running — stop it first`)
    return 1
  }
  if (readMeta(name) === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  rmSync(instanceDir(name), { recursive: true, force: true })
  console.log(`destroyed instance "${name}" (image untouched)`)
  return 0
}

export async function exec(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running — \`winvm start -i ${name}\``)
    return 1
  }
  const argv = args.rest.length > 0 ? args.rest : args.positional
  const [program, ...rest] = argv
  if (program === undefined) {
    console.error("::error::usage: winvm exec [-i name] -- <program> [args...]")
    return 1
  }
  const r = await qga.exec(p.qga, program, rest)
  if (r.stdout !== "") process.stdout.write(r.stdout)
  if (r.stderr !== "") process.stderr.write(r.stderr)
  return r.exitcode
}

/**
 * Report what the guest is, and optionally assert a staged tool's version.
 *
 * The expectation is supplied BY THE CALLER (`--expect`, or `--expect-file`
 * naming a file relative to the working directory). This tool reads no project
 * file of its own — that is what keeps it usable outside a repository.
 */
export async function smoke(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running`)
    return 1
  }
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const arch = await qga.exec(p.qga, ps, ["-NoProfile", "-Command", "$env:PROCESSOR_ARCHITECTURE"])
  console.log(`guest arch -> ${arch.stdout.trim()}`)

  const probe = args.flags.get("probe") ?? "C:\\payload\\bun-windows-aarch64\\bun.exe"
  const versionArg = args.flags.get("version-arg") ?? "--version"
  const got = (
    await qga.exec(p.qga, ps, [
      "-NoProfile",
      "-Command",
      `if (Test-Path '${probe}') { & '${probe}' ${versionArg} } else { 'absent' }`,
    ])
  ).stdout.trim()

  let expected = args.flags.get("expect")
  const expectFile = args.flags.get("expect-file")
  if (expected === undefined && expectFile !== undefined) {
    const f = resolve(expectFile)
    if (!existsSync(f)) {
      console.error(`::error::--expect-file ${f} does not exist`)
      return 1
    }
    expected = readFileSync(f, "utf8").trim()
  }

  console.log(`guest probe -> ${got}${expected === undefined ? "" : ` (expected ${expected})`}`)
  if (expected !== undefined && got !== expected) {
    console.error(`::error::guest reported ${got}, expected ${expected}`)
    return 1
  }
  return 0
}

export const USAGE =
  "winvm <command>\n\n" +
  "  doctor                        check host prerequisites\n" +
  "  build --iso <win11.iso>       build a base image (once, ~20 min)\n" +
  "        [--payload <dir>] [--bun <version>] [--image <name>]\n" +
  "  adopt <disk.qcow2>            adopt an installed disk as a base image\n" +
  "  ls                            images and instances, with disk usage\n" +
  "  start   [-i name] [--ephemeral]\n" +
  "  exec    [-i name] -- <cmd>    run a command in the guest\n" +
  "  smoke   [-i name] [--expect <v> | --expect-file <path>] [--probe <exe>]\n" +
  "  reset   [-i name]             discard changes, back to the base image\n" +
  "  stop | kill | destroy [-i name]\n\n" +
  "  state:    WINVM_HOME       (default ~/.local/state/winvm)\n" +
  "  instance: WINVM_INSTANCE / -i   (default \"default\")\n" +
  "  image:    WINVM_IMAGE / --image (default \"win11-arm64\")\n"
