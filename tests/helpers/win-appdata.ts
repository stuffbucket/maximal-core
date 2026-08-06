/**
 * Confine Windows app-data lookups to a test's temp home.
 *
 * `getClaude3pDir(home)` takes a home directory, but on win32 it resolves
 * `%LOCALAPPDATA%` FIRST and only falls back to `<home>\AppData\Local` when
 * that variable is unset — which is correct product behaviour (that is where
 * Windows actually puts per-user local app data) and simultaneously means the
 * injected-home seam every Claude Desktop test relies on does nothing there.
 *
 * Left alone, those tests do not just fail: on Windows they read and WRITE the
 * real `%LOCALAPPDATA%\Claude-3p` — the user's actual Claude Desktop 3P config
 * — and, because that path is shared, leak state into each other and across
 * files. This is the same hazard `tests/test-setup.ts` closes for
 * `COPILOT_API_HOME`, in the one place that env var does not cover.
 *
 * So: point `%LOCALAPPDATA%` at the per-test temp home before exercising any
 * code that resolves it, and restore it afterwards. No-op on POSIX, where the
 * `home` argument is already the only input.
 */

const IS_WINDOWS = process.platform === "win32"

/**
 * Redirect `%LOCALAPPDATA%` into `home` for the duration of a test.
 * Returns the restore function; call it in `afterEach`. No-op off win32.
 */
export function redirectLocalAppData(home: string): () => void {
  if (!IS_WINDOWS) return () => {}
  const saved = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = `${home}\\AppData\\Local`
  return () => {
    if (saved === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = saved
  }
}
