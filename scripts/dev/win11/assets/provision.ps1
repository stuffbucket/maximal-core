# Provisioning for the winvm Windows 11 ARM64 guest.
#
# Runs once, at first logon, from autounattend.xml's FirstLogonCommands under an
# AutoLogon session with UAC already disabled (see the `specialize` pass), so it
# is elevated and never raises a consent dialog.
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

function Find-VolumeContaining {
    param([Parameter(Mandatory = $true)][string] $RelativePath)
    foreach ($name in (Get-PSDrive -PSProvider FileSystem).Name) {
        if (Test-Path "${name}:\$RelativePath") { return "${name}:" }
    }
    return $null
}

$seed = Find-VolumeContaining -RelativePath "provision.ps1"
if (-not $seed) { throw "seed volume not found" }

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
    # Payloads are shipped on the seed rather than downloaded, so what runs is
    # exactly what the caller pinned rather than whatever an installer resolves
    # on the day. It also does not depend on the NIC, whose driver has only just
    # been installed above.
    $payloadRoot = "C:\payload"
    New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null

    $staged = @()
    if (Test-Path "$seed\payload") {
        foreach ($zip in Get-ChildItem -Path "$seed\payload\*.zip" -ErrorAction SilentlyContinue) {
            Write-Output "expanding $($zip.Name)"
            Expand-Archive -Path $zip.FullName -DestinationPath $payloadRoot -Force
            $staged += $zip.Name
        }
        foreach ($item in Get-ChildItem -Path "$seed\payload" -Exclude *.zip -ErrorAction SilentlyContinue) {
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

    Write-Result -Name "status.txt" -Content "ok"
    Write-Output "PROVISION OK"
} catch {
    Write-Output "PROVISION FAILED: $_"
    Write-Result -Name "status.txt" -Content "failed: $_"
} finally {
    Stop-Transcript | Out-Null
    # Power off: the host treats guest shutdown as "build complete", then
    # promotes the disk to a read-only base image.
    Start-Sleep -Seconds 3
    Stop-Computer -Force
}
