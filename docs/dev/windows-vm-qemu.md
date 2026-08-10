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
bun run winvm:reset                    # discard changes, back to the base image
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

A Windows install is ~26 GB, so a copy per consumer is not viable. The base is
built once and never written again; each instance is a qcow2 **overlay** backed
by it, holding only its own deltas.

Measured on this machine:

| | |
|---|---|
| base image | 26 GB, read-only |
| instance after first boot | **192 MB** |
| `reset` | **1.3 s** |

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

**NVMe boot disk, not virtio-blk.** Windows 11 ARM64 has an in-box NVMe driver
(`stornvme.sys`), so Setup sees the disk with nothing injected. UTM's wizard
hard-codes this for aarch64 + Windows, overriding the virtio default it uses for
every other guest. Choosing virtio would mean injecting `viostor` at
`windowsPE`, and a `<DriverPaths>` entry names a *drive letter* — which WinPE
assigns by device enumeration order.

**swtpm with `tpm-tis-device`.** UTM uses `tpm-crb-device`; Homebrew's QEMU
builds only the TIS model for aarch64. Verified equivalent — with swtpm attached
the firmware log goes from `Tpm2SubmitCommand - Tcg2 - Not Found` to enumerating
all four PCR banks.

**Secure Boot is absent.** Homebrew ships `edk2-aarch64-code.fd` but not the
`edk2-aarch64-secure-code.fd` UTM pairs with its TPM. Hence
`BypassSecureBootCheck` in the answer file even though the TPM is real.

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

**Watch a boot.** `winvm ls` prints each instance's VNC display; connect with
`open vnc://127.0.0.1:590<n>`. Firmware output goes to the instance's
`serial.log`.

**A build produced nothing.** Mount the result volume — the guest writes its
provisioning transcript there, and it is the only channel that exists before
qemu-ga does:

```sh
hdiutil attach "$HOME/.local/state/winvm/instances/<name>/result.img"
cat /Volumes/MAXRESULT/provision.log
hdiutil detach /Volumes/MAXRESULT
```

**Guest agent never answers.** The tools did not install. Boot it, look over
VNC, and re-run the installer from the mounted tools volume.

**Boot falls through to a UEFI shell.** `startup.nsh` on the result volume is the
selector; it prefers an installed Windows over the installer, which is what stops
Setup's mid-install reboots from restarting the install forever.

**A guest is wedged.** `winvm kill -i <name>`, then `winvm reset -i <name>`.
