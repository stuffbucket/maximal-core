import { execSync } from "node:child_process"
import process from "node:process"

type ShellName = "bash" | "zsh" | "fish" | "powershell" | "cmd" | "sh"
type EnvVars = Record<string, string | undefined>

/**
 * Injected view of the host, so shell detection is testable off-platform.
 * Production passes nothing and reads the real process.
 */
export interface ShellProbe {
  platform?: NodeJS.Platform
  /** PID of the process that launched us — the shell we want to name. */
  ppid?: number
  env?: EnvVars
  /** Runs a command and returns its stdout; throws if it exits non-zero. */
  run?: (command: string) => string
}

const defaultRun = (command: string): string =>
  execSync(command, { stdio: "pipe" }).toString()

export function getShell(probe: ShellProbe = {}): ShellName {
  const platform = probe.platform ?? process.platform
  const ppid = probe.ppid ?? process.ppid
  const env = probe.env ?? process.env
  const run = probe.run ?? defaultRun

  if (platform === "win32") {
    try {
      // Ask for the parent BY ITS OWN ID. The previous probe was
      // `wmic process get ParentProcessId,Name | findstr "<ppid>"`, which never
      // could work: that output has one row per process carrying that row's
      // name and ITS parent's id, and it never selects on `ProcessId` at all.
      // Matching `<ppid>` therefore picked out the rows whose ParentProcessId
      // is `<ppid>` — this process and its siblings — while the parent's own
      // row (keyed by the GRANDparent's id) could only match by coincidence.
      // So `powershell` was unreachable and every Windows user got the cmd
      // script. `wmic` is also deprecated and ships disabled by default from
      // Windows 11 24H2, where the call throws outright; `tasklist` is present
      // on every supported Windows and answers the question actually asked.
      const output = run(`tasklist /FI "PID eq ${ppid}" /NH /FO CSV`)
      const parentImage = output.toLowerCase()
      if (
        parentImage.includes("powershell.exe")
        || parentImage.includes("pwsh.exe")
      ) {
        return "powershell"
      }
    } catch {
      return "cmd"
    }

    return "cmd"
  } else {
    const shellPath = env.SHELL
    if (shellPath) {
      if (shellPath.endsWith("zsh")) return "zsh"
      if (shellPath.endsWith("fish")) return "fish"
      if (shellPath.endsWith("bash")) return "bash"
    }

    return "sh"
  }
}

/**
 * Generates a copy-pasteable script to set multiple environment variables
 * and run a subsequent command.
 * @param {EnvVars} envVars - An object of environment variables to set.
 * @param {string} commandToRun - The command to run after setting the variables.
 * @param {ShellProbe} probe - Host override; production omits it.
 * @returns {string} The formatted script string.
 */
export function generateEnvScript(
  envVars: EnvVars,
  commandToRun: string = "",
  probe: ShellProbe = {},
): string {
  const shell = getShell(probe)
  const filteredEnvVars = Object.entries(envVars).filter(
    ([, value]) => value !== undefined,
  ) as Array<[string, string]>

  let commandBlock: string

  switch (shell) {
    case "powershell": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `$env:${key} = ${value}`)
        .join("; ")
      break
    }
    case "cmd": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set ${key}=${value}`)
        .join(" & ")
      break
    }
    case "fish": {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set -gx ${key} ${value}`)
        .join("; ")
      break
    }
    default: {
      // bash, zsh, sh
      const assignments = filteredEnvVars
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
      commandBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : ""
      break
    }
  }

  if (commandBlock && commandToRun) {
    const separator = shell === "cmd" ? " & " : " && "
    return `${commandBlock}${separator}${commandToRun}`
  }

  return commandBlock || commandToRun
}
