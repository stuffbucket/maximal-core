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
for %d in 0 1 2 3 4 5
  if exist fs%d:\bootmgfw.efi then
    echo booting installer (bootmgfw) from fs%d
    fs%d:
    cd \
    bootmgfw.efi
  endif
endfor
echo maximal-core: no bootable target found
