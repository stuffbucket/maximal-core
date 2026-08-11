# Third-party software in `scripts/dev/win11/`

This directory redistributes some third-party software and downloads more at
run time. Notices for both are here rather than in the repository-root
`THIRD-PARTY-LICENSE`, because this tool is self-contained and meant to be
copied out on its own — its obligations should travel with it.

---

## Redistributed here

### TianoCore EDK2 UEFI firmware — `firmware/`

`firmware/edk2-aarch64-code.fd.gz` and `firmware/edk2-arm-vars.fd.gz` are the
AArch64 UEFI firmware images QEMU ships, stored gzipped (they are ~99% zero
padding: 128 MiB becomes 1.6 MB) and expanded into the state directory on first
use.

- Copyright (c) 2019, TianoCore and contributors. All rights reserved.
- **SPDX-License-Identifier: BSD-2-Clause-Patent**
- Full text: [`firmware/edk2-licenses.txt`](firmware/edk2-licenses.txt)

Binary redistribution is permitted provided the copyright notice, this list of
conditions and the disclaimer are reproduced — which is what this file and
`edk2-licenses.txt` do.

They are vendored so the harness does not depend on where a particular QEMU
packaging put its data files. Set `WINVM_QEMU_DATA` to use a system copy instead.

---

## Downloaded at run time, NOT redistributed here

### UTM guest tools — `utm-guest-tools-latest.iso`

Fetched by `winvm build` / `winvm setup` from
<https://getutm.app/downloads/utm-guest-tools-latest.iso> into the state
directory, and pinned by SHA-256 (see `TOOLS_SHA256` in `host.ts`).

**Deliberately not vendored.** The ISO is ~121 MB and does not compress (its
payload is already compressed), and its installer carries `qemu-ga`, which is
**GPL-2.0**. Redistributing that would oblige this project to make the
corresponding source available for as long as it ships the binary — a standing
duty for what is only a developer test fixture. Downloading it at run time
leaves the user obtaining it directly from upstream, as they would any tool.

The ISO itself carries:

- **virtio-win drivers** — Copyright Red Hat, Inc.; Google, Inc.; Virtuozzo,
  Inc.; IBM Corporation. Redistributable in binary form under a BSD-style
  three-clause licence; the full text ships on the ISO as
  `virtio-win_license.txt`.
- **`utm-guest-tools-*.exe`** — the UTM guest tools installer, which bundles
  `qemu-ga` (**GPL-2.0**, © the QEMU authors). Source for QEMU is at
  <https://gitlab.com/qemu-project/qemu>.

### Windows 11 ARM64 installation media

Never redistributed and never cached by this tool. The user supplies their own
ISO with `winvm build --iso`, under Microsoft's own licence terms; the harness
symlinks it rather than copying it.
