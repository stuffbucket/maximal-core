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
import { existsSync, readFileSync, rmSync } from "node:fs"

import { FIRMWARE } from "./host"
import type { InstanceMeta, Paths } from "./paths"
import { media } from "./paths"

export interface LaunchOptions {
  /** Attach the Windows ISO, guest tools and seed. Only a base build needs them. */
  readonly installMedia: boolean
  /** QEMU `-snapshot`: even the overlay is left untouched and the run is discarded. */
  readonly ephemeral: boolean
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
    "-drive", `if=pflash,format=raw,file=${p.vars}`,
    "-device", "nec-usb-xhci,id=usb-bus",
    // NVMe, NOT virtio-blk. Windows 11 ARM64 has an in-box NVMe driver
    // (stornvme.sys), so Setup sees the disk with nothing injected. UTM's wizard
    // special-cases aarch64+Windows to NVMe for exactly this reason, overriding
    // the virtio default it uses everywhere else. Choosing virtio here would
    // mean injecting viostor at windowsPE, which pins a WinPE drive letter.
    "-drive", `if=none,media=disk,id=hd0,file=${p.overlay}`,
    "-device", `nvme,drive=hd0,serial=winvm,bootindex=${String(diskBootIndex)}`,
    "-drive", `if=none,media=disk,id=res0,format=raw,file=${p.result}`,
    "-device", "usb-storage,drive=res0,removable=true,bus=usb-bus.0",
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
  if (o.installMedia) {
    a.push(
      "-drive", `if=none,media=cdrom,id=cd0,file=${media.iso()},readonly=on`,
      "-device", "usb-storage,drive=cd0,removable=true,bootindex=0,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd1,file=${media.tools()},readonly=on`,
      "-device", "usb-storage,drive=cd1,removable=true,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd2,file=${media.seed()},readonly=on`,
      "-device", "usb-storage,drive=cd2,removable=true,bus=usb-bus.0",
    )
  }
  return a
}

function startSwtpm(p: Paths): void {
  if (existsSync(p.tpmSock) && spawnSync("pgrep", ["-f", `swtpm socket .*${p.tpmDir}`]).status === 0) return
  const proc = spawn(
    "swtpm",
    ["socket", "--tpmstate", `dir=${p.tpmDir}`, "--ctrl", `type=unixio,path=${p.tpmSock}`, "--tpm2"],
    { detached: true, stdio: "ignore" },
  )
  proc.unref()
}

export function launch(name: string, p: Paths, meta: InstanceMeta, o: LaunchOptions): void {
  startSwtpm(p)
  rmSync(p.serial, { force: true })
  const proc = spawn("qemu-system-aarch64", [...qemuArgs(name, p, meta, o)], {
    detached: true,
    stdio: "ignore",
  })
  proc.unref()
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
