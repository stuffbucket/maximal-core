/**
 * Post-mortem for a guest that misbehaved, from its files alone.
 *
 * WHY THIS EXISTS. Every failure this tool has ever had looked the same from
 * outside: a QEMU process that is running, a pidfile that is valid, and a
 * monitor that answers "VM status: running". The difference between "installing
 * normally", "wedged in firmware", "provisioning never started" and "the answer
 * file silently skipped a pass" is only ever visible in the artifacts each one
 * leaves behind — and knowing which artifact to read took a long time to learn.
 *
 * So each check below encodes ONE incident that actually happened here, with the
 * evidence that identified it and the way out. Reading files only, never the
 * guest: this has to work on an instance that is dead, wedged, or long stopped.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { readResult } from "./media"
import { basePath, imageMetaPath, instancesDir, pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"

export type Severity = "error" | "warning" | "note"

export interface Finding {
  readonly severity: Severity
  /** What went wrong, in the words someone would search for. */
  readonly title: string
  /** The observation that identifies it — quoted from the artifact, not paraphrased. */
  readonly evidence: string
  readonly remedy: string
}

/**
 * Firmware output is ANSI escapes and NUL padding; latin1 keeps the bytes
 * intact where a UTF-8 decode would mangle the very lines being matched.
 */
function readText(path: string): string {
  if (!existsSync(path)) return ""
  return readFileSync(path, "latin1").replaceAll("\0", "")
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Everything the firmware printed after its most recent power-on banner. */
function lastBoot(serial: string): string {
  const marker = "UEFI firmware"
  const at = serial.lastIndexOf(marker)
  return at < 0 ? serial : serial.slice(at)
}

const tail = (text: string, lines: number): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(-lines)
    .join("\n")

/** Where the answer file lives; overridable so traces can carry their own. */
export const defaultAnswerFile = (): string => resolve(import.meta.dir, "assets", "autounattend.xml")

export function diagnose(name: string, answerFile: string = defaultAnswerFile()): readonly Finding[] {
  const p = pathsFor(name)
  const findings: Finding[] = []
  const meta = readMeta(name)
  if (meta === null) {
    return [
      {
        severity: "error",
        title: `no such instance "${name}"`,
        evidence: `${p.dir} has no instance.json`,
        remedy: "`winvm ls` to see what exists.",
      },
    ]
  }

  const serial = readText(p.serial)
  const boot = lastBoot(serial)
  const running = qemu.isRunning(p)

  // "STOPPED PROGRESSING" IS A CLAIM ABOUT TIME, SO MEASURE IT.
  //
  // Several signatures below are only failures because nothing happened NEXT: a
  // console that ends at a USB command, a keypress marker with an empty disk.
  // Both are also exactly what a healthy guest looks like ten seconds into a
  // build. Without this, `diagnose` on a running build reports a hang while the
  // installer is working perfectly — and a diagnostic that cries wolf is worse
  // than none. A stopped guest is stalled by definition; a running one has to
  // have gone quiet on both its console and its disk to qualify.
  const mtimeOf = (path: string): number => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }
  const lastProgress = Math.max(mtimeOf(p.serial), mtimeOf(p.overlay))
  const quietSeconds = lastProgress === 0 ? Infinity : Math.round((Date.now() - lastProgress) / 1000)
  const stalled = !running || quietSeconds > 90
  const quietNote = running ? ` after ${String(quietSeconds)}s with no console or disk activity` : ""

  // ---- QEMU never got off the ground ---------------------------------------
  // It reports a bad command line or an unreachable socket on stderr and then
  // exits ZERO, so nothing downstream notices. Everything after this point
  // would be reading artifacts from a guest that was never started.
  const qemuLog = readText(p.qemuLog).trim()
  if (qemuLog !== "") {
    findings.push({
      severity: "error",
      title: "QEMU printed errors on startup",
      evidence: tail(qemuLog, 5),
      remedy: "Fix what it names. QEMU exits 0 on these, so they are invisible unless read here.",
    })
  }

  // ---- EDK2 hung enumerating USB -------------------------------------------
  // The firmware spins a core, serial output stops mid-line, and no boot target
  // is ever chosen. Distinctive because the LAST boot produced firmware output
  // and then simply stopped, with no loader ever starting.
  if (
    stalled &&
    boot.includes("UsbBootExecCmd") &&
    !boot.includes("Windows Boot Manager") &&
    !boot.includes("booting install")
  ) {
    findings.push({
      severity: "error",
      title: "firmware stopped while enumerating USB, and never chose a boot target",
      evidence: `${p.serial} ends at: ${tail(boot, 1)}${quietNote}`,
      remedy:
        "A running instance should attach NO usb-storage; check qemu.ts. Seen on qemu-xhci and nec-usb-xhci alike, " +
        "roughly one boot in three. `winvm kill` then `winvm start` to retry.",
    })
  }

  // ---- The install media's boot prompt went unanswered ----------------------
  // startup.nsh announces `winvm-keypress-needed` immediately before launching
  // the one image that waits for a key. If that is the last thing on the console
  // and the disk never grew, nothing answered it.
  const overlayBytes = sizeOf(p.overlay)
  if (
    stalled &&
    boot.includes("winvm-keypress-needed") &&
    overlayBytes < 300_000_000 &&
    !boot.includes("Windows Boot Manager")
  ) {
    findings.push({
      severity: "error",
      title: "the install media asked for a keypress and nothing answered",
      evidence: `saw winvm-keypress-needed; overlay is only ${String(Math.round(overlayBytes / 1_048_576))} MB${quietNote}`,
      remedy: "The host answers this over QMP after seeing that marker — check qmp.tapEnter and the QMP socket.",
    })
  }

  // ---- The TPM came back in a bad state ------------------------------------
  if (/Tpm2Startup: Response Code error/i.test(boot)) {
    findings.push({
      severity: "warning",
      title: "firmware could not start the TPM",
      evidence: tail(boot.split("\n").filter((l) => /tpm/i.test(l)).join("\n"), 3),
      remedy: "swtpm state is out of step with the disk. `winvm reset` clears TPM state along with everything else.",
    })
  }

  // ---- Provisioning's own verdict ------------------------------------------
  //
  // ONLY MEANINGFUL FOR A BUILD. Provisioning runs once, in the scratch instance
  // a build creates; ordinary instances inherit its results in the base image and
  // do not even attach the result volume. Checking them would report "provisioning
  // left no transcript" against a perfectly healthy guest — which is how a
  // diagnostic teaches people to ignore it.
  //
  // Readable only when nothing holds the image open.
  if (!running && name.startsWith("build-")) {
    const result = readResult(p.result)
    if (result.status === null && result.log.trim() === "") {
      findings.push({
        severity: existsSync(p.result) ? "warning" : "note",
        title: "provisioning left no transcript",
        evidence: `${p.result} carries no provision.log and no status.txt`,
        remedy:
          "provision.ps1 never ran. Its two hooks are SetupComplete.cmd and the answer file's auditUser pass — " +
          "check that oobeSystem contains ONLY Reseal, since an AutoLogon there steals the audit-mode logon.",
      })
    } else if (result.status !== null && result.status !== "ok") {
      findings.push({
        severity: "error",
        title: "provisioning ran and failed",
        evidence: `status.txt = ${result.status}\n${tail(result.log, 8)}`,
        remedy: "Fix what the transcript names, then rebuild.",
      })
    }
    if (result.virtio === "no") {
      findings.push({
        severity: "warning",
        title: "viostor did not come out boot-start",
        evidence: "virtio.txt = no",
        remedy: "The guest cannot boot on virtio-blk, so it gets no snapshots. Rebuild with the scratch virtio disk attached.",
      })
    }
  }

  // ---- Configuration drift that silently removes capability ----------------
  if (readImageMeta(meta.image) === null) {
    findings.push({
      severity: "warning",
      title: `image "${meta.image}" predates virtio boot`,
      evidence: `${imageMetaPath(meta.image)} does not exist`,
      remedy: "It boots on NVMe, which QEMU cannot snapshot. Rebuild the image to enable `winvm snapshot`/`rewind`.",
    })
  }
  if (existsSync(resolve(p.dir, "efi-vars.fd"))) {
    findings.push({
      severity: "warning",
      title: "instance still has raw firmware variables",
      evidence: `${resolve(p.dir, "efi-vars.fd")} exists`,
      remedy: "A writable raw pflash blocks savevm for the whole machine. `winvm start` converts it; `winvm reset` also fixes it.",
    })
  }

  // ---- Leftovers from a previous run ---------------------------------------
  // A build detaches its guest, so an interrupted one leaves both the scratch
  // instance and, often, a live QEMU that the next build would collide with.
  if (existsSync(instancesDir())) {
    for (const other of listScratch()) {
      const sp = pathsFor(other)
      findings.push({
        severity: qemu.isRunning(sp) ? "error" : "note",
        title: qemu.isRunning(sp) ? `a build is still running as "${other}"` : `leftover scratch instance "${other}"`,
        evidence: `${sp.dir}${qemu.isRunning(sp) ? ` (pid ${String(qemu.pidOf(sp))})` : ""}`,
        remedy: qemu.isRunning(sp)
          ? `\`winvm kill -i ${other}\` before building again.`
          : `A previous build did not finish. \`winvm destroy -i ${other}\` when you are done reading it.`,
      })
    }
  }

  findings.push(...checkAnswerFile(answerFile))

  if (!existsSync(basePath(meta.image))) {
    findings.push({
      severity: "error",
      title: `image "${meta.image}" is missing`,
      evidence: `${basePath(meta.image)} does not exist`,
      remedy: "The overlay is backed by a file that is gone. Rebuild the image, or destroy this instance.",
    })
  }

  return findings
}

/**
 * The answer file, checked for the conflict that produces NO error anywhere.
 *
 * Requesting audit mode while leaving OOBE's account settings in place is
 * accepted by Windows and half-honoured: `audit.exe` runs and enables the
 * built-in Administrator, then AutoLogon signs in the answer file's account
 * instead. The audit logon that `audit.exe /user` was arranged for never
 * happens, so the auditUser pass never runs and provisioning never runs. The
 * guest reaches a working desktop and simply has no agent. Nothing in any log
 * says why; it took reading audit.exe's own log inside the guest disk to find.
 *
 * A static check costs nothing and catches it before a build is spent.
 */
function checkAnswerFile(file: string): readonly Finding[] {
  const xml = readText(file)
  if (xml === "") return []
  const oobe = /<settings pass="oobeSystem">([\s\S]*?)<\/settings>/.exec(xml)?.[1] ?? ""
  // Comments discuss these by name, so match ELEMENTS, not mentions.
  const withoutComments = oobe.replaceAll(/<!--[\s\S]*?-->/g, "")
  const auditMode = /<Mode>\s*Audit\s*<\/Mode>/i.test(withoutComments)
  const conflicts = ["AutoLogon", "UserAccounts", "FirstLogonCommands"].filter((tag) =>
    new RegExp(`<${tag}>`).test(withoutComments),
  )
  if (!auditMode || conflicts.length === 0) return []
  return [
    {
      severity: "error",
      title: "the answer file asks for audit mode AND leaves OOBE logon settings in place",
      evidence: `${file}: oobeSystem has Reseal/Mode=Audit alongside ${conflicts.join(", ")}`,
      remedy:
        "Delete them. They are not inert in audit mode: AutoLogon signs in its own account, the audit logon never " +
        "happens, and the auditUser pass — where provisioning runs — is skipped silently.",
    },
  ]
}

/** Scratch instances a build creates, which only survive a run that did not finish. */
function listScratch(): readonly string[] {
  try {
    return readdirSync(instancesDir()).filter((d) => d.startsWith("build-"))
  } catch {
    return []
  }
}

export function formatFindings(name: string, findings: readonly Finding[]): string {
  if (findings.length === 0) return `instance "${name}": nothing known looks wrong`
  const icon: Record<Severity, string> = { error: "FAIL", warning: "WARN", note: "note" }
  return findings
    .map((f) => `${icon[f.severity]}  ${f.title}\n      ${f.evidence.split("\n").join("\n      ")}\n      -> ${f.remedy}`)
    .join("\n\n")
}
