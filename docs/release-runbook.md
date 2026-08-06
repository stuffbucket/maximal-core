# Release runbook

Single source of truth for shipping a release.

**This repo has no release automation.** `release-please.yml` and `release.yml`
do not exist in `.github/workflows/`, and every tag so far was cut by hand. If
you came here from an older revision of this file, or from a doc that describes
a release PR opening itself: that pipeline was inherited from
[`stuffbucket/maximal`](https://github.com/stuffbucket/maximal) in the core
split and was never carried over. Do not go looking for it.

What exists instead is deliberate and manual, in five steps. Nothing cuts a
release for you; five [gates](#the-gates) check that the one you cut by hand is
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
that does not exist, rather than quietly shipping wrong notes. `release:manual
vX.Y.Z` calls the same generator and writes the entry into `CHANGELOG.md` inside
the release commit, so it refuses on all of the same things — before it bumps.

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
bun run e2e               # seam + feed + lifecycle + replace harnesses
bun run release:check milestone vX.Y.Z   # every PR in the milestone vs the bump,
                                         # plus everything still open
bun run release:check order vX.Y.Z       # the tag is above every tag that exists
```

`release:check milestone` is the blocking version of the advisory sibling
warning the PR gate emits: it re-checks *every* PR in the milestone against the
version about to be cut, so a milestone that was retargeted after one of its PRs
merged cannot ship under-bumped. It also lists what is still open
([gate 5](#the-gates)).

Both of these are previews. `release:manual` runs the same two checks itself,
before it bumps — see [step 4](#4-bump-tag-push). Running them here costs
seconds and tells you now rather than at the tag.

### Dry-run the artifacts before you tag

```sh
gh workflow run release-artifacts.yml -f ref=main    # or a SHA / branch
gh run watch "$(gh run list --workflow release-artifacts.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

`publish` defaults to **false**, so this builds and verifies both legs and
touches no release. It is the only thing that exercises the **macOS** leg, the
second target's compile, and the publish job's rename / `SHA256SUMS` /
`ARTIFACTS.md` assembly before the tag exists — roughly ten minutes, once per
release, at the one moment you are willing to wait for it.

> **Why this step exists.** [Step 5](#5-publish-the-artifacts) runs on a tag
> push, and a tag is immutable in practice — so a leg that dies there dies after
> the version is already spent. That is not hypothetical: `v0.4.2` shipped with
> **no binaries** because #38 put an inline shell one-liner in `package.json`'s
> `prepare` that Bun's built-in shell rejects on Windows, so `bun install`
> failed outright on the `bun-windows-x64` leg and `publish` never ran. Fixed in
> #46; the tag could not be given assets afterwards.
>
> The recurring half of that gap is now closed automatically: `ci.yml` has a
> `windows` job that runs the Windows leg — `bun install`, `build:binary`,
> `verify:artifact`, `e2e:binary` — on **every PR**, concurrently with the
> ubuntu job, for about 16 seconds of added wall clock. This dispatch covers
> what a single-platform PR job structurally cannot.

## 3. Check the notes

```sh
bun run release:notes vX.Y.Z                  # CHANGELOG block
bun run release:notes vX.Y.Z --release-body   # GitHub Release body
```

Exit codes: `0` clean, `1` problems found (nothing written — fix them, or
`--force` to emit the well-formed subset anyway), `2` fatal (no such milestone,
empty milestone, no usable PRs).

**Nothing to paste.** [Step 4](#4-bump-tag-push) generates this same block and
writes it into `CHANGELOG.md` itself, at the
`<!-- releases below … -->` anchor, inside the release commit. This step is the
preview: it prints what step 4 will insert, and its exit code is step 4's — a
non-zero here means `release:manual` will refuse for the same reason, before it
has touched anything.

The output is byte-compatible with the release-please format the archived
history uses, so there is no format seam between a generated entry and the
pasted ones above it.

> **If you would rather write the entry yourself** — a `--force`d subset, or
> prose no generator would produce — paste it under the anchor and commit it
> first. Step 4 leaves an entry that is already there alone, including the `gh`
> reads, so a hand-written block survives untouched. That is the one path that
> still costs a second commit, and it is opt-in.

## 4. Bump, tag, push

```sh
bun run release:manual vX.Y.Z   # guard, preflight, notes, bumpp; commits, tags, pushes, publishes
```

`release:manual` is [`scripts/ops/release.ts`](../scripts/ops/release.ts), which
runs seven steps **in that order, in one process**:

| # | Step | Refuses on |
|---|---|---|
| 1 | Clean-tree guard | any **tracked** modification, staged or unstaged, including `dist/` |
| 2 | Preflight (`prepack --check`) | the running Bun is not the one in `.bun-version` |
| 3 | [Gate 4](#the-gates) — tag order | the tag already exists, or is not above every tag that does (local **and** `origin`) |
| 4 | [Gate 5](#the-gates) — what is open | a PR still open in the milestone being cut |
| 5 | Generate the `CHANGELOG.md` entry | anything `release:notes vX.Y.Z` would refuse to emit on |
| 6 | `bumpp --all --release X.Y.Z --execute "<pinned bun> release.ts --rebuild"` | — |
| 7 | `bun publish --access public` | — |

Steps 1 to 5 are all **before** `bumpp`, **because everything after them is
irreversible**: `bumpp` commits, tags and pushes before `bun publish` is ever
reached, and a registry publish cannot be taken back at all. Exit `1` means it
refused and nothing happened; exit `2` means a step failed — including a gate
that could not *read* what it compares against, which here stops the release
rather than waving it through.

> **This step pushes to `main` directly, and `main` requires a PR.** The push in
> step 4 only lands because `main-require-pr` carries an always-mode bypass
> actor for the admin role. It is the single dependency between this runbook and
> the repository's branch rulesets — see
> [`docs/admin/branch-rulesets.md`](admin/branch-rulesets.md). Remove the bypass
> and this step fails at the push, with the version already bumped and the tag
> already created locally; restoring the bypass or moving the whole flow to a PR
> is then the only way forward. Verify it before you cut:
>
> ```sh
> bun run rules:check
> ```

**The tag is an argument now**, and it is required. It names the milestone the
changelog entry is generated from, and it is what `bumpp` bumps `package.json`
to (`--release X.Y.Z`), so [gate 3](#the-gates) — the tag matches the manifest —
holds by construction rather than by a preflight anyone can skip. `--release` is
therefore refused rather than forwarded: one version, one source.

Useful flags — anything the script does not recognise is forwarded to `bumpp`:

```sh
bun run release:manual vX.Y.Z --no-publish     # cut and push the tag, skip the registry
bun run release:manual vX.Y.Z -y               # non-interactive
bun scripts/ops/release.ts --rebuild           # just regenerate + stage dist/, no release
bun run release:preflight                      # step 2 on its own
```

> **The changelog step fetches and renders; the `bumpp` hook writes.** Splitting
> it that way is what makes the sequence above runnable top to bottom. The block
> cannot be fetched until the version is known, and it must not be *written* until
> `bumpp` is past its confirmation prompt — otherwise a decline, or a Ctrl-C,
> leaves a modified `CHANGELOG.md` that step 1 refuses on the next attempt.
> Which is precisely the bug this replaced: the runbook used to say "paste the
> block into `CHANGELOG.md`" in its step 3 and "run `release:manual`" in step 4,
> whose first action refuses any tracked modification — including that paste. It
> was worked around by committing the changelog separately, which is why v0.4.1
> carries two commits (`6b04af5`, `7418be1`) where every release before it
> carries one.
>
> So on the refusal path — a milestone with an unmerged PR, an unparseable
> title, no milestone at all — nothing has been written and the tree is exactly
> as the guard found it. Re-run when the milestone is fixed.
>
> **The guard keeps no exemptions, and that is deliberate.** `CHANGELOG.md` is
> not special-cased out of step 1; it is written *after* step 1, by the same
> script, in the same window as the `dist/` rebuild — see the note below on why
> that window exists at all. A guard whose value is that it has no exceptions
> does not survive its first one.
>
> **An entry that is already there is left alone**, `gh` reads included. A
> re-run after a failed `bumpp`, or a block someone pasted by hand, is detected
> by its `## X.Y.Z` heading and skipped with a note. Nothing is ever rewritten
> or appended twice. That skip is why [gate 5](#the-gates) is a step of its own
> rather than a side effect of generating the notes: `release:notes` refuses on
> an open PR in the milestone, but on the re-run it is never asked.

> **Gate 4 is the step before the point of no return.** It reads `git tag
> --list` **and** `git ls-remote --tags origin`, and refuses if the tag already
> exists anywhere or is not above every release tag that does. The remote is not
> optional: nothing keeps a checkout's tags up to date, so a tag another agent
> pushed minutes ago is invisible locally — and that is the exact race. It is
> read with `ls-remote`, never `fetch`, so a refusal leaves the ref store
> untouched like every other refusal here. An unreachable remote **stops** the
> release (exit `2`) instead of reading as "no tags exist"; the flow ends in a
> `git push` to that same remote anyway. Prereleases are excluded from the
> comparison and reported as a warning — `vX.Y.Z-rc.1` is not a release tag to
> any of this tooling, and by semver it sorts *below* `vX.Y.Z`.

> **The rebuild is the `bumpp` step's `--execute` hook, and it is why the commit
> is made with `--all`.** `bun build` inlines `package.json` — `BUILD_VERSION` in
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
> happened yet. It is therefore also where the changelog entry is written: the
> hook produces everything the release commit carries beyond the bump itself.
> But the hook alone is **not enough**, and this is the part that
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
> The guard does not fight the rebuild, or the changelog write, because of
> *where* it runs: it is step 1, and both of those are inside the `bumpp` step.
> By the time
> `dist/` and `CHANGELOG.md` are written, the guard has already passed — it only
> ever asks "did the tree match `HEAD` when we started", which is true of every
> tree a previous release left behind.

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
below is automated — the rebuild, the changelog entry and the clean-tree check
are yours to remember:**

```sh
# package.json version MUST match the tag — checked by the preflight below
bun run release:check version vX.Y.Z
bun run release:check order vX.Y.Z          # nothing higher is already tagged
git status --porcelain                     # must be empty of tracked changes
bun run release:notes vX.Y.Z               # paste under the CHANGELOG.md anchor
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
> the tag exists. On the automated path this cannot arise: `release:manual
> vX.Y.Z` sets the version *from* the tag it is about to cut.

> **Never move a published tag.** Retagging does not re-resolve a consumer's
> `bun.lock` — it pins the old commit SHA, so `bun install --force` reinstalls
> the *old* tree and only `bun update` re-resolves. A moved tag means two
> machines can hold different code under one version. If the tripwire fires
> within seconds of the push and nothing has resolved the tag yet, deleting and
> re-cutting is the lesser evil; after that, ship a new patch instead.

> **And never cut a tag *below* one that already exists**, for the same reason
> in reverse: the lower tag is immovable too, so a `v0.4.4` pushed after `v0.5.0`
> is a permanently wrong ordering — a lower semver carrying strictly more code.
> Two releases prepared concurrently is all it takes, and this repo runs several
> agents at once. `bun run release:check order vX.Y.Z` above is the preventive
> check on the by-hand path; `release:manual` runs it itself, before the bump
> ([gate 4](#the-gates)); and `release-tag-check.yml` re-runs it with `--pushed`
> on the tag itself, so a by-hand push that skipped the preflight is still
> caught — within seconds, while the tag is almost certainly unconsumed and can
> still be deleted.


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

**By the time this runs, neither leg should be able to surprise you.** The
Windows leg has already run on every PR in the milestone (`ci.yml`'s `windows`
job), and both legs ran against the release candidate at
[step 2](#dry-run-the-artifacts-before-you-tag). If you skipped that dispatch,
this is the first time the macOS leg has seen this code — and it is running
against a tag that cannot be un-cut.

### Running the same checks locally

```sh
bun run build:binary                                   # dist-bin/maximal, host target
bun run verify:artifact -- --binary=dist-bin/maximal   # --version, boot, x-maximal-version, SIGTERM
bun run e2e:binary -- --binary=dist-bin/maximal        # seam + feed + lifecycle + replace vs that exact file
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

The conventions above used to be asserted here and enforced by nothing.
They are now checked by [`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts),
which is pure logic behind the same injectable `GhRunner` seam
`release-notes.ts` uses (plus `check-bindings.ts`'s `GitRunner` for gate 4) — so
the whole thing is unit-tested offline (`bun run check:ops`).

| Gate | What it checks | Where it runs |
|---|---|---|
| 1 | The PR carries a milestone whose title is a release tag (`vX.Y.Z`) | `release-gates.yml`, every PR |
| 2 | The PR's required bump ≤ the milestone's bump, measured from the current release | `release-gates.yml`, every PR; `release:check milestone` at preflight |
| 3 | The tag matches `package.json` | `release:manual vX.Y.Z` sets one from the other; `release:check version` preflight; `release-tag-check.yml` on tag push |
| 4 | The tag does not exist and is above every release tag that does, locally **and** on `origin` | **`release:manual vX.Y.Z`, before the bump**; `release:check order` preflight and by-hand path; `release-tag-check.yml` on tag push (`--pushed`) |
| 5 | Nothing still open claims to ship in this release | **`release:manual vX.Y.Z`, before the bump**; `release:check milestone` at preflight |

```sh
bun run release:check pr <n>              # gates 1 + 2 for one PR
bun run release:check milestone vX.Y.Z    # gate 2 across the whole milestone, + gate 5
bun run release:check order vX.Y.Z        # gate 4
bun run release:check version vX.Y.Z      # gate 3
```

Exit codes: `0` clean · `1` a convention was violated · `2` **the gate could not
run** (a `gh` failure, unparseable JSON, a missing `package.json`). Both
workflows treat `2` as non-blocking on purpose: a gate that fails closed on its
own bugs takes the repo down with it. **`release:manual` is the deliberate
exception** — there, a `2` from gate 4 or 5 stops the release, because the only
cost is a re-run and the only alternative is a tag nobody can move.

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

### What gate 4 compares, and where it runs

Gate 2 asks "is this milestone ahead of the released version" *at the moment the
check runs*. That is not the moment the tag is pushed, and nothing anywhere
compared a tag against the tags that already exist. With two releases in flight —
the normal state of this repo — `v0.5.0` and `v0.4.4` can be prepared
concurrently and land in either order. If `v0.5.0` lands first, `v0.4.4` is a
lower-semver tag carrying strictly more content, and it is unrepairable: a
published tag must not be moved.

So gate 4 runs **inside `release:manual`, ahead of `bumpp`** — the same argument
the clean-tree guard makes. A tag-push workflow can only alarm after the fact,
and a preflight a human runs is the discipline these gates exist to replace. It
runs there **as well**, in `release-tag-check.yml`, because the by-hand path
below skips `release:manual` entirely and an alarm within seconds of the push
still lands while the tag is deletable.

- **Both tag lists.** `git tag --list` for this checkout and
  `git ls-remote --tags origin` for everyone else's. Nothing keeps a checkout's
  tags current, so the local list is the stale one by construction — and a tag
  that exists only locally is still a collision on push.
- **`ls-remote`, never `fetch`.** The check writes nothing, so a refusal leaves
  the repository exactly as it found it.
- **A remote that cannot be read is a refusal**, not a pass. "No tags exist" is
  the reading that lets the reverse-order tag through, and the release ends in a
  push to that remote in any case.
- **The tag already existing is its own refusal**, reported as a collision
  rather than as "not ahead", because the fix is different: pick another
  version, do not re-cut this one.
- **A prerelease never blocks.** `vX.Y.Z-rc.1` is not a release tag to any of
  this tooling, and by semver it sorts *below* `vX.Y.Z` — it is not evidence
  that the version shipped. One whose base sorts at or above the tag being cut
  is a warning, in case somebody else is mid-cut.
- **`--pushed`** compares against every *other* tag and drops the existence
  refusal, which is the shape a tag-push tripwire needs — the tag exists by
  then, by definition. That is how `release-tag-check.yml` calls it.

### What gate 5 decides, and what it refuses to guess

An open PR is only decidably part of a release if it *said so* — the milestone
model is what makes that decidable at all. So:

| The PR is open in… | Gate 5 |
|---|---|
| the milestone being cut | **blocking** — it claimed this release and will not be in the tag or the notes |
| a **lower** release milestone | warning — that release has not shipped; cutting past it strands it, and cutting it afterwards is the reverse-order tag gate 4 will refuse |
| a **higher** release milestone | silent — it deferred itself |
| no milestone, or a non-release one | warning, listed by number |

The last row is the honest limit. **An unassigned PR is not automatically part
of this release**, and a gate that guessed — by touched paths, by age, by
author — would block real releases on somebody's draft and teach everyone to
ignore it. So it lists and does not block, the same shape `release:manual` uses
for untracked files.

The first row was already covered *by accident*: `release:notes` refuses to emit
when a milestone holds an open PR. It is stated as a rule here because that
accident has a hole — `release:manual` skips the changelog step, `gh` reads
included, when `CHANGELOG.md` already documents the version, so a re-run after a
failed `bumpp` cut the tag with the open PR unnoticed.

**Not checkable, and not attempted:** whether an open PR in a *later* milestone
touches the same code as this release, or whether an unassigned PR ought to have
been in it. Both are judgement calls about intent.

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

`release-gates.yml`'s `gate` job **is a required status check** — it blocks the
merge button. It was advisory until the `main-require-pr` ruleset was applied;
the escape hatches above are now the only way past it, and hatch 3 (delete the
workflow) additionally wedges every PR, because a required check that never
reports blocks forever with nothing red to point at.

---

## What `main` enforces

Full detail, including why each piece is there, in
[`docs/admin/branch-rulesets.md`](admin/branch-rulesets.md). The short version,
because it changes how you land a PR:

- **Every change reaches `main` through a PR**, squash-merged. Direct pushes are
  rejected.
- **`test`, `windows` and `gate` must be green.** `test` and `windows` are
  `ci.yml`'s jobs; `gate` is `release-gates.yml`'s. All three are required
  status checks, so a red one is a blocked merge, not a warning.
- **The branch must be up to date with `main`** before it can merge
  (`gh pr update-branch`). There is no Merge Queue on a user-owned repo, and no
  bot to rebase for you here — that is the substitute, and it is what stops two
  independently green PRs from landing a broken `main`.
- **`main` cannot be deleted or force-pushed**, by anyone, with no exemption.

> **The admin bypass on `main-require-pr` is load-bearing for this runbook.**
> [Step 4](#4-bump-tag-push) pushes the release commit *directly* to `main`, so
> with the `pull_request` rule active and no bypass actor that push is rejected
> — after the bump and the local tag, on the irreversible side of the step.
> Whoever removes the bypass must move the release flow to a PR **in the same
> change**. `bun run rules:check` asserts the bypass is still there.

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
  exercised on macOS. The parent-death watchdog is exercised on both — and so,
  since `e2e:replace` landed, is the *eviction* stop: `/_internal/shutdown` ends
  in a userspace `process.exit(0)`, which needs no signal and therefore ports.
  (It is a different path from `initiateShutdown`, so it is not the drain above.)
- No coverage of the `--replace` **escalation** branch, or of the
  `server.portPolicy: "replace"` config as distinct from the `--replace` flag.
  `e2e:replace` covers the flag end to end on both platforms — graceful takeover,
  the incumbent exiting through its own shutdown endpoint, no eviction without
  the flag, a foreign occupant left alive, and no credential on the shutdown POST
  — but only ever reaches the escalation branch (stale pidfile → SIGTERM →
  SIGKILL → `lsof`/`ps` guard) by asserting its *outcome* on a foreign occupant.
  Manufacturing a maximal that binds the port and then stops answering HTTP is
  what proving the branch itself would need, and there is no portable way to do
  it. Note that branch does not exist on Windows in any case: `defaultListenerPid`
  returns null there, so a takeover that the graceful POST cannot complete fails
  rather than escalating. The config policy's `probePort` identity gate is unit
  tested only.
- No check that a tag is *annotated*. `release-tag-check.yml` checks the version
  and the tag's order against every tag that exists, and nothing else; `-a` is
  still on you.
- **No tripwire for gate 5 on a tag pushed by hand.** Gate 4 has one —
  `release-tag-check.yml` runs `order --pushed` on every pushed tag, so a
  `git tag && git push` that skipped the preflight is still caught while the tag
  is deletable. Gate 5 has no equivalent: it runs only inside `release:manual`
  and `release:check milestone`, so a hand-pushed tag whose milestone still has
  an open PR is caught by nothing.
- **No gate on which open PRs *ought* to be in a release.** Gate 5 blocks a PR
  that is open in the milestone being cut and lists the ones carrying no
  milestone; it cannot know whether an unassigned PR, or one deferred to a later
  milestone, belongs here. See
  [what gate 5 refuses to guess](#what-gate-5-decides-and-what-it-refuses-to-guess).
- No prerelease support anywhere. `vX.Y.Z-rc.1` is not a release tag to any of
  this tooling, and a milestone named that fails gate 1.
- No automatic *creation* of the next milestone, and no check that a merged PR's
  milestone is still open.
- **No Merge Queue and no bot to rebase for you.** `main` requires a branch to be
  up to date before it merges, which is the substitute for the queue this
  user-owned repo cannot have — but `app-repoman`, which auto-rebases in the
  repos it manages, does not manage this one. Run `gh pr update-branch` yourself.


## See also

- [`docs/admin/branch-rulesets.md`](admin/branch-rulesets.md) — what `main`
  enforces, and why the release flow depends on the admin bypass
- [`docs/architecture.md`](architecture.md) → _Release & PR conventions_
- [`scripts/ops/release.ts`](../scripts/ops/release.ts) — step 4 end to end, and
  the argument for the clean-tree definition and the `--all` / `--execute` pair
- [`scripts/ops/release-notes.ts`](../scripts/ops/release-notes.ts) — the
  generator, and the rationale in its header comment
- [`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts) — the five
  gates, and the argument for where each one runs
- [`docs/archive/CHANGELOG-maximal.md`](archive/CHANGELOG-maximal.md) — the
  frozen pre-split history
