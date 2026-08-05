# Release runbook

Single source of truth for shipping a release.

**This repo has no release automation.** `release-please.yml` and `release.yml`
do not exist in `.github/workflows/`, and every tag so far was cut by hand. If
you came here from an older revision of this file, or from a doc that describes
a release PR opening itself: that pipeline was inherited from
[`stuffbucket/maximal`](https://github.com/stuffbucket/maximal) in the core
split and was never carried over. Do not go looking for it.

What exists instead is deliberate and manual, in five steps. Nothing cuts a
release for you; three [gates](#the-gates) check that the one you cut by hand is
well-formed, and one workflow builds and attaches the binaries once the tag
exists ([step 5](#5-publish-the-artifacts)).

---

## The model: a milestone is a release

A release is a **GitHub milestone whose title is the tag** — `v0.2.1`, `v0.3.0`.
Assigning a PR to a milestone pre-selects the release it ships in, at the moment
the PR is opened rather than when someone later assembles notes from a commit
range. Whatever is in the milestone is what ships, and it is reviewable in the
GitHub UI before the tag exists.

`bun run release:notes vX.Y.Z` reads the milestone and emits the notes. It
refuses to emit on a PR title it cannot parse, an unmerged PR, or a milestone
that does not exist, rather than quietly shipping wrong notes.

### Choosing the version

Pre-1.0, and non-negotiably:

| Change | Bump | Example |
|---|---|---|
| `fix:` | patch | `0.2.0` → `0.2.1` |
| `feat:` | patch | `0.2.1` → `0.2.2` |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` | **minor** | `0.2.2` → `0.3.0` |

`feat:` cutting a *patch* is the pre-1.0 convention this repo inherited from
release-please (`bump-minor-pre-major` + `bump-patch-for-minor-pre-major`). The
table above and `requiredBump` in
[`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts) are now the
only statements of it. It is kept because the reason for it is load-bearing:

> A consumer's `^0.2.0` resolves to `>=0.2.0 <0.3.0`. A breaking change released
> as a patch is therefore **auto-installed** on a routine `npm update`. Minor is
> the only bump that puts it out of range and forces the upgrade to be a
> deliberate, coordinated act.

`maximal-core` publishes contracts consumed outside this repo — `./supervisor`
(the ready-line parser), `./control-contract`, and the `/v1` route table. A
change to any of those is breaking even when nothing throws at build time, and
belongs in a minor. When in doubt, minor: an over-cautious bump costs a
coordinated upgrade, an under-cautious one ships a silent break.

---

## 1. Assign the PRs

Every PR gets a milestone. The title must be a single valid Conventional Commit
— squash-merge uses it as the commit subject, and it is the only thing that
reaches the changelog. Mark a breaking change with `!`; that is what emits the
`BREAKING CHANGES` block and what tells the reader the bump is a minor.

```sh
gh pr edit <n> --milestone vX.Y.Z
gh pr list --json number,title,milestone \
  --jq '.[] | "#\(.number)  [\(.milestone.title // "none")]  \(.title)"'
```

Both of those rules are checked automatically on every PR — see
[the gates](#the-gates). To check one locally before pushing:

```sh
bun run release:check pr <n>
```

## 2. Pre-flight

CI (`ci.yml`) gates every PR, so a green milestone is already most of this.
`check:deep` is a strict superset of what CI runs:

```sh
bun install
bun run check:deep        # lint, typecheck, typecheck:downstream, casts:check,
                          # tests, knip, build
bun run e2e               # seam + feed + lifecycle harnesses
bun run release:check milestone vX.Y.Z   # every PR in the milestone vs the bump
```

`release:check milestone` is the blocking version of the advisory sibling
warning the PR gate emits: it re-checks *every* PR in the milestone against the
version about to be cut, so a milestone that was retargeted after one of its PRs
merged cannot ship under-bumped.

## 3. Generate the notes

```sh
bun run release:notes vX.Y.Z                  # CHANGELOG block
bun run release:notes vX.Y.Z --release-body   # GitHub Release body
```

Exit codes: `0` clean, `1` problems found (nothing written — fix them, or
`--force` to emit the well-formed subset anyway), `2` fatal (no such milestone,
empty milestone, no usable PRs).

Paste the changelog block into `CHANGELOG.md` directly under `# Changelog`. The
output is byte-compatible with the release-please format the archived history
uses, so there is no format seam.

## 4. Bump, tag, push

```sh
bun run release:manual    # guard, preflight, bumpp prompts; commits, tags, pushes, publishes
```

`release:manual` is [`scripts/ops/release.ts`](../scripts/ops/release.ts), which
runs four steps **in that order, in one process**:

| # | Step | Refuses on |
|---|---|---|
| 1 | Clean-tree guard | any **tracked** modification, staged or unstaged, including `dist/` |
| 2 | Preflight (`prepack --check`) | the running Bun is not the one in `.bun-version` |
| 3 | `bumpp --all --execute "<pinned bun> release.ts --rebuild"` | — |
| 4 | `bun publish --access public` | — |

Steps 1 and 2 are both **before** `bumpp`, **because everything after them is
irreversible**: `bumpp` commits, tags and pushes before `bun publish` is ever
reached, and a registry publish cannot be taken back at all. Exit `1` means it
refused and nothing happened; exit `2` means a step failed.

Useful flags — anything the script does not recognise is forwarded to `bumpp`:

```sh
bun run release:manual --no-publish            # cut and push the tag, skip the registry
bun run release:manual --release patch -y      # non-interactive
bun scripts/ops/release.ts --rebuild           # just regenerate + stage dist/, no release
bun run release:preflight                      # step 2 on its own
```

> **The rebuild is step 3's `--execute` hook, and it is why the commit is made
> with `--all`.** `bun build` inlines `package.json` — `BUILD_VERSION` in
> `src/lib/update/build-info.ts` falls back to `packageJson.version` — so
> bumping the version alone makes the committed bundle stale and turns
> `bindings:check` red on `main`. It is genuine drift, not a false positive:
> that bundle is the `bin` a git-dependency install runs, and it would print and
> report the previous version. Measured, same Bun 1.3.11, one bumped version:
> `85697a48…` at `0.3.2` vs `2e541596…` at `0.3.3`. v0.3.2 and v0.4.0 were both
> regenerated by hand after the fact; this is that step, performed.
>
> `bumpp`'s execute hook fires after the bump and before the commit, which is
> the only window where the new version is on disk and the commit has not
> happened yet. But the hook alone is **not enough**, and this is the part that
> surprises people: `bumpp`'s default commit is
> `git commit --allow-empty -m <msg> <the files bumpp updated>` — git's
> *pathspec* form, which deliberately **ignores the index for every other
> path**. A hook that does `git add -f dist/main.js` therefore has its work
> dropped from the release commit and left dangling after it. Measured on a
> throwaway repo, staging `dist/main.js` and then committing `bumpp`-style:
>
> ```
> git commit -m … package.json   → git show HEAD:dist/main.js = v1 (stale); `M  dist/main.js` left over
> git commit -m … --all          → git show HEAD:dist/main.js = v2;         tree clean
> ```
>
> So the release commit is made with `--all`, which commits the *index* — and
> the staged rebuild with it, including a brand-new content-hash chunk that
> `-a` alone would never have picked up.

> **And `--all` is exactly what disables `bumpp`'s own clean-tree check**
> (`if (!options.all && !options.noGitCheck) await checkGitStatus()`, and
> `noGitCheck` defaults to `true` regardless — so `bumpp` was checking nothing
> here anyway). That is why the guard is step 1 and lives in this repo rather
> than in a flag. **What counts as dirty:** every tracked modification, staged
> or unstaged, including `dist/` — those are precisely the paths `--all` would
> sweep into the release commit, and `bindings:check` reads the *index*, so a
> working-tree-only `dist/` edit is invisible to every other gate. Untracked
> files are **listed but do not block**: `git commit --all` stages only tracked
> paths, so an untracked file cannot reach the release commit by any route, and
> refusing on an editor artifact would be a false positive on a path whose next
> step is irreversible.
>
> The guard does not fight the rebuild, because of *where* it runs: it is step
> 1, the rebuild is inside step 3. By the time `dist/` is written, the guard has
> already passed — it only ever asks "did `dist/` match `HEAD` when we started",
> which is true of every tree a previous release left behind.

> **Why the Bun version decides whether a release is publishable.** `bun publish`
> fires `prepack`, which rebuilds `dist/` into the tarball — and `bun build`
> bundles with Bun's own bundler, so `dist/main.js` is a function of the Bun
> version ([`docs/bun-version-policy.md`](bun-version-policy.md)). Publishing
> off-pin ships a `bin` bundle that disagrees with the committed one
> `bindings:check` verifies, and that nobody following these docs can
> regenerate. Measured on `main` at v0.3.2: committed `85697a48…` (Bun 1.3.11,
> the pin) vs a tarball's `ffdee378…` (Bun 1.3.14, whatever was on PATH).
>
> **Installing the right Bun is not enough on its own, and this is the part that
> surprises people.** Bun runs scripts through a shell that does not carry its
> own bindir on PATH, so a bare `bun` inside a script re-resolves from *your*
> PATH. Measured for both the lifecycle path and the plain `bun run` path this
> script is launched through:
>
> ```
> $ /path/to/1.3.11/bin/bun pm pack     # tarball dist/main.js → ffdee378… (1.3.14)
> $ ~/.bun/bin/bun run <script>         # outer interpreter 1.3.11 …
> execPath      : /opt/homebrew/Cellar/bun/1.3.10/bin/bun
> versions.bun  : 1.3.14                #  … inner interpreter 1.3.14
> ```
>
> **So put the pinned Bun first on your PATH before you run any of this.** That
> is why `prepack` is [`scripts/ops/prepack.ts`](../scripts/ops/prepack.ts)
> rather than `bun run build && bun run build:lib`: it version-checks
> `process.versions.bun` and then bundles with `process.execPath`, so the binary
> that was checked is the binary that bundles. `release.ts` reuses it for both
> the preflight and the `--rebuild` hook, and spawns the hook as
> `"<process.execPath>" "<release.ts>" --rebuild` for the same reason. It
> refuses with a non-zero exit rather than downloading a Bun for you. The same
> script still backs `prepack` itself, so `bun publish` and `bun pm pack` are
> guarded even when run by hand, outside `release:manual`.

Or by hand, if you want the commit message under your own control. **Nothing
below is automated — the rebuild and the clean-tree check are yours to
remember:**

```sh
# package.json version MUST match the tag — checked by the preflight below
bun run release:check version vX.Y.Z
git status --porcelain                     # must be empty of tracked changes
bun run build && git add -f dist/main.js   # the bundle inlines the new version
git commit -am "chore: release X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"
git push && git push origin vX.Y.Z
```

> **The by-hand path still needs the rebuild.** `git commit -am` misses new
> files under the gitignored, force-tracked `dist/`, which is why the `git add
> -f` above is separate — and it only covers `dist/main.js`. If `dist/lib`
> moved too, run `bun scripts/ops/release.ts --rebuild` instead of the build
> line: it regenerates and stages both, on the pinned Bun, and is the same code
> `release:manual` runs. `git show v0.3.2:dist/main.js` contains `0.3.2`, not
> `0.3.1` — every release before this was rebuilt by hand at this point.

> **Use `-a`.** A lightweight tag (plain `git tag`) drops the annotation, and
> `git tag -f` without `-a` silently downgrades an annotated tag to one. Nothing
> checks this one.

> **Gate: the tag must match `package.json`.** It has already gone wrong once —
> `v0.1.1` was tagged while `package.json` still read `0.1.0`
> (`git show v0.1.1:package.json`). Milestones make the tag a commitment made
> *in advance*, which widens the window. `bun run release:check version vX.Y.Z`
> above is the preventive check; `release-tag-check.yml` re-runs it on the
> pushed tag as a tripwire. Run the preflight — by the time the tripwire fires,
> the tag exists.

> **Never move a published tag.** Retagging does not re-resolve a consumer's
> `bun.lock` — it pins the old commit SHA, so `bun install --force` reinstalls
> the *old* tree and only `bun update` re-resolves. A moved tag means two
> machines can hold different code under one version. If the tripwire fires
> within seconds of the push and nothing has resolved the tag yet, deleting and
> re-cutting is the lesser evil; after that, ship a new patch instead.


## 5. Publish the artifacts

Pushing the tag fires [`release-artifacts.yml`](../.github/workflows/release-artifacts.yml).
It builds `bun-darwin-arm64` on a macOS arm64 runner and `bun-windows-x64` on a
Windows x64 runner — **natively, because every check it runs executes the
binary** — verifies each one with `verify:artifact` *and* the full `e2e:binary`
suite, and attaches both plus `SHA256SUMS` and `ARTIFACTS.md` to the release for
the tag.

> **Wait for it to go green before you run `gh release create`.** The workflow
> creates the release itself, **as a draft**, if none exists — so the order that
> makes a failed build harmless is: push the tag, watch the run, then fill in
> the notes and publish the draft.
>
> ```sh
> gh run watch "$(gh run list --workflow release-artifacts.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
> gh release edit vX.Y.Z --title "vX.Y.Z — <summary>" --draft=false \
>   --notes "$(bun run release:notes vX.Y.Z --release-body)"
> ```
>
> If you create the release first (the old order), the workflow uploads into it
> and everything still works — **but a failed build then leaves a release that
> is already public and has no assets, and nothing in CI can un-publish it.**
> That is the state `v0.2.1`, `v0.3.0` and `v0.3.1` are in. It is recoverable
> only by fixing the build and re-running the workflow by hand
> (`gh workflow run release-artifacts.yml -f ref=vX.Y.Z -f publish=true`).

**Failure behaviour.** A build or verify leg that fails skips the publish job
entirely: nothing is uploaded, no partial set is attached, and the run is red.
Both legs always run to completion, so one report tells you whether it was one
platform or both.

### Running the same checks locally

```sh
bun run build:binary                                   # dist-bin/maximal, host target
bun run verify:artifact -- --binary=dist-bin/maximal   # --version, boot, x-maximal-version, SIGTERM
bun run e2e:binary -- --binary=dist-bin/maximal        # seam + feed + lifecycle vs that exact file
```

> **`bun run dev:stale-check` is not this check and never was.** It probes a
> proxy already *running* on your machine and compares the `+<sha>` an `app:dev`
> build embeds in `x-maximal-version` against `origin/main`. A release binary
> embeds no `+<sha>`, so it reports `UNKNOWN` and exits 1 on every release
> artifact, by construction. It answers "is my dev sidecar stale";
> `verify:artifact` answers "is this file the release it claims to be". It was
> called `verify:build` until v0.3.3 and earlier revisions of this step listed
> it here. That was wrong; the rename is the fix.

### The binaries are unsigned, and that is not a formality

There is no Apple Developer ID, no notarization credential and no Windows
code-signing certificate in this repo, so CI cannot sign anything. `--compile`
also appends the bundled JS onto the Bun runtime *after* the linker signed it,
so the ad-hoc signature the Mach-O carries is invalid on arrival — verified, not
assumed:

```
$ codesign --verify --verbose dist-bin/maximal
dist-bin/maximal: invalid signature (code or signature have been modified)
```

So: assets are named `…-unsigned`, a browser download of the macOS binary is
Gatekeeper-quarantined and **will not launch** without
`xattr -d com.apple.quarantine`, and the Windows binary trips SmartScreen. The
`ARTIFACTS.md` asset published alongside them says all of this to the person
downloading, including the `codesign --force` + `com.apple.security.cs.allow-jit`
entitlement a host needs to re-sign the binary into a notarized bundle. Do not
soften that text — someone will otherwise download it expecting a double-click
app.

---

## The gates

The three conventions above used to be asserted here and enforced by nothing.
They are now checked by [`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts),
which is pure logic behind the same injectable `GhRunner` seam
`release-notes.ts` uses — so the whole thing is unit-tested offline
(`bun run check:ops`).

| Gate | What it checks | Where it runs |
|---|---|---|
| 1 | The PR carries a milestone whose title is a release tag (`vX.Y.Z`) | `release-gates.yml`, every PR |
| 2 | The PR's required bump ≤ the milestone's bump, measured from the current release | `release-gates.yml`, every PR; `release:check milestone` at preflight |
| 3 | The tag matches `package.json` | `release:check version` preflight; `release-tag-check.yml` on tag push |

```sh
bun run release:check pr <n>              # gates 1 + 2 for one PR
bun run release:check milestone vX.Y.Z    # gate 2 across the whole milestone
bun run release:check version vX.Y.Z      # gate 3
```

Exit codes: `0` clean · `1` a convention was violated · `2` **the gate could not
run** (a `gh` failure, unparseable JSON, a missing `package.json`). Both
workflows treat `2` as non-blocking on purpose: a gate that fails closed on its
own bugs takes the repo down with it.

### What gate 2 actually compares

The baseline is `max(highest vX.Y.Z tag, package.json at the PR's base ref)`.
Both are used because the two have already disagreed here (`v0.1.1` vs `0.1.0`)
and each covers the other's failure — the tag is what a consumer resolves, and
`package.json` leads it in the window between a bump commit and its tag. The
base ref matters: reading the working tree would let the PR under test choose
its own baseline.

The requested bump is classified by the **highest component that increased**,
not by adjacency. `0.2.1 → 0.2.5` is a *patch*-level move even though it skips
four: it stays inside a consumer's `^0.2.x`, so a breaking change in it is
exactly as dangerous as in `0.2.2`. `0.2.1 → 0.4.0` is a real minor. A skip is
legal but gets a warning, in case it was a typo.

Corner cases, and what each does:

- **No milestone at all** → gate 1 only. Gate 2 stays silent rather than
  double-reporting the same missing thing.
- **A milestone that is not a release tag** (`Backlog`, `v0.3`, `v0.3.0-rc.1`)
  → gate 1, not gate 2. It satisfies "has a milestone" while shipping in no
  release, which is precisely the failure gate 1 exists to catch. Prereleases
  are not modelled by any of this tooling.
- **A milestone at or below the current release** → blocking
  `milestone-not-ahead`: that release is already out, or the number is wrong.
- **An empty milestone** (preflight only) → blocking `empty-milestone`. A
  typo'd tag returns zero PRs from the same search a real-but-unassigned
  milestone does, and "0 PRs, all gates pass" is the exact silent green these
  gates exist to remove.
- **Several PRs in one milestone disagreeing** → the milestone's requirement is
  the max over its PRs, enforced pointwise. On a PR, a *sibling's* violation is
  a **warning** (it is not yours to fix, but you are the person looking);
  `release:check milestone` makes the same finding blocking at the release
  boundary, which is what catches a milestone retargeted after a PR merged.
- **A `BREAKING CHANGE:` footer in the body with no `!` in the title** →
  blocking. The changelog is generated from titles only, so the breaking change
  would ship unannounced. It is also counted as breaking for gate 2, so the
  release cannot be under-bumped while the two disagree.

### When a gate is wrong

Three escape hatches, in increasing blast radius:

1. `release-gate-override` label on the PR → every finding on it becomes a
   warning, and the report says so.
2. Repo variable `RELEASE_GATES_MODE=warn` → nothing blocks, repo-wide. Set it
   in the GitHub UI in seconds; no PR needed. Any value other than `warn` means
   enforce, so a typo cannot silently disable the gate.
3. Delete the workflow.

A bot-authored PR (Dependabot, renovate) cannot assign a milestone, so gate 1 is
a warning for those; gate 2 still applies in full. A `chore: release X.Y.Z`
commit is exempt from both — it ships the bump itself and belongs to no
milestone.

`release-gates.yml` is not a required status check unless someone adds it to
branch protection. Until then it is advisory: it reports and fails its own job,
but does not block the merge button.

---

## What this repo does *not* have

Listed so nobody re-derives it from a stale doc:

- **No published npm package, and no automated publish.**
  `@stuffbucket/maximal-core` has never reached the registry —
  `https://registry.npmjs.org/@stuffbucket/maximal-core` 404s, and every release
  in `gh release list` (v0.2.0 … v0.3.2) shipped as a git tag plus the binaries
  from [step 5](#5-publish-the-artifacts). `bun run release:manual` exists and
  ends in `bun publish`, but nothing has ever come out the other side of it. So
  the consumers that exist today install from git (which is why `dist/` is
  committed at all — see [`scripts/ops/check-bindings.ts`](../scripts/ops/check-bindings.ts)).
  Treat the first `release:manual` as a first publish: unreleasable name,
  unverified auth, `--access public` on a fresh scope. Rehearse it with
  `bun pm pack` and inspect the tarball before you point it at the registry.
- **No CI-driven publish.** There is no npm token and no OIDC trusted-publishing
  config in this repo, so the tarball is always built on someone's laptop.
  Publishing from CI would pin the Bun version by construction and is the better
  end state; until then
  [`scripts/ops/prepack.ts`](../scripts/ops/prepack.ts) is what makes the manual
  path safe, and it stays correct inside a CI publish later.
- No `release-please.yml`, no `release.yml`, no auto-opened release PR, no
  `autorelease:` labels, and no release-please config. `release-please-config.json`
  and `.release-please-manifest.json` were inert leftovers of the split and are
  deleted; the bump convention they recorded lives in
  [Choosing the version](#choosing-the-version) and in `requiredBump`, and the
  manifest's copy of the version had already drifted from `package.json`.
- No `Release-As:` handling. Nothing reads the trailer; the milestone title
  carries that intent now. (Commit `867dfc4` used one and a human honoured it
  by hand.)
- No CI signing, notarization, stapling, DMG packaging, Homebrew tap, Windows
  MSI, or Pages deploy. `build:binary` produces a **signable** artifact and
  `release-artifacts.yml` publishes it with a `SHA256SUMS`; neither signs it,
  and there is no Apple or Authenticode credential in this repo to sign it with.
  See [step 5](#the-binaries-are-unsigned-and-that-is-not-a-formality).
- No proof that the Windows binary shuts down *gracefully*. Both legs of
  `release-artifacts.yml` now run `verify:artifact` and the full `e2e:binary`
  suite — the lifecycle harness stopped spawning POSIX `sleep` as its decoy
  parent and uses the Bun that is already running it. What is left is a platform
  limit, not a harness gap: Windows has no SIGTERM, `child.kill("SIGTERM")` is
  `TerminateProcess`, and nothing in Node or Bun can deliver a graceful stop to
  a child there. So the Windows shutdown checks prove the process is terminable;
  the drain path (Claude Code revert, pidfile removal, session sentinel) is only
  exercised on macOS. The parent-death watchdog is exercised on both.
- No check that a tag is *annotated*. `release-tag-check.yml` compares the
  version and nothing else; `-a` is still on you.
- No prerelease support anywhere. `vX.Y.Z-rc.1` is not a release tag to any of
  this tooling, and a milestone named that fails gate 1.
- No automatic *creation* of the next milestone, and no check that a merged PR's
  milestone is still open.


## See also

- [`docs/architecture.md`](architecture.md) → _Release & PR conventions_
- [`scripts/ops/release.ts`](../scripts/ops/release.ts) — step 4 end to end, and
  the argument for the clean-tree definition and the `--all` / `--execute` pair
- [`scripts/ops/release-notes.ts`](../scripts/ops/release-notes.ts) — the
  generator, and the rationale in its header comment
- [`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts) — the three
  gates, and the argument for where each one runs
- [`docs/archive/CHANGELOG-maximal.md`](archive/CHANGELOG-maximal.md) — the
  frozen pre-split history
