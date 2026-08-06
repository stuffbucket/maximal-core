/**
 * Windows shell detection for the `--claude-code` copy-paste script.
 *
 * `maximal start --claude-code` composes a script and puts it on the clipboard
 * for the user to paste into the shell they launched from. Getting the shell
 * wrong doesn't degrade the output, it invalidates it: in PowerShell `set` is
 * an alias for `Set-Variable` (which does not take `KEY=VALUE`) and `&` is the
 * call operator, so the cmd form errors out and sets nothing.
 *
 * The probe used to be:
 *
 *     wmic process get ParentProcessId,Name | findstr "<ppid>"
 *
 * That output has one row per process, carrying that row's `Name` and ITS
 * parent's id — `ProcessId` is never requested. Matching `<ppid>` therefore
 * selected the rows whose ParentProcessId is `<ppid>`, i.e. this process and
 * its siblings; the parent's own row is keyed by the GRANDparent's id and could
 * only match by coincidence. The `powershell` arm of `generateEnvScript` was
 * unreachable on every Windows box.
 *
 * The fake host below models the real tools rather than the code under test:
 * `wmic` renders `Name` + `ParentProcessId` and `findstr` does a substring match
 * on the rendered line, exiting 1 (so `execSync` throws) when nothing matches;
 * `tasklist /FI "PID eq n"` looks a process up by its own id.
 */

import { describe, expect, test } from "bun:test"

import { generateEnvScript, getShell } from "~/lib/platform/shell"

interface Proc {
  pid: number
  ppid: number
  name: string
}

/**
 * @param procs the process table
 * @param opts `wmicAvailable: false` models Windows 11 24H2+ and Server 2025,
 *   where WMIC is a Feature on Demand that is absent by default.
 */
function windowsHost(
  procs: Array<Proc>,
  opts: { wmicAvailable?: boolean } = {},
) {
  const wmicAvailable = opts.wmicAvailable ?? true

  return (command: string): string => {
    const wmic =
      /^wmic process get ParentProcessId,Name \| findstr "(\d+)"$/u.exec(
        command,
      )
    if (wmic) {
      if (!wmicAvailable) {
        throw new Error(
          "'wmic' is not recognized as an internal or external command",
        )
      }
      // Real column order is alphabetical: Name, then ParentProcessId.
      const rows = procs.map((p) => `${p.name.padEnd(30, " ")}${p.ppid}`)
      const matched = rows.filter((row) => row.includes(wmic[1]))
      // findstr exits 1 when nothing matches, so execSync throws.
      if (matched.length === 0) throw new Error("findstr: no match")
      return `${matched.join("\r\n")}\r\n`
    }

    const tasklist = /^tasklist \/FI "PID eq (\d+)"/u.exec(command)
    if (tasklist) {
      const proc = procs.find((p) => p.pid === Number(tasklist[1]))
      return proc ?
          `"${proc.name}","${proc.pid}","Console","1","12,345 K"\r\n`
        : "INFO: No tasks are running which match the specified criteria.\r\n"
    }

    throw new Error(`unexpected command: ${command}`)
  }
}

// powershell.exe (4512) launched maximal (9001). Note that powershell's own
// row is keyed by ITS parent, explorer.exe (300) — which is exactly why a
// ParentProcessId-keyed search can never find it.
const underPowerShell: Array<Proc> = [
  { pid: 300, ppid: 1, name: "explorer.exe" },
  { pid: 4512, ppid: 300, name: "powershell.exe" },
  { pid: 9001, ppid: 4512, name: "bun.exe" },
]

const underCmd: Array<Proc> = [
  { pid: 300, ppid: 1, name: "explorer.exe" },
  { pid: 4512, ppid: 300, name: "cmd.exe" },
  { pid: 9001, ppid: 4512, name: "bun.exe" },
]

describe("getShell on win32", () => {
  test("identifies Windows PowerShell as the launching shell", () => {
    expect(
      getShell({
        platform: "win32",
        ppid: 4512,
        run: windowsHost(underPowerShell),
      }),
    ).toBe("powershell")
  })

  test("identifies pwsh (PowerShell 7) as the launching shell", () => {
    const procs = underPowerShell.map((p) =>
      p.name === "powershell.exe" ? { ...p, name: "pwsh.exe" } : p,
    )
    expect(
      getShell({ platform: "win32", ppid: 4512, run: windowsHost(procs) }),
    ).toBe("powershell")
  })

  test("still reports cmd when cmd really is the parent", () => {
    expect(
      getShell({ platform: "win32", ppid: 4512, run: windowsHost(underCmd) }),
    ).toBe("cmd")
  })

  test("works on hosts where wmic has been removed (Windows 11 24H2+)", () => {
    expect(
      getShell({
        platform: "win32",
        ppid: 4512,
        run: windowsHost(underPowerShell, { wmicAvailable: false }),
      }),
    ).toBe("powershell")
  })

  test("falls back to cmd when the probe itself fails", () => {
    expect(
      getShell({
        platform: "win32",
        ppid: 4512,
        run: () => {
          throw new Error("access denied")
        },
      }),
    ).toBe("cmd")
  })
})

describe("getShell on POSIX", () => {
  test.each([
    ["/bin/zsh", "zsh"],
    ["/usr/bin/fish", "fish"],
    ["/bin/bash", "bash"],
    ["/bin/dash", "sh"],
  ] as const)("%s resolves to %s", (shellPath, expected) => {
    expect(getShell({ platform: "darwin", env: { SHELL: shellPath } })).toBe(
      expected,
    )
  })

  test("no SHELL falls back to sh", () => {
    expect(getShell({ platform: "linux", env: {} })).toBe("sh")
  })
})

describe("generateEnvScript emits the launching shell's syntax", () => {
  const envVars = { A: "1", B: "2" }

  test("PowerShell gets $env: assignments and && chaining", () => {
    const script = generateEnvScript(envVars, "claude", {
      platform: "win32",
      ppid: 4512,
      run: windowsHost(underPowerShell),
    })

    expect(script).toBe("$env:A = 1; $env:B = 2 && claude")
    // The cmd form is a no-op in PowerShell: `set` is Set-Variable and `&` is
    // the call operator.
    expect(script).not.toContain("set A=1")
  })

  test("cmd still gets set/& chaining", () => {
    const script = generateEnvScript(envVars, "claude", {
      platform: "win32",
      ppid: 4512,
      run: windowsHost(underCmd),
    })

    expect(script).toBe("set A=1 & set B=2 & claude")
  })
})
