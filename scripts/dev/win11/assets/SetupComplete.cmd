@echo off
REM Runs automatically at the end of Windows Setup, as SYSTEM, before any user
REM logs on. Windows looks for this exact path: %WINDIR%\Setup\Scripts\SetupComplete.cmd
REM
REM WHY THIS AND NOT FirstLogonCommands.
REM
REM FirstLogonCommands needs a user session, so it depends on AutoLogon working,
REM runs unelevated (a UAC consent dialog nobody can answer), and on 25H2 is
REM silently suppressed by the deprecated SkipMachineOOBE/SkipUserOOBE. All
REM three failure modes are invisible: the desktop appears, provisioning never
REM runs, and nothing anywhere says why. SetupComplete.cmd has none of them --
REM it is documented, always elevated, and needs no user at all.
REM
REM autounattend.xml's `specialize` pass copies this file and provision.ps1 here
REM from the seed volume.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0provision.ps1"
