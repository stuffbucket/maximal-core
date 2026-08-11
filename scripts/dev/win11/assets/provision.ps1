# Provisioning for the winvm Windows 11 ARM64 guest.
#
# Runs once, at the END OF SETUP, via C:\Windows\Setup\Scripts\SetupComplete.cmd
# -- which Windows executes as SYSTEM before any user logs on. The answer file's
# specialize pass copies this script and that wrapper into place.
#
# NOT FirstLogonCommands: that needs a user session, runs unelevated (so the
# guest-tools installer raises a UAC dialog nobody can answer), and on 25H2 is
# silently suppressed by the deprecated Skip*OOBE settings. All three failures
# look identical from outside -- the desktop appears and nothing has run.
#
# THIS SCRIPT KNOWS NOTHING ABOUT ANY PARTICULAR PROJECT. It installs the guest
# tools, then stages whatever the caller put in the seed's `payload\` directory:
# every .zip is expanded into C:\payload\<name>, and if a `setup.ps1` is present
# it is run afterwards. That is the whole contract. A consumer that wants Bun
# passes a Bun zip; one that wants something else passes something else.
#
# WHY IT SEARCHES FOR VOLUMES INSTEAD OF USING DRIVE LETTERS.
#
# The VM attaches several removable volumes plus an NVMe disk, and Windows
# assigns letters by enumeration order — a property of the QEMU command line,
# not a contract. UTM's own answer file hard-codes
# `E:\utm-guest-tools-0.1.271.exe` and so breaks both when device order shifts
# AND when the tools version bumps. Searching by a file that identifies the
# volume costs three lines and removes both failure modes.

$ErrorActionPreference = "Stop"

# IDEMPOTENT BY DESIGN. Two documented hooks invoke this script — SetupComplete.cmd
# (once, at the end of Setup) and the answer file's auditUser pass (each time the
# machine enters audit mode). Whichever runs first does the work; every later
# invocation returns here immediately. Without this guard, audit mode would
# reinstall the guest tools and re-expand the payload on every single boot.
$Done = "C:\winvm-provisioned.txt"
if (Test-Path $Done) {
    Write-Output "already provisioned on $(Get-Content $Done -Raw); nothing to do"
    exit 0
}

function Find-VolumeContaining {
    param([Parameter(Mandatory = $true)][string] $RelativePath)
    foreach ($name in (Get-PSDrive -PSProvider FileSystem).Name) {
        if (Test-Path "${name}:\$RelativePath") { return "${name}:" }
    }
    return $null
}

# Diagnostic only. Several volumes carry a copy of this script, so this is NOT
# a reliable way to find the seed -- see the payload section below.
$seed = Find-VolumeContaining -RelativePath "provision.ps1"

# The RESULT volume is a separate writable FAT image: the seed is an ISO and
# cannot carry anything back out. Found by label, for the same reason as above.
$resultVolume = Get-Volume | Where-Object { $_.FileSystemLabel -eq "MAXRESULT" } | Select-Object -First 1
if (-not $resultVolume) { throw "result volume MAXRESULT not found" }
$resultDir = "$($resultVolume.DriveLetter):\"

Start-Transcript -Path "$resultDir\provision.log" -Force | Out-Null

function Write-Result {
    param([string] $Name, [string] $Content)
    Set-Content -Path "$resultDir\$Name" -Value $Content -Encoding UTF8 -NoNewline
}

try {
    Write-Output "seed=$seed result=$resultDir arch=$env:PROCESSOR_ARCHITECTURE"

    # --- 1. Guest tools: vioserial + NetKVM + qemu-ga -------------------------
    #
    # THE STEP THAT MAKES THIS VM USEFUL. qemu-ga rides vioserial and gives the
    # host `guest-exec` (run a command, capture stdout/stderr and the exit code)
    # with no SSH, no open port and no Apple Events. NetKVM is the only way this
    # guest gets a working NIC: Windows 11 ARM64 has no in-box virtio-net driver.
    #
    # The drivers are Fedora's virtio-win ARM64 builds, WHQL-signed by
    # `Microsoft Windows Hardware Compatibility Publisher`, so they load on a
    # stock install with no test-signing.
    $tools = Find-VolumeContaining -RelativePath "Drivers\vioserial\w11\ARM64\vioser.inf"
    if ($tools) {
        $installer = Get-ChildItem -Path "$tools\utm-guest-tools-*.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($installer) {
            Write-Output "installing $($installer.Name)"
            $p = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
            Write-Output "guest tools exit: $($p.ExitCode)"
        } else {
            Write-Output "WARNING: guest tools installer not found on $tools"
        }
    } else {
        Write-Output "WARNING: guest tools volume not found - no agent and no network"
    }

    # --- 2. Stage the caller's payload ---------------------------------------
    #
    # The payload volume is located by looking for the `payload` DIRECTORY, not
    # by assuming it sits next to this script.
    #
    # This script runs from C:\Windows\Setup\Scripts (copied there by the
    # answer file's specialize pass), and copies of it also exist on the seed
    # ISO and on the writable result volume — so "the volume containing
    # provision.ps1" is genuinely ambiguous and picked the wrong one, silently
    # staging nothing. The payload directory only ever exists on the seed.
    #
    # Payloads are shipped on the seed rather than downloaded, so what runs is
    # exactly what the caller pinned rather than whatever an installer resolves
    # on the day. It also does not depend on the NIC, whose driver has only just
    # been installed above.
    $payloadRoot = "C:\payload"
    New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

    $payloadSource = $null
    foreach ($name in (Get-PSDrive -PSProvider FileSystem).Name) {
        $candidate = "${name}:\payload"
        # Skip the destination itself, which this script just created.
        if ($candidate -eq $payloadRoot) { continue }
        if ((Test-Path $candidate) -and (Get-ChildItem $candidate -ErrorAction SilentlyContinue)) {
            $payloadSource = $candidate
            break
        }
    }
    Write-Output "payload source: $(if ($payloadSource) { $payloadSource } else { '(none found)' })"

    $staged = @()
    if ($payloadSource) {
        foreach ($zip in Get-ChildItem -Path "$payloadSource\*.zip" -ErrorAction SilentlyContinue) {
            Write-Output "expanding $($zip.Name)"
            Expand-Archive -Path $zip.FullName -DestinationPath $payloadRoot -Force
            $staged += $zip.Name
        }
        foreach ($item in Get-ChildItem -Path $payloadSource -Exclude *.zip -ErrorAction SilentlyContinue) {
            Copy-Item -Path $item.FullName -Destination $payloadRoot -Recurse -Force
        }
    }
    Write-Result -Name "payload.txt" -Content ($staged -join "`n")

    # Put every directory containing an executable on the machine PATH, so a
    # later `winvm exec` finds tools without knowing this layout.
    $binDirs = Get-ChildItem -Path $payloadRoot -Recurse -Filter *.exe -ErrorAction SilentlyContinue |
        ForEach-Object { $_.DirectoryName } | Sort-Object -Unique
    if ($binDirs) {
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        foreach ($d in $binDirs) {
            if ($machinePath -notlike "*$d*") { $machinePath = "$machinePath;$d" }
        }
        [Environment]::SetEnvironmentVariable("Path", $machinePath, "Machine")
        Write-Output "PATH += $($binDirs -join '; ')"
    }

    # --- 3. Caller-supplied setup, if any ------------------------------------
    $setup = Join-Path $payloadRoot "setup.ps1"
    if (Test-Path $setup) {
        Write-Output "running payload setup.ps1"
        & $setup
    }

    # --- 4. Confirm viostor came out boot-start ------------------------------
    #
    # The build attaches a scratch virtio-blk disk purely so PnP installs
    # viostor from the DriverStore and marks it boot-start (Start=0). That is
    # what lets instances run their boot disk on virtio-blk, which QEMU requires
    # for live snapshots -- the nvme device model has no migration support, so
    # `savevm` refuses outright.
    #
    # Reported, NOT thrown: an image without it is still a working Windows
    # guest, just one that cannot be snapshotted. The host records the answer on
    # the image so instances know which bus to boot.
    $viostor = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\viostor" -ErrorAction SilentlyContinue
    if ($viostor -and $viostor.Start -eq 0) {
        Write-Output "viostor is boot-start: this image can boot on virtio-blk"
        Write-Result -Name "virtio.txt" -Content "ok"
    } else {
        $state = if ($viostor) { "Start=$($viostor.Start)" } else { "service absent" }
        Write-Output "WARNING: viostor is not boot-start ($state) - no live snapshots"
        Write-Result -Name "virtio.txt" -Content "no"
    }

    # --- 5. Audit mode housekeeping ------------------------------------------
    #
    # Microsoft, on audit mode: "If a password-protected screen saver starts
    # when you are in audit mode, you cannot log back on to the system. The
    # built-in administrator account that is used to log on to audit mode is
    # immediately disabled after logon." A long-lived VM would eventually lock
    # itself out of its own desktop, so turn the screen saver off outright.
    # <https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/boot-windows-to-audit-mode-or-oobe>
    reg.exe add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f | Out-Null
    reg.exe add "HKCU\Control Panel\Desktop" /v ScreenSaverIsSecure /t REG_SZ /d 0 /f | Out-Null
    powercfg.exe /change monitor-timeout-ac 0
    powercfg.exe /change standby-timeout-ac 0
    # Hibernation off: hiberfil.sys is sized from RAM and would be pure waste in
    # every overlay. This used to be a FirstLogonCommand, which audit mode does
    # not run — so it lives here now, with everything else that must happen once.
    powercfg.exe -h off

    Set-Content -Path $Done -Value (Get-Date -Format o) -Encoding UTF8
    Write-Result -Name "status.txt" -Content "ok"
    Write-Output "PROVISION OK"
} catch {
    Write-Output "PROVISION FAILED: $_"
    Write-Result -Name "status.txt" -Content "failed: $_"
} finally {
    Stop-Transcript | Out-Null
}
# DELIBERATELY DOES NOT POWER THE MACHINE OFF.
#
# This used to end in `Stop-Computer -Force`, so the host could treat the guest
# vanishing as "build complete". Microsoft is explicit that this is unsafe from
# a Setup script: "You can't reboot the system and resume running
# SetupComplete.cmd. You should not reboot the system by adding a command such
# as shutdown -r. This will put the system in a bad state."
# <https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup>
#
# The host now waits for the guest to become genuinely ready, checks this
# script's verdict, and shuts the guest down itself through the guest agent —
# an ordinary, orderly shutdown of a machine that has finished starting.
