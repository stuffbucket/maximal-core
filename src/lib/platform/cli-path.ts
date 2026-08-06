/**
 * Launch-source classification for `process.execPath`.
 *
 * One question, asked in one place: *where was the running binary
 * launched from?* `describeLaunchSource()` answers it as a coarse
 * `kind` for the Settings → Diagnostics readout (`launch_path` /
 * `launch_kind`, built in `routes/control/settings-endpoints.ts`), so a
 * Homebrew launch and an `.app`-bundle launch are distinguishable at a
 * glance in a bug report.
 *
 * `"dmg-app"` stays in the enum. maximal ships no OS installer, but a
 * `.app`-bundled binary is still a launch shape we can be handed, and
 * the enum is a wire contract shared with the shell (ADR-0005).
 */

/** True when `execPath` points inside a macOS `.app` bundle's
 *  executable dir — i.e. the binary is an app-bundled CLI, not a
 *  Homebrew/dev/standalone binary. */
export function isAppBundlePath(execPath: string): boolean {
  return /\.app\/Contents\/MacOS\//u.test(execPath)
}

export interface LaunchSource {
  /** Absolute path the current process was launched from. */
  path: string
  /** Coarse origin classification, for human-readable diagnostics. */
  kind: "dmg-app" | "homebrew" | "user-bin" | "dev" | "other"
}

/** Classify where the running binary came from. Pure — takes the
 *  exec path so it's trivially testable across the install shapes. */
export function describeLaunchSource(
  execPath: string = process.execPath,
): LaunchSource {
  if (isAppBundlePath(execPath)) return { path: execPath, kind: "dmg-app" }
  // Dev first: `bun src/main.ts` runs from a `bun` interpreter (often
  // itself Homebrew-installed at /opt/homebrew/bin/bun). Check this before
  // the Homebrew prefix so a brew-installed `bun` isn't misread as a brew
  // *maximal* install.
  //
  // The `target/debug|release/` arm is a leftover from the removed Rust
  // shell — nothing produces that path today. Kept because it is inert
  // (no current install shape can match it) and dropping it is a
  // behaviour change that belongs in its own commit, not a comment sweep.
  if (
    /\/target\/(?:debug|release)\//u.test(execPath)
    || /\/bun$/u.test(execPath)
  )
    return { path: execPath, kind: "dev" }
  // Apple Silicon brew is /opt/homebrew/{bin,Cellar}; Intel is
  // /usr/local/Cellar. Match the cellar or the brew prefix.
  if (/\/(?:homebrew|Cellar)\//u.test(execPath))
    return { path: execPath, kind: "homebrew" }
  if (execPath.includes("/.local/bin/"))
    return { path: execPath, kind: "user-bin" }
  return { path: execPath, kind: "other" }
}
