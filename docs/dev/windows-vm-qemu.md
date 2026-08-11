# Windows 11 ARM64 test VM (QEMU)

A scriptable Windows guest on this Mac, for the class of bug that only appears
on Windows. Driven entirely from the shell — no GUI, no clicking.

```sh
brew install qemu swtpm                # host prerequisites
bun run winvm:doctor                   # verify them

# once: build the golden base image (~20 min)
bun scripts/dev/win11/winvm.ts build --iso ~/Downloads/Win11_ARM64.iso --bun 1.3.14

bun run winvm:start                    # boot an instance (creates it if absent)
bun run winvm:smoke                    # assert the staged bun matches .bun-version
bun run winvm:exec -- bun --version    # run anything in the guest

# rewind: back to a known-good guest in about a second, without rebooting
bun scripts/dev/win11/winvm.ts rewind          # back to "fresh"
bun scripts/dev/win11/winvm.ts snapshot ready  # or checkpoint your own

bun run winvm:reset                    # discard everything, back to the base image
bun run winvm:stop
bun run winvm:ls                       # images and instances, with disk usage
```

## Why this exists

`ci.yml`'s `windows` job is the only Windows this repo has, and it is a batch
loop: push, wait, read a log. Every Windows defect here was found that way —
a `prepare` script Bun's Windows shell could not parse (#38), a Windows-only
secrets-loader bug (#55), a SQLite handle leak that surfaces as `EBUSY` only
where an open handle locks the file (#71), a shebang fixture (#74), and a
`RegExp` built from an interpolated `os.tmpdir()` with the `u` flag — harmless
on POSIX, a hard `SyntaxError` on Windows. Each cost a push/CI round trip.

## The tool is not part of this project

`scripts/dev/win11/` is self-contained and project-agnostic. Copy the directory
anywhere — another repo, or no repo — and it works. It reads no manifest, no
version file, nothing belonging to whatever hosts it. Project-specific inputs
are passed in:

- `--payload <dir>` — files to stage inside the guest
- `--bun <version>` — convenience that fetches that exact Bun release asset
- `--expect-file <path>` / `--expect <v>` — what `smoke` should assert

That is why `winvm:smoke` in this repo is
`winvm.ts smoke --expect-file .bun-version`: the *caller* supplies the pin.

## One base image, many thin instances

A Windows install is ~15 GB, so a copy per consumer is not viable. The base is
built once and never written again; each instance is a qcow2 **overlay** backed
by it, holding only its own deltas.

Measured on this machine:

| | |
|---|---|
| base image | 15 GB, read-only |
| build, from an empty state dir | **~8 min** |
| first boot to a usable guest | **~35 s** (audit mode; no OOBE) |
| instance after first boot | ~200 MB, plus ~3 GB once it holds snapshots |
| `reset` (back to the base) | **1.3 s** |
| `snapshot` | **1.4 s** |
| `rewind` (back to a snapshot) | **~10 s, no reboot** |

`loadvm` itself takes well under a second; `rewind` spends the rest confirming
the guest answers again before it returns. That is deliberate — see the warning
about sleeping through a restore, below.

Three properties follow, which is why it is the design and not an optimisation:

- **Reset** is `rm overlay && qemu-img create` — instant, exactly the base
  state, no reinstall. Reset also discards firmware variables and TPM state,
  which live outside the disk image and would otherwise survive.
- **Concurrency** is free. Instances share one base and never touch each other;
  each gets its own overlay, firmware vars, TPM state, sockets and VNC display,
  allocated at creation. Verified by running two guests at once and confirming a
  file written in one is absent in the other.
- **Debugging survives.** An instance persists across stop/start, so you can
  inspect a broken guest and reset only when you are finished with it.

`--ephemeral` adds QEMU's `-snapshot`, so even the overlay is untouched and the
run is discarded on exit.

## Rewinding

`reset` returns an instance to the base image, which costs a full boot
afterwards. A **snapshot** is cheaper and more useful: it captures the running
machine — RAM included — and restoring one is not a reboot at all. The guest
resumes mid-instruction from where it was taken.

```sh
winvm start
winvm snapshot                  # capture "fresh" once the guest is how you want it
winvm exec -- <break things>
winvm rewind                    # ~0.7 s later the guest is clean and running
```

**Take the snapshot yourself, when the guest is settled.** `start` deliberately
does not do it for you. An earlier version snapshotted automatically on first
boot and it was wrong twice over: `fresh` captured a machine that was still
starting, and freezing a half-booted Windows **livelocks it** — four vCPUs at
100%, no disk I/O, no way back but `kill` and `reset`. A convenience that can
destroy an instance on the ordinary path is not a convenience.

`winvm snapshot` refuses to run against a guest that is not ready for the same
reason. Re-take `fresh` whenever the guest reaches a new state worth returning
to, or keep several tags and rewind between them.

`rewind` works on a stopped instance too — it starts QEMU directly into the
saved state (`-loadvm`), skipping the boot entirely.

Three devices had to change before any of this worked, and each announced itself
as a flat refusal from `savevm` naming the offender:

| device | refusal | fix |
|---|---|---|
| NVMe boot disk | `non-migratable` | virtio-blk (above) |
| raw pflash NVRAM | `writable but does not support snapshots` | qcow2 NVRAM |
| writable result volume | same | read-only once installed |

**After a rewind, wait for the guest — do not sleep.** `loadvm` returns as soon
as QEMU has restored the state, which is *before* the guest agent can serve a
command. A fixed sleep that is slightly too short gives the worst possible
result: a command answered from across the restore, which makes a rewind that
did work look like one that changed nothing. That cost a debugging cycle here;
`winvm rewind` polls the agent instead.

The base is `chmod 444` after it is built. That is not ceremony: writing to a
backing file while overlays reference it corrupts every one of them, and the
damage surfaces later and elsewhere.

## Selecting an image and instance

| | flag | env | default |
|---|---|---|---|
| state dir | — | `WINVM_HOME` | `~/.local/state/winvm` |
| instance | `-i` | `WINVM_INSTANCE` | `default` |
| image | `--image` | `WINVM_IMAGE` | `win11-arm64` |

Give each concurrent consumer its own instance name; they will share the base
image automatically.

## Host dependencies

| Dependency | Install | Why |
|---|---|---|
| `qemu` | `brew install qemu` | `qemu-system-aarch64`, `qemu-img`, and the EDK2 AArch64 firmware |
| | | Binaries come from `PATH`; the firmware images are located by asking QEMU (`-L help`) rather than assuming a prefix, so an Intel Mac, MacPorts, Nix or a source build works without editing anything. `WINVM_QEMU_DATA` overrides. `doctor` prints the path it found. |
| `swtpm` | `brew install swtpm` | **Required.** Windows 11 hard-requires TPM 2.0; without it the only way past Setup is the LabConfig bypass, an unsupported configuration |
| `hdiutil`, `newfs_msdos` | macOS built-in | Seed ISO and FAT result volume. No `xorriso`/`mkisofs` needed |

`bun run winvm:doctor` checks all of them and names what is missing. macOS-only.

## Getting the ISO

<https://www.microsoft.com/en-us/software-download/windows11arm64> — multi-edition
ARM64, no Microsoft account. **The generated link expires after 24 hours**, so it
cannot be baked into a script. `build --iso` symlinks rather than copies it.

The guest installs **Windows 11 Pro**, selected by name (`/IMAGE/NAME`) rather
than WIM index, because index order is a property of one ISO build. It runs
unactivated, which is permitted indefinitely and correct for a disposable
fixture.

## Design decisions, and the evidence

Most were derived from UTM's source, the best available record of what works for
this guest on this hardware.

**The boot disk changes bus between installing and running.** Both halves are
load-bearing, and the reasons are unrelated to each other.

*Installing on NVMe.* Windows 11 ARM64 has an in-box NVMe driver
(`stornvme.sys`), so Setup sees the disk with nothing injected. UTM's wizard
hard-codes this for aarch64 + Windows, overriding the virtio default it uses for
every other guest. Installing onto virtio would mean injecting `viostor` at
`windowsPE`, and a `<DriverPaths>` entry names a *drive letter* — which WinPE
assigns by device enumeration order.

*Running on virtio-blk.* QEMU's `nvme` device model has **no migration
support**, so `savevm` refuses outright — `Device '0000:00:01.0/nvme' is
non-migratable`. Snapshots are impossible while the disk is NVMe, and this is a
property of the device model, not of HVF: the identical machine with a
`virtio-blk-pci` disk snapshots fine.

The bridge is a scratch virtio-blk disk attached **during the build only**. Its
sole job is to exist, so Windows installs `viostor` from the DriverStore and
marks it boot-start (`Start=0`) — which is what lets the finished image boot
with its real disk on virtio-blk. WinPE cannot see a virtio disk at all, so it
cannot disturb the answer file's `DiskID 0` while Setup is running.

`provision.ps1` checks the result and writes it to the image's `image.json`.
Images built before this change say nothing, and keep booting on NVMe rather
than bluescreening with `INACCESSIBLE_BOOT_DEVICE`; `winvm snapshot` tells you
to rebuild.

**A running instance attaches no USB storage at all.** The install ISO, guest
tools and seed are attached only while building, and the writable result volume
now goes with them. EDK2 hung enumerating that volume — the firmware console
stopping dead on `UsbBootExecCmd: Success to Exec 0x0 Cmd (Result = 1)` with a
core pegged and no boot target ever chosen — and it did so on an instance that
carried only that one USB disk, so this is not about how many are attached. The
device lines that remain follow [Linaro's published reference][linaro] for this
guest: `usb-storage` with `media=cdrom` on a `qemu-xhci` bus, and no
`removable=` flag.

`qemu-xhci`, not `nec-usb-xhci`: QEMU's documentation recommends XHCI and spells
the device `qemu-xhci` ([USB emulation][qemuusb]), while the NEC model carries an
open upstream bug, "[usb3: nec-usb-xhci broken][necbug]", reported as unwell
since QEMU 5.2.

[linaro]: https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system
[qemuusb]: https://qemu-project.gitlab.io/qemu/system/devices/usb.html
[necbug]: https://gitlab.com/qemu-project/qemu/-/issues/3241

**swtpm with `tpm-tis-device`.** UTM uses `tpm-crb-device`; Homebrew's QEMU
builds only the TIS model for aarch64. Verified equivalent — with swtpm attached
the firmware log goes from `Tpm2SubmitCommand - Tcg2 - Not Found` to enumerating
all four PCR banks.

**Secure Boot is absent.** Homebrew ships `edk2-aarch64-code.fd` but not the
`edk2-aarch64-secure-code.fd` UTM pairs with its TPM. Hence
`BypassSecureBootCheck` in the answer file even though the TPM is real.

**The guest boots to audit mode, not OOBE.** This is the single setting that
makes the VM predictable, and it is Microsoft's documented mechanism rather than
a trick: `Microsoft-Windows-Deployment | Reseal | Mode = Audit` in the
`oobeSystem` pass. Audit mode "starts the computer in the built-in administrator
account", and the machine "will continue to boot to audit mode by default until
you configure the computer to boot to OOBE"
([Boot Windows to Audit Mode or OOBE][audit]).

The out-of-box experience is not merely slow, it is *unobservable*. With OOBE,
a fresh instance logs on a temporary account called `defaultuser0`, sits on
"Just a moment, checking for updates" for minutes, then reboots. During all of
it the guest looks ready by every available measure: `qemu-ga` runs as SYSTEM
and answers `guest-ping`; `guest-exec` works; and Windows reports
`OOBEInProgress = 0`, `SystemSetupInProgress = 0` and a running `explorer.exe`
while the OOBE screen is still on the display. There is no probe that returns
"not yet". Snapshotting in that window **livelocks the guest** — every vCPU at
100%, no disk I/O, recoverable only by killing it — and the post-OOBE reboot is
its own failure point (one hung at the firmware splash indefinitely).

Audit mode deletes the phase instead of trying to detect the end of it. Every
boot lands on a logged-on desktop. Two consequences worth knowing:

- The **Sysprep dialog** appears on the desktop in audit mode. Harmless here —
  nothing drives this guest through its GUI.
- The **screen saver is disabled deliberately** during provisioning. Microsoft:
  "If a password-protected screen saver starts when you are in audit mode, you
  cannot log back on to the system", because the built-in administrator is
  disabled immediately after logon.

Provisioning runs from the `auditUser` pass, which is what Microsoft names it
for — "run a script that runs when the PC enters audit mode … helpful for tasks
like automated app installation or testing" ([Add a custom script][script]).
`SetupComplete.cmd` invokes the same script, and the script is idempotent, so
whichever hook fires first does the work.

**The `oobeSystem` pass must contain nothing but `Reseal`.** The documentation
says oobeSystem settings "do not appear in audit mode", and that sentence is
easy to read as "they are harmless". They are not. Left in place, `UserAccounts`
and `AutoLogon` still created an account and signed *it* in — so the audit-mode
logon that `audit.exe` had arranged to be re-called on (`audit.exe /user`) never
happened, the `auditUser` pass never ran, and the guest sat on a finished
desktop with no agent and nothing anywhere explaining why. Audit mode signs in
the built-in Administrator by itself; give it no other account to prefer.

**Provisioning does not power the guest off.** It used to, so that `build` could
treat the VM vanishing as success. Microsoft warns against exactly that from a
Setup script — "You should not reboot the system by adding a command such as
`shutdown -r`. This will put the system in a bad state" ([Add a custom
script][script]) — and the signal was ambiguous regardless, since a crash and a
kill look identical. The host now waits for provisioning to declare itself
finished, asks the guest what it is, and shuts it down through the guest agent.

[audit]: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/boot-windows-to-audit-mode-or-oobe
[script]: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup

**UAC is disabled in the guest.** `FirstLogonCommands` run as the auto-logged-on
administrator but *unelevated*, so the guest-tools installer raises a consent
dialog nobody can answer (`The operation was canceled by the user`). Note the
UAC dialog focuses **No**, so blindly sending Enter *denies* it. This also
matches GitHub's Windows runners, which run with UAC disabled.

**`SkipMachineOOBE`/`SkipUserOOBE` are deliberately absent.** Microsoft
deprecated both, and on 25H2 they silently suppress `FirstLogonCommands` — the
desktop comes up, provisioning never runs, nothing says why.

## The command channel

`winvm exec` talks to **qemu-ga** over virtio-serial: it runs a command in the
guest and returns stdout, stderr and the exit code. No SSH, no listening port,
no dependency on guest networking.

UTM's `utmctl` has the same verbs and is *not* used: it drives UTM.app over
Apple Events, so it needs a logged-in Aqua session and an interactive TCC grant.
Upstream's own error text says "utmctl does not work from SSH sessions or before
logging in"; it reproduces as a silent hang and `OSStatus -1712`. Apple's
Virtualization.framework cannot run Windows at all — no virtual TPM.

`qemu-ga` on Windows ARM64 is the **x86 build under emulation**; UTM's installer
has no ARM64 branch for it. It works, but is not native.

## Networking

The guest gets outbound internet through QEMU's user-mode stack via
`virtio-net-pci`. Windows 11 ARM64 has **no in-box virtio-net driver** — the NIC
does not work until the guest tools install `NetKVM`. Verified: DNS, TLS, and
`bun install` against the npm registry.

`ping` will never work — ICMP is a user-mode-networking limitation, not a fault.
Test reachability with HTTP.

## Guest tools

`build` downloads UTM's guest-tools ISO
(`https://getutm.app/downloads/utm-guest-tools-latest.iso`), the practical source
of **WHQL-signed ARM64 virtio drivers** — they chain to `Microsoft Windows
Hardware Compatibility Publisher`, so they load with no test-signing, which
matters because Windows ARM64 enforces kernel-mode driver signing. The drivers
are Fedora's virtio-win ARM64 builds; Fedora publishes only x64/x86 *MSIs*,
which is why the ISO is the useful artifact.

## Fidelity limits — read before trusting a result

This guest is **ARM64**; CI's `windows-latest` is **x64**. Not interchangeable:

- **`bun:ffi` is unconditionally disabled** on Windows ARM64 (oven-sh/bun#28055).
- **JIT and WebAssembly were disabled** in the port PR (oven-sh/bun#26215).
  Whether 1.3.14 re-enabled them is *unverified*.
- x64-on-ARM emulation is binary translation, not identical execution, so
  **timing-sensitive questions cannot be settled here** — including the
  intermittent ~5016 ms `windows` failures in #90.

It *is* good for the class that caused most historical bugs: shell parsing, file
locking, path separators, regex escaping, POSIX mode bits. Those are
architecture-independent.

For genuine x64 parity, attach to the real runner (`action-tmate` on the
`windows` job) or use a cloud Windows box.

## Troubleshooting

**Start here: `winvm diagnose [-i name]`.** It reads what a guest left behind —
firmware console, QEMU's stderr, the provisioning transcript, image and instance
metadata — and reports the failures this tool has actually had, with the way out
of each. It needs no running guest, which is the point: every failure here looks
identical from outside, because the QEMU process is alive and the monitor
answers "running" in all of them. `build` runs it automatically when it fails.

It reports nothing on a healthy instance. If it finds nothing and the guest is
still wrong, that is a new failure mode worth adding to `diagnose.ts`.

Its checks are held to recorded artifacts of guests that actually failed, kept
in `scripts/dev/win11/tests/traces.zip` and exercised by `bun run test:winvm`.
The archive also carries the long-form write-up (`notes/diagnostic-notes.md`)
and an `index.md`. It is a zip rather than loose files on purpose: those traces
are pictures of BROKEN configurations, and next to the working code they are a
trap for anyone reading the tree to learn how this is supposed to work. Open it
when you are diagnosing something; ignore it otherwise.

Half the traces are of guests that were FINE. That is the point — several
signatures here are transient states a healthy guest passes straight through,
and the archive keeps a working example beside each failing one.

**Watch a boot.** `winvm ls` prints each instance's VNC display; connect with
`open vnc://127.0.0.1:590<n>`. Firmware output goes to the instance's
`serial.log`, and the boot before it to `serial.prev.log` — kept because the
usual response to a bad boot is another boot, which would otherwise overwrite
the evidence. QEMU's own stderr goes to `qemu.log`.

**A build failed.** It says why, and it does not produce an image. `build`
promotes the disk only when the guest reports success: `provision.ps1` writes
`status.txt` to the result volume, and anything other than `ok` prints the tail
of the transcript and keeps the scratch instance for inspection. Read the whole
transcript with:

```sh
hdiutil attach "$HOME/.local/state/winvm/instances/build-<image>/result.img"
cat /Volumes/MAXRESULT/provision.log
hdiutil detach /Volumes/MAXRESULT
```

**A build says one is already running.** It is — `build` detaches its VM, so an
interrupted build leaves the guest alive. `winvm kill -i build-<image>`, then
build again. Interrupting with Ctrl-C now kills the guest on the way out.

**Guest agent never answers.** The tools did not install. Boot it, look over
VNC, and re-run the installer from the mounted tools volume.

**Boot falls through to a UEFI shell.** `startup.nsh` on the result volume is the
selector; it prefers an installed Windows over the installer, which is what stops
Setup's mid-install reboots from restarting the install forever.

**A guest is wedged.** `winvm rewind -i <name>` first — it is faster than a reset
and keeps the instance. `winvm kill -i <name>` then `winvm reset -i <name>` if
the guest is too far gone to restore.

**`snapshot` says the image predates virtio boot.** That image's guest has no
boot-start `viostor`, so it runs on NVMe, which QEMU cannot snapshot. Rebuild it
(`winvm build --image <name>`); `winvm build` reports whether snapshots are
available when it finishes. `reset` deletes the overlay and therefore every
snapshot with it — the next `start` takes a new `fresh`.
