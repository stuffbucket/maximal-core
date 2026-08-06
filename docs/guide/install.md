# Install maximal

maximal is a small desktop app that lets your AI coding tools run on the models in your GitHub Copilot plan. Install it, sign in with GitHub, and switch on the tools you want. No extra API keys, no second bill.

This page covers getting maximal onto your machine. Once it's installed, head to [Sign in](./connect-copilot.md) and [Connect your tools](./connect-your-tools.md).

## Before you start

You'll need:

- **A GitHub Copilot plan.** maximal runs your tools on the models in your existing Copilot subscription, so you need an active plan. GitHub Enterprise works too.
- **A Mac with Apple Silicon** (M1 or newer) or a **Windows x64** machine for the app.

That's it. You don't need any Anthropic or OpenAI API keys.

## Install on your Mac

maximal ships no installer — there is no `.dmg` and no drag-to-Applications step. Install the command-line tool with Homebrew:

```sh
brew install stuffbucket/tap/maximal
```

Then sign in and start it:

```sh
maximal auth       # sign in with GitHub
maximal start      # start the service
```

It runs quietly in the background from there.

> **Not a Homebrew user?** Every release also carries a standalone `darwin-arm64` binary on the [releases page](https://github.com/stuffbucket/maximal/releases). Download it, `chmod +x` it, and put it somewhere on your `PATH`. Because maximal is pre-alpha and not yet notarized, macOS quarantines a downloaded binary the first time you run it — clear it with `xattr -d com.apple.quarantine ./maximal`, or approve it under **System Settings → Privacy & Security**.

## Next steps

1. **[Sign in](./connect-copilot.md)** with your GitHub account so maximal can use your Copilot plan.
2. **[Connect your tools](./connect-your-tools.md)** — flip a switch for Claude Code and Claude Desktop.
3. **[Get started](./overview.md)** with your first request.

Something not working? See [Troubleshooting](./troubleshooting.md).

---

## For developers

### Windows and other platforms

- **Windows** — shipping, but with no installer: every release carries a
  standalone `windows-x64` executable. Grab it from the
  [releases page](https://github.com/stuffbucket/maximal/releases) and put it
  somewhere on your `PATH`.
- **Linux and everything else** — no binary is built for these; the release
  targets are macOS Apple Silicon and Windows x64 only. Run from source with
  [Bun](https://bun.sh). Clone the repo and start it:

  ```sh
  git clone https://github.com/stuffbucket/maximal
  cd maximal
  bun install
  bun run ./src/main.ts start
  ```

### Confirm it's running

Once you start maximal, it serves a local address on your machine — by default `http://localhost:4141`. Open the app (or run `maximal start`) and you should see it listening. You can point any Anthropic- or OpenAI-compatible tool at that address.

You're not done until you sign in, though — until then the service runs but can't reach Copilot's models.
