# winvm

If you get stuck, try Linaro as a resource: <https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system>

If the QEMU process is still running and QMP `info status` reports `running`, but the OS intermittently fails to boot after a long wait, watch the guest with `top -pid $(cat ~/.local/state/winvm/instances/<name>/qemu.pid)` — a square wave, CPU spiking and then settling back down, means it stopped early; check whether the serial output stopped prematurely and check hardware device firmware in the VM.
