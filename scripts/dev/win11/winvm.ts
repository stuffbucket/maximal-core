#!/usr/bin/env bun
/**
 * winvm — a scriptable Windows 11 ARM64 guest on plain QEMU + Hypervisor.framework.
 *
 *   winvm doctor                     check host prerequisites
 *   winvm build --iso <win11.iso>    build the golden base image (~20 min, once)
 *   winvm adopt <disk.qcow2>         turn an existing installed disk into a base
 *   winvm start [-i name]            boot an instance (creating it if absent)
 *   winvm exec  [-i name] -- <cmd>   run a command in the guest
 *   winvm reset [-i name]            discard all changes, back to the base
 *   winvm ls                         images and instances, with disk usage
 *
 * ## Self-contained and project-agnostic, on purpose
 *
 * THIS DIRECTORY IS THE WHOLE TOOL. Copy `scripts/dev/win11/` anywhere — another
 * repository, or no repository at all — and it works. It reads no manifest, no
 * version file, and nothing else belonging to whatever happens to host it.
 * Everything project-specific is passed in: what to stage in the guest
 * (`--payload`), and what version to assert (`--expect` / `--expect-file`).
 *
 * An earlier version of this tool did not hold that line — it read
 * `../../.bun-version` and keyed its state directory on one project's name — and
 * the result was an uncaught `ENOENT` anywhere else plus two consumers silently
 * sharing a single 26 GB disk image.
 *
 * ## One base image, many thin instances
 *
 * A Windows install is ~26 GB, so a copy per consumer is not viable. The base is
 * built once and never written again; each instance is a qcow2 OVERLAY backed by
 * it, storing only its own deltas — megabytes for a boot, not gigabytes.
 *
 * Three properties fall out of that, which is why it is the design rather than
 * an optimisation:
 *
 *   - RESET is `rm overlay && qemu-img create`: instant, and exactly the base
 *     state, with no reinstall.
 *   - CONCURRENCY is free. Instances share one base, never touch each other, and
 *     each gets its own overlay, firmware vars, TPM state, sockets and VNC
 *     display.
 *   - DEBUGGING survives. An instance persists across stop/start, so a broken
 *     guest can be inspected and reset only when you are done with it.
 *
 * `--ephemeral` adds QEMU's `-snapshot`, so even the overlay is untouched and
 * the whole run is discarded on exit.
 *
 * ## Layout
 *
 *   winvm.ts      this file — argument dispatch only
 *   commands.ts   the verbs
 *   paths.ts      state layout and instance metadata
 *   host.ts       prerequisites, shelling out, downloads
 *   qemu.ts       the QEMU command line and process lifecycle
 *   qga.ts        guest-agent client (the scriptable channel)
 *   media.ts      seed ISO and result volume
 *   instance.ts   create / reset / seal
 *   assets/       answer file, provisioning script, UEFI boot selector
 *
 * See docs/dev/windows-vm-qemu.md for the reasoning behind the device choices.
 *
 * Exit code: the guest command's, so `winvm exec` is transparent in a `&&` chain.
 */
import { parseArgs } from "./args"
import * as commands from "./commands"

const [, , sub, ...rawArgs] = process.argv
const args = parseArgs(rawArgs)

switch (sub) {
  case "doctor":
    process.exit(commands.doctor())
  // eslint-disable-next-line no-fallthrough
  case "ls":
  case "list":
    process.exit(commands.ls())
  // eslint-disable-next-line no-fallthrough
  case "adopt":
    process.exit(commands.adopt(args))
  // eslint-disable-next-line no-fallthrough
  case "build":
    process.exit(await commands.build(args))
  // eslint-disable-next-line no-fallthrough
  case "start":
    process.exit(await commands.start(args))
  // eslint-disable-next-line no-fallthrough
  case "stop":
    process.exit(await commands.stop(args))
  // eslint-disable-next-line no-fallthrough
  case "kill":
    process.exit(commands.kill(args))
  // eslint-disable-next-line no-fallthrough
  case "reset":
    process.exit(commands.reset(args))
  // eslint-disable-next-line no-fallthrough
  case "destroy":
    process.exit(commands.destroy(args))
  // eslint-disable-next-line no-fallthrough
  case "exec":
    process.exit(await commands.exec(args))
  // eslint-disable-next-line no-fallthrough
  case "smoke":
    process.exit(await commands.smoke(args))
  // eslint-disable-next-line no-fallthrough
  default:
    console.error(commands.USAGE)
    process.exit(2)
}
