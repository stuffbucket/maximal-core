echo -off
#
# UEFI shell boot selector for maximal-core's Windows test VM.
#
# WHY THIS EXISTS. EDK2's own boot manager tries the install CD, gets the
# "Press any key to boot from CD or DVD" prompt, and — with no key pressed —
# bootmgr returns EFI_TIMEOUT. EDK2 then walks every remaining option (other USB
# devices, NVMe, PXE v4/v6, HTTP v4/v6, each with its own timeout) before
# dropping to this shell. That is minutes of wall clock, and on the far side the
# machine has still not booted.
#
# This script runs automatically from the writable volume and picks a target
# deterministically instead:
#
#   1. An INSTALLED Windows, if one exists. Checked FIRST and that ordering is
#      load-bearing: Windows Setup reboots several times mid-install, and a
#      selector that always preferred the installer would restart setup from
#      scratch on every one of those reboots — an infinite install loop.
#   2. `cdboot_noprompt.efi`, Microsoft's own no-keypress variant of the CD
#      loader, shipped on the retail ISO next to `cdboot.efi`.
#   3. The ISO-root `bootmgfw.efi` as a last resort.
#
# TWO SYNTAX TRAPS, both of which cost an install cycle here:
#   - `if exist` needs the drive prefix INLINE (`if exist fs1:\path`), but
#   - you cannot EXECUTE a drive-prefixed path as one token. The volume change
#     must be its own statement, then `cd`, then the bare image name.
#
for %d in 0 1 2 3 4 5
  if exist fs%d:\EFI\Microsoft\Boot\bootmgfw.efi then
    echo booting installed Windows from fs%d
    fs%d:
    cd \EFI\Microsoft\Boot
    bootmgfw.efi
  endif
endfor
for %d in 0 1 2 3 4 5
  if exist fs%d:\efi\microsoft\boot\cdboot_noprompt.efi then
    echo booting installer (noprompt) from fs%d
    fs%d:
    cd \efi\microsoft\boot
    cdboot_noprompt.efi
  endif
endfor
#
# LAST, AND THE ONE THAT ACTUALLY WORKS. `cdboot_noprompt.efi` above is only
# valid as an El Torito boot image; launched from the shell it returns
# `Invalid Parameter` and falls through. `BOOTAA64.EFI` does boot, but it is
# `cdboot.efi` and prints "Press any key to boot from CD or DVD", returning
# EFI_TIMEOUT if nothing answers.
#
# That keypress is the host's job, and the line below is the HANDSHAKE that
# makes it deterministic: winvm watches the firmware console for
# `winvm-keypress-needed` and only then sends a small, bounded number of Enters.
# It is printed here, immediately before the one image that asks for a key,
# because this is the only moment the host can know the prompt is imminent —
# the prompt itself is drawn on the graphical console and never reaches serial.
#
# THE VERSION WITHOUT THIS HANDSHAKE FAILED, AND FAILED INTERMITTENTLY. The host
# used to hold Enter down from power-on until the disk grew past 300 MB, which
# is ~250 keystrokes for a prompt that consumes exactly one. The surplus sat in
# the keyboard buffer and was delivered later to Windows Setup's GUI, where
# Enter lands on Cancel and opens "Are you sure you want to quit?" — freezing
# the install at 10% with no error anywhere. Stopping the sender earlier cannot
# fix that: the keys are already queued.
#
# Do not "simplify" by deleting this loop because the noprompt one looks
# tidier: on this firmware the install CD is never registered as a boot option
# at all, so the shell is the ONLY path to the installer.
for %d in 0 1 2 3 4 5
  if exist fs%d:\EFI\BOOT\BOOTAA64.EFI then
    echo booting installer (bootaa64, expects a keypress) from fs%d
    echo winvm-keypress-needed
    fs%d:
    cd \EFI\BOOT
    BOOTAA64.EFI
  endif
endfor
echo winvm: no bootable target found
