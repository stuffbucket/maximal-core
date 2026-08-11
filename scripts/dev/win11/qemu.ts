/**
 * The QEMU command line, and the process lifecycle around it.
 *
 * Every device below is a decision with a reason; most were derived from UTM's
 * source, which is the best available record of what actually works for a
 * Windows ARM64 guest on Apple Silicon. Changing one of these is how a guest
 * stops booting, so the reasons are recorded inline rather than in a commit
 * message nobody will find.
 */
import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from "node:fs"

import { FIRMWARE } from "./host"
import type { InstanceMeta, Paths } from "./paths"
import { media } from "./paths"

export interface LaunchOptions {
  /** Attach the Windows ISO, guest tools and seed. Only a base build needs them. */
  readonly installMedia: boolean
  /** QEMU `-snapshot`: even the overlay is left untouched and the run is discarded. */
  readonly ephemeral: boolean
  /**
   * Boot the disk on virtio-blk instead of NVMe. Only images whose guest has
   * viostor as a boot-start driver can do this — see ImageMeta.virtioBoot.
   */
  readonly virtioBoot: boolean
  /** Resume straight into a saved VM state instead of booting. */
  readonly loadvm?: string
}

export function qemuArgs(name: string, p: Paths, meta: InstanceMeta, o: LaunchOptions): readonly string[] {
  // BOOT ORDER IS LOAD-BEARING DURING A BUILD. The install CD must come first;
  // give the (empty) disk index 0 and EDK2 tries it, fails, and drops to a UEFI
  // shell *before* USB enumeration has produced any filesystem — the mapping
  // table shows the NVMe block device and nothing else, so startup.nsh is not
  // even found, let alone run. Once installed, the disk is the boot device and
  // the CDs are gone.
  const diskBootIndex = o.installMedia ? 1 : 0
  const a: string[] = [
    "-name", `winvm-${name}`,
    "-machine", "virt,accel=hvf",
    // `host` under HVF is what UTM uses for this guest. `max` falls back to TCG
    // for features HVF cannot provide, and boots far slower.
    "-cpu", "host",
    "-smp", "4",
    "-m", "4096",
    "-drive", `if=pflash,format=raw,readonly=on,file=${FIRMWARE}`,
    // QCOW2, not the raw vars image. A writable raw device blocks `savevm` for
    // the entire machine — see Paths.vars.
    "-drive", `if=pflash,format=qcow2,file=${p.vars}`,
    // qemu-xhci, NOT nec-usb-xhci. QEMU's own documentation recommends XHCI for
    // any guest since ~2010 and spells the device `qemu-xhci`
    // <https://qemu-project.gitlab.io/qemu/system/devices/usb.html>; the NEC
    // model is the legacy one and carries an open upstream bug, "usb3:
    // nec-usb-xhci broken", reported as unwell since QEMU 5.2 and still open
    // against 10.x <https://gitlab.com/qemu-project/qemu/-/issues/3241>.
    //
    // This is not cosmetic. On nec-usb-xhci the guest hung on its SECOND boot,
    // spinning a full core inside EDK2's USB stack with the firmware console
    // stopped dead on `UsbBootExecCmd: Success to Exec 0x0 Cmd (Result = 1)` and
    // never reaching a boot target. It reproduced on a build and on a plain
    // instance, and it was the real source of what looked like random
    // flakiness elsewhere.
    "-device", "qemu-xhci,id=usb-bus",
    // THE BOOT DISK CHANGES BUS BETWEEN INSTALLING AND RUNNING, and both halves
    // are load-bearing.
    //
    // NVMe while installing: Windows 11 ARM64 has an in-box NVMe driver
    // (stornvme.sys), so Setup sees the disk with nothing injected. WinPE has no
    // virtio-blk driver at all, so installing onto virtio would mean injecting
    // viostor at windowsPE, and a <DriverPaths> entry names a drive letter that
    // WinPE assigns by enumeration order. (It is also why a virtio disk attached
    // during a build cannot disturb the answer file's DiskID 0: WinPE cannot see
    // it.)
    //
    // virtio-blk while running: the nvme device model has NO migration support
    // — `savevm` fails with "Device '...nvme' is non-migratable" — so live
    // snapshots are impossible on NVMe. The build primes viostor as a boot-start
    // driver (see Paths.prime) precisely so the finished image can run here.
    "-drive", `if=none,media=disk,id=hd0,file=${p.overlay}`,
    ...(o.virtioBoot
      ? ["-device", `virtio-blk-pci,drive=hd0,bootindex=${String(diskBootIndex)}`]
      : ["-device", `nvme,drive=hd0,serial=winvm,bootindex=${String(diskBootIndex)}`]),
    "-device", "usb-kbd,bus=usb-bus.0",
    "-device", "usb-tablet,bus=usb-bus.0",
    // Windows 11 ARM64 has no in-box virtio-net driver; NetKVM arrives with the
    // guest tools, after which this gives the guest real outbound internet.
    "-netdev", "user,id=net0",
    "-device", "virtio-net-pci,netdev=net0",
    // The command channel. See qga.ts.
    "-device", "virtio-serial",
    "-chardev", `socket,path=${p.qga},server=on,wait=off,id=qga0`,
    "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
    "-chardev", `socket,id=chrtpm,path=${p.tpmSock}`,
    "-tpmdev", "emulator,id=tpm0,chardev=chrtpm",
    // tpm-tis-device, not UTM's tpm-crb-device: Homebrew's QEMU builds only the
    // TIS model for aarch64. Verified equivalent here — with swtpm attached the
    // firmware enumerates all four PCR banks either way.
    "-device", "tpm-tis-device,tpmdev=tpm0",
    // Windows expects local time in the RTC; without this the guest clock is
    // wrong by the host's UTC offset.
    "-rtc", "base=localtime",
    // A UEFI-GOP framebuffer, so there is a picture before any driver loads.
    // Deliberately not virtio-gpu, which needs viogpudo — UTM's own docs report
    // that driver black-screening recent Windows 11.
    "-device", "ramfb",
    "-display", "none",
    "-vnc", `127.0.0.1:${String(meta.vnc)}`,
    "-qmp", `unix:${p.qmp},server=on,wait=off`,
    "-serial", `file:${p.serial}`,
    "-pidfile", p.pid,
  ]
  if (o.ephemeral) a.push("-snapshot")
  if (o.loadvm !== undefined) a.push("-loadvm", o.loadvm)
  if (o.installMedia) {
    a.push(
      // USB STORAGE IS ONLY ATTACHED WHILE INSTALLING, and the device lines
      // follow Linaro's published reference for a Windows ARM64 guest on
      // qemu-system-aarch64 — `usb-storage` + `media=cdrom` on a qemu-xhci bus,
      // with NO `removable=` flag
      // <https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system>.
      //
      // A RUNNING INSTANCE NOW HAS NO USB STORAGE AT ALL. The result volume used
      // to be attached to every boot, and EDK2 hung enumerating it: the firmware
      // console stopped dead on `UsbBootExecCmd: Success to Exec 0x0 Cmd
      // (Result = 1)` with a core pegged and no boot target ever chosen. That was
      // seen on a plain instance carrying only that one USB disk, so it is not a
      // matter of how many are attached. An instance does not need the volume —
      // its answer file and transcript matter only during a build, and the
      // firmware finds Windows Boot Manager on the ESP without a shell selector.
      "-drive", `if=none,media=disk,id=res0,format=raw,file=${p.result}`,
      "-device", "usb-storage,drive=res0,removable=true,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd0,file=${media.iso()},readonly=on`,
      "-device", "usb-storage,drive=cd0,bootindex=0,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd1,file=${media.tools()},readonly=on`,
      "-device", "usb-storage,drive=cd1,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd2,file=${media.seed()},readonly=on`,
      "-device", "usb-storage,drive=cd2,bus=usb-bus.0",
      // The scratch virtio-blk device whose only job is to exist, so PnP installs
      // viostor and marks it boot-start. See Paths.prime.
      "-drive", `if=none,media=disk,id=prime0,file=${p.prime}`,
      "-device", "virtio-blk-pci,drive=prime0",
    )
  }
  return a
}

async function startSwtpm(p: Paths): Promise<void> {
  if (existsSync(p.tpmSock) && spawnSync("pgrep", ["-f", `swtpm socket .*${p.tpmDir}`]).status === 0) return
  // A socket file with no process behind it is what a killed swtpm leaves, and
  // binding over one fails. Clear it rather than inherit the previous failure.
  rmSync(p.tpmSock, { force: true })
  const proc = spawn(
    "swtpm",
    ["socket", "--tpmstate", `dir=${p.tpmDir}`, "--ctrl", `type=unixio,path=${p.tpmSock}`, "--tpm2"],
    { detached: true, stdio: "ignore" },
  )
  proc.unref()

  // WAIT FOR THE SOCKET TO EXIST. Measured here, swtpm needs ~15 ms to bind it,
  // and QEMU connects to this path while parsing its own command line — so
  // returning immediately is a coin flip that QEMU sometimes loses, and loses
  // more often under load. It does not degrade: a chardev that cannot connect
  // aborts the launch outright (see below).
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(p.tpmSock)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`swtpm never created ${p.tpmSock} — check \`winvm doctor\``)
}

/**
 * Start the guest, and confirm it actually started.
 *
 * THE CONFIRMATION IS THE POINT. QEMU validates its command line and connects
 * its chardevs during startup, and reports failure by printing one line to
 * stderr and **exiting 0** — verified here with an unreachable TPM socket. This
 * used to be spawned detached with `stdio: "ignore"` and no check at all, which
 * made a launch that never happened indistinguishable from a slow boot: `start`
 * waited out its five-minute agent timeout and then blamed the guest agent, and
 * `build` saw "not running" on its first poll and promoted an empty disk to a
 * sealed base image.
 *
 * Throws if the guest is gone within a couple of seconds, with QEMU's own words.
 */
export async function launch(name: string, p: Paths, meta: InstanceMeta, o: LaunchOptions): Promise<void> {
  await startSwtpm(p)
  // Rotate rather than delete: the usual response to a bad boot is another boot,
  // and truncating here would erase the evidence being retried.
  if (existsSync(p.serial)) renameSync(p.serial, p.serialPrev)
  rmSync(p.qemuLog, { force: true })

  const log = openSync(p.qemuLog, "w")
  const proc = spawn("qemu-system-aarch64", [...qemuArgs(name, p, meta, o)], {
    detached: true,
    stdio: ["ignore", log, log],
  })
  closeSync(log)
  proc.unref()

  const exited = new Promise<"exited">((res) => proc.on("exit", () => res("exited")))
  let timer: ReturnType<typeof setTimeout> | undefined
  const survived = new Promise<"alive">((res) => {
    timer = setTimeout(() => res("alive"), 2000)
  })
  const outcome = await Promise.race([exited, survived])
  clearTimeout(timer)
  if (outcome === "alive") return

  const why = existsSync(p.qemuLog) ? readFileSync(p.qemuLog, "utf8").trim() : ""
  throw new Error(`qemu exited immediately${why === "" ? "" : `:\n  ${why.split("\n").join("\n  ")}`}`)
}

/**
 * Wait for a line to appear on the guest's firmware console.
 *
 * The serial log is the only channel that exists before the guest agent does,
 * which makes it the only way to observe the firmware as an EVENT rather than
 * guessing at it with a clock. Used to know when the install media's boot
 * prompt is imminent — see startup.nsh and qmp.tapEnter.
 *
 * Read as latin1 on purpose: the firmware emits ANSI escapes and NUL padding,
 * and a UTF-8 decode of that mangles the very bytes being matched.
 */
export async function waitForSerial(p: Paths, marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(p.serial) && readFileSync(p.serial, "latin1").replaceAll("\0", "").includes(marker)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * Per-instance, via QEMU's own pidfile — deliberately NOT a `pgrep
 * qemu-system-aarch64` pattern match. A global match is how one consumer ends
 * up reporting, or stopping, another's VM; an earlier version of this tool had
 * exactly that bug.
 */
export function pidOf(p: Paths): number | null {
  if (!existsSync(p.pid)) return null
  const pid = Number.parseInt(readFileSync(p.pid, "utf8").trim(), 10)
  if (!Number.isFinite(pid)) return null
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0)
    return pid
  } catch {
    // Stale pidfile from a crash or a reboot.
    rmSync(p.pid, { force: true })
    return null
  }
}

export const isRunning = (p: Paths): boolean => pidOf(p) !== null
