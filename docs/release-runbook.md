# Release runbook

Single source of truth for shipping a release.

**This repo has no release automation.** `release-please.yml` and `release.yml`
do not exist in `.github/workflows/`, and every tag so far was cut by hand. If
you came here from an older revision of this file, or from a doc that describes
a release PR opening itself: that pipeline was inherited from
[`stuffbucket/maximal`](https://github.com/stuffbucket/maximal) in the core
split and was never carried over. Do not go looking for it. The release does now
land through a pull request — [step 4](#4-bump-land-the-pr-tag) opens one,
because `main` takes nothing else — but a human runs the command that opens it
and a human merges it.

What exists instead is deliberate and manual, in five steps. Nothing cuts a
release for you; five [gates](#the-gates) check that the one you cut by hand is
well-formed, and two workflows fire once the tag exists ([step
5](#5-publish-the-package)) — one publishes the npm package, the other re-runs
the tag gates against the tag that was actually pushed.

---

## The model: a milestone is a release

A release is a **GitHub milestone whose title is the tag** — `v0.2.1`, `v0.3.0`.
Assigning a PR to a milestone pre-selects the release it ships in, at the moment
the PR is opened rather than when someone later assembles notes from a commit
range. Whatever is in the milestone is what ships, and it is reviewable in the
GitHub UI before the tag exists.

`bun run release:notes vX.Y.Z` reads the milestone and emits the notes. It
refuses to emit on a PR title it cannot parse, an unmerged PR, or a milestone
that does not exist, rather than quietly shipping wrong notes. `release:prepare
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
Every step of `check:deep` also runs in a required CI job — `bun run ci:check`
is the gate that keeps that true — and CI adds the Windows artifact leg on top:

```sh
bun install
bun run check:deep        # lint, typecheck, typecheck:downstream, casts:check,
                          # tests, knip, deps:check, dupes:check, ci:check, build
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

Both of these are previews. `release:prepare` runs the same two checks itself,
before it bumps — see [step 4](#4-bump-land-the-pr-tag). Running them here costs
seconds and tells you now rather than at the tag.

### Windows coverage happens on every PR

There is no artifact dry-run to do: core builds no binaries. The Windows
exposure that used to require one now runs on **every PR** — `ci.yml`'s
`windows` job does `bun install` (which runs the `prepare` lifecycle script
under Bun's built-in Windows shell) and the full unit suite, concurrently with
the ubuntu job.

> **Why that job exists.** `v0.4.2` shipped with **no binaries** because #38 put
> an inline shell one-liner in `package.json`'s `prepare` that Bun's shell
> rejects on Windows, so `bun install` failed outright on the Windows leg — and
> nothing saw it until after the tag, because Windows ran only on a tag push.
> Fixed in #46; the tag could not be given assets afterwards. The binary
> pipeline is gone, that failure mode is not: `prepare` still has to parse.

## 3. Check the notes

```sh
bun run release:notes vX.Y.Z                  # CHANGELOG block
bun run release:notes vX.Y.Z --release-body   # GitHub Release body
```

Exit codes: `0` clean, `1` problems found (nothing written — fix them, or
`--force` to emit the well-formed subset anyway), `2` fatal (no such milestone,
empty milestone, no usable PRs).

**Nothing to paste.** [Step 4](#4-bump-land-the-pr-tag) generates this same block and
writes it into `CHANGELOG.md` itself, at the
`<!-- releases below … -->` anchor, inside the release commit. This step is the
preview: it prints what step 4 will insert, and its exit code is step 4's — a
non-zero here means `release:prepare` will refuse for the same reason, before it
has touched anything.

The output is byte-compatible with the release-please format the archived
history uses, so there is no format seam between a generated entry and the
pasted ones above it.

> **If you would rather write the entry yourself** — a `--force`d subset, or
> prose no generator would produce — paste it under the anchor and commit it
> first. Step 4 leaves an entry that is already there alone, including the `gh`
> reads, so a hand-written block survives untouched. That is the one path that
> still costs a second commit, and it is opt-in.

## 4. Bump, land the PR, tag

**Two commands, with a merged pull request between them.**

```sh
bun run release:prepare vX.Y.Z   # branch, bump, rebuild, commit, push, open the PR
# … review and merge that PR, then, standing on the merged main:
bun run release:tag vX.Y.Z       # tag main's merged HEAD and push the tag
```

Both are [`scripts/ops/release.ts`](../scripts/ops/release.ts).

> **Why it is two commands and not one.** Nothing reaches `main` outside a pull
> request — `main-require-pr` carries no bypass actor, and that is permanent
> ([`docs/admin/branch-rulesets.md`](admin/branch-rulesets.md)). The release
> commit therefore has to be squash-merged like everything else, and **a squash
> merge rewrites the SHA**. A tag cut before the merge would point at a commit
> `main` never receives. So the tag has to be created afterwards, against the
> commit the merge actually produced — which no single process can do, because
> the merge happens in the GitHub UI in between.
>
> Only the release *commit* ever needed the bypass. Both rulesets are
> `target: branch` and there is no tag ruleset, so `git push origin vX.Y.Z` is
> unrestricted.

> **This is a strengthening, not a workaround.** Under the old direct-push flow
> the release commit was the **one commit that reached `main` completely
> unverified**: the version bump, the regenerated `dist/` and the generated
> changelog all landed with no check run against them. They now go through
> `test`, `windows` and `gate` like every other change — and `bindings:check`,
> inside `test`, is precisely the gate that catches the stale `dist/` this
> tooling was written for. The cost is one merge button; the gain is that the
> release commit stops being the only unreviewed, unchecked commit in the repo.

### 4a. `release:prepare vX.Y.Z`

Seven steps, in that order, in one process:

| # | Step | Refuses on |
|---|---|---|
| 1 | Clean-tree guard | any **tracked** modification, staged or unstaged, including `dist/` |
| 2 | Preflight (`prepack --check`) | the running Bun is not the one in `.bun-version` |
| 3 | [Gate 4](#the-gates) — tag order | the tag already exists, or is not above every tag that does (local **and** `origin`) |
| 4 | [Gate 5](#the-gates) — what is open | a PR still open in the milestone being cut |
| 5 | Generate the `CHANGELOG.md` entry | anything `release:notes vX.Y.Z` would refuse to emit on |
| 6 | `git switch -c release/vX.Y.Z`, then `bumpp --all --no-tag --no-push --release X.Y.Z --execute "<pinned bun> release.ts --rebuild"` | the branch already exists |
| 7 | `git push -u origin release/vX.Y.Z`, then `gh pr create` | — |

**It cuts no tag.** `--no-tag --no-push` is what makes that true: `bumpp`'s
defaults are `{ commit: true, tag: true, push: true }`, so an unflagged run
would tag the branch commit — the SHA the squash is about to discard — and
`bumpp`'s push also runs `git push --tags`. The commit survives both flags
(`normalizeOptions` builds it from `raw.commit`, still defaulting to true), so
the branch still carries the bump, the changelog entry and the rebuilt `dist/`
in one commit, made with `--all`.

Steps 1 to 5 are all **before anything is written**, and step 6's branch is the
first thing that is. Below that line the failure modes are recoverable but never
silent: a failed `bumpp` leaves an empty release branch, a failed push leaves a
committed one, a failed `gh pr create` leaves a pushed one — and the message
says which, and under which title to reopen it. **None of them has cut a tag.**

**The PR's title is `chore: release vX.Y.Z`, and that is load-bearing.** It is
`bumpp`'s own default commit message, so the commit and the PR carry one
subject; and it is the string [gate 5](#the-gates) exempts. Without the
exemption the release PR is a PR open in the milestone being cut, and would
refuse the release it is cutting on the next run — the case where `CHANGELOG.md`
already documents the version, so the changelog step is skipped and gate 5 is
the only thing still reading GitHub. `release.test.ts` pins the title against
`RELEASE_COMMIT_RE` in `release-gates.ts` so the two cannot drift. The PR
carries **no milestone**: a release commit belongs to none, and assigning one
would put the PR into the notes of the release it is cutting.

**The tag is an argument**, and it is required. It names the milestone the
changelog entry is generated from, and it is what `bumpp` bumps `package.json`
to (`--release X.Y.Z`), so [gate 3](#the-gates) — the tag matches the manifest —
holds by construction rather than by a preflight anyone can skip. `--release` is
therefore refused rather than forwarded: one version, one source.

Useful flags — anything the script does not recognise is forwarded to `bumpp`:

```sh
bun run release:prepare vX.Y.Z -y               # non-interactive
bun run release:prepare vX.Y.Z --no-publish     # accepted, does nothing
bun scripts/ops/release.ts --rebuild            # just regenerate + stage dist/, no release
bun run release:preflight                       # step 2 on its own
```

There is **no default phase**: `bun scripts/ops/release.ts vX.Y.Z` refuses and
names both. Running the wrong half silently — opening a second release PR when
you meant to tag the first — is the one new hazard the split introduced.

> **Review the release PR like any other.** It should contain exactly four
> things: the version in `package.json`, one new `CHANGELOG.md` block under the
> anchor, and the regenerated `dist/lib` and `dist/main.js`. Anything else in
> the diff means the clean-tree guard was looking at a different tree from the
> one you are reading.
>
> The branch must be up to date with `main` before it can merge
> (`gh pr update-branch`; nothing rebases for you here). If `main` moved under
> it, updating the branch merges that movement in **without** rebuilding —
> which `bindings:check` will call out as stale. Re-run
> `bun scripts/ops/release.ts --rebuild`, commit, and push.

### 4b. `release:tag vX.Y.Z`

Run it **after the PR merges**, standing on the merged `main`:

```sh
git switch main && git merge --ff-only origin/main
bun run release:tag vX.Y.Z
```

| # | Step | Refuses on |
|---|---|---|
| 1 | `git fetch origin main` | an unreachable remote (exit `2`) |
| 2 | The merged `package.json` is exactly `X.Y.Z` | anything else — the PR did not merge, or something else did |
| 3 | This checkout **is** that commit, with a clean tree | a stale or dirty working copy |
| 4 | [Gate 4](#the-gates) — tag order, again | a tag that appeared while the PR sat open |
| 5 | `git tag -a vX.Y.Z -m "chore: release vX.Y.Z" <merged sha>` | — |
| 6 | `git push origin vX.Y.Z` | — |

**Step 2 is [gate 3](#the-gates) asked at the only moment it can be answered for
certain**: the tag is about to be created on that tree, so comparing the tag
against that tree's `package.json` is the whole assertion.
`release-tag-check.yml` re-runs it on the pushed tag as a tripwire, and by then
the tag exists.

**Step 3 is why the tag is not cut against a SHA nobody checked out.** Tagging a
ref this checkout has never seen would work, and refusing instead is deliberate:
the tree the releaser is looking at is then the tree the tag names, so
`git show`, a local test run and the tag cannot disagree. It also makes the
clean-tree check mean something — on a ref nobody is standing on it would be
checking a tree nobody is about to tag.

**Step 4 is gate 4 for the second time, and the placement is the point.** It
already ran in 4a, but the release PR may have sat open for hours — long enough
for another agent to push the very tag this is about. This is now the last line
before the tag exists.

The pushed tag fires [`release-tag-check.yml`](../.github/workflows/release-tag-check.yml)
and [`publish-package.yml`](../.github/workflows/publish-package.yml).

**If neither fires, they can both be run by hand.** Push events stop dispatching
during an Actions outage — on 2026-08-06 the v0.4.4 tag push produced zero runs —
and "the tripwire did not report" is indistinguishable from "the tripwire passed"
unless you go and look. Both workflows accept a `workflow_dispatch`:

```sh
gh run list --workflow release-tag-check.yml --limit 3   # did it fire at all?
gh workflow run release-tag-check.yml -f tag=vX.Y.Z
gh workflow run publish-package.yml --ref vX.Y.Z -f dry_run=false
```

`release-tag-check.yml` checks out whatever tag it resolves, so the
`package.json` its gates read is the one that tag publishes regardless of which
ref the dispatch came from. It refuses a resolved value that is not a `v*` tag
rather than comparing the string `main` against `package.json` and reporting a
version mismatch that is really an operator error.

> **The rebuild is 4a's `bumpp` step's `--execute` hook, and it is why the commit
> is made with `--all`.** `bun build` inlines `package.json` — `BUILD_VERSION` in
> `src/lib/update/build-info.ts` falls back to `packageJson.version` — so
> bumping the version alone makes the committed bundle stale and turns
> `bindings:check` red. It is genuine drift, not a false positive: that bundle
> is the `bin` a git-dependency install runs, and it would print and report the
> previous version. Measured, same Bun 1.3.11, one bumped version:
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
> refusing on an editor artifact would be a false positive.
>
> The guard does not fight the rebuild, or the changelog write, because of
> *where* it runs: it is step 1, and both of those are inside the `bumpp` step.
> By the time `dist/` and `CHANGELOG.md` are written, the guard has already
> passed — it only ever asks "did the tree match `HEAD` when we started", which
> is true of every tree a previous release left behind.

> **The changelog step fetches and renders; the `bumpp` hook writes.** Splitting
> it that way is what makes 4a runnable top to bottom. The block cannot be
> fetched until the version is known, and it must not be *written* until
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
> script, in the same window as the `dist/` rebuild. A guard whose value is that
> it has no exceptions does not survive its first one.
>
> **An entry that is already there is left alone**, `gh` reads included. A
> re-run after a failed `bumpp`, or a block someone pasted by hand, is detected
> by its `## X.Y.Z` heading and skipped with a note. Nothing is ever rewritten
> or appended twice. That skip is why [gate 5](#the-gates) is a step of its own
> rather than a side effect of generating the notes: `release:notes` refuses on
> an open PR in the milestone, but on the re-run it is never asked — and on that
> same re-run, the release PR is itself open in that milestone.

> **Why the Bun version decides whether a release is cuttable.** `bun publish`
> and `bun pm pack` both fire `prepack`, which rebuilds `dist/` into the tarball
> — and `bun build` bundles with Bun's own bundler, so `dist/main.js` is a
> function of the Bun version ([`docs/bun-version-policy.md`](bun-version-policy.md)).
> Building off-pin ships a `bin` bundle that disagrees with the committed one
> `bindings:check` verifies, and that nobody following these docs can
> regenerate. Measured on `main` at v0.3.2: committed `85697a48…` (Bun 1.3.11,
> the pin) vs a tarball's `ffdee378…` (Bun 1.3.14, whatever was on PATH). The
> published tarball is CI's now, on the pinned Bun — but 4a's rebuild of the
> *committed* `dist/` is still yours, on whatever you have on PATH, which is
> what step 2's preflight refuses. Phase 4b re-asserts nothing: it builds
> nothing, and the bytes it tags were rebuilt in 4a and re-verified by
> `bindings:check` on the PR.
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
> guarded even when run by hand.

Or by hand, if you want the commit message under your own control. **Nothing
below is automated — the rebuild, the changelog entry and the clean-tree check
are yours to remember, and so is the pull request:**

```sh
# on a branch; `main` rejects a direct push, with no exemption
git switch -c release/vX.Y.Z
bun run release:check order vX.Y.Z          # nothing higher is already tagged
git status --porcelain                      # must be empty of tracked changes
bun run release:notes vX.Y.Z                # paste under the CHANGELOG.md anchor
# bump package.json to X.Y.Z by hand
bun scripts/ops/release.ts --rebuild        # regenerate + stage dist/, on the pin
git commit -am "chore: release vX.Y.Z"      # this title is what gate 5 exempts
git push -u origin release/vX.Y.Z
gh pr create --title "chore: release vX.Y.Z" --body …
# … merge it, then:
git switch main && git fetch origin main && git merge --ff-only origin/main
bun run release:check version vX.Y.Z        # the merged manifest matches the tag
bun run release:check order vX.Y.Z          # still nothing higher
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"
git push origin vX.Y.Z
```

> **The by-hand path still needs the rebuild.** `git commit -am` misses new
> files under the gitignored, force-tracked `dist/`, so `bun scripts/ops/release.ts
> --rebuild` is not optional: it regenerates and stages both artifacts, on the
> pinned Bun, and is the same code `release:prepare` runs.
> `git show v0.3.2:dist/main.js` contains `0.3.2`, not `0.3.1` — every release
> before this tooling was rebuilt by hand at this point.

> **Use `-a`.** A lightweight tag (plain `git tag`) drops the annotation, and
> `git tag -f` without `-a` silently downgrades an annotated tag to one. Nothing
> checks this one; `release:tag` always passes `-a`.

> **Tag the merged commit, not the branch.** On the by-hand path this is on you:
> the squash merge produced a new SHA, so `git tag` must run after
> `git merge --ff-only origin/main`, on `main`. `release:tag` refuses unless the
> checkout is exactly that commit.

> **Gate: the tag must match `package.json`.** It has already gone wrong once —
> `v0.1.1` was tagged while `package.json` still read `0.1.0`
> (`git show v0.1.1:package.json`). Milestones make the tag a commitment made
> *in advance*, which widens the window. `bun run release:check version vX.Y.Z`
> above is the preventive check; `release-tag-check.yml` re-runs it on the
> pushed tag as a tripwire. Run the preflight — by the time the tripwire fires,
> the tag exists. On the automated path this cannot arise twice over:
> `release:prepare vX.Y.Z` sets the version *from* the tag, and `release:tag`
> re-reads it off the merged commit before tagging.

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
> check on the by-hand path; `release:prepare` and `release:tag` both run it
> themselves ([gate 4](#the-gates)); and `release-tag-check.yml` re-runs it with
> `--pushed` on the tag itself, so a by-hand push that skipped the preflight is
> still caught — within seconds, while the tag is almost certainly unconsumed
> and can still be deleted.


## 5. Publish the package

Pushing the tag fires two workflows.
[`publish-package.yml`](../.github/workflows/publish-package.yml) publishes the
npm package, described below.
[`release-tag-check.yml`](../.github/workflows/release-tag-check.yml) re-runs
gates 3 and 4 against the tag that was actually pushed.

**There are no binaries to attach.** Core delivered `bun-darwin-arm64` and
`bun-windows-x64` artifacts until v0.4.4; that pipeline is gone, and the
registry package is the delivery path. Nothing here creates a GitHub Release —
create one by hand if you want release notes on the tag:

```sh
gh release create vX.Y.Z --title "vX.Y.Z — <summary>" \
  --notes "$(bun run release:notes vX.Y.Z --release-body)"
```

> **The compiled binary did not disappear, it moved.**
> [`build-sidecar.ts`](https://github.com/stuffbucket/maximal/blob/main/scripts/build-sidecar.ts)
> in `stuffbucket/maximal` runs `bun build --compile` over **this repo's**
> `src/main.ts`, reached through the git dependency, and that is the binary
> that reaches users. It never consumed core's artifacts. So
> nothing downstream broke when this pipeline was removed — but it does mean the
> `src` in the published tarball is load-bearing, which is why `files` ships it.

To exercise a compiled binary against core's own e2e harnesses, point them at
one:

```sh
MAXIMAL_E2E_BINARY=/path/to/maximal-<triple> bun run e2e
```

### The package publish

[`publish-package.yml`](../.github/workflows/publish-package.yml) fires on the
same tag push and runs `bun publish` against the **GitHub Package Registry**
(`npm.pkg.github.com`). GHP requires the package scope to match the owning org;
`@stuffbucket` already does. It authenticates with the per-run `GITHUB_TOKEN`
and a `.npmrc` written in the runner workspace — there is no npm token, no OIDC
config and no committed `.npmrc` anywhere in this repo, and there must not be.

> **`publishConfig.registry` in `package.json` does not redirect `bun publish`
> on its own — the `.npmrc` does.** Measured on Bun 1.3.11 with the field
> already set: a bare `bun publish --dry-run` reports
> `Registry: https://registry.npmjs.org/`, and the same command with the
> workflow's `.npmrc` present reports `Registry: https://npm.pkg.github.com`.
> Bun reads the publish registry from `.npmrc`/bunfig, not from the manifest.
> Both are set and must stay in agreement; deleting the `@stuffbucket:registry=`
> line publishes to npmjs.

Before it publishes it re-runs [gate 3](#the-gates) — `release:check version` —
against the pushed tag, and refuses a real publish from anything that is not a
tag ref.

> **It is `bun publish` and never `npm publish`, and that is not a preference.**
> `prepack` is [`scripts/ops/prepack.ts`](../scripts/ops/prepack.ts), which
> asserts `process.versions.bun` equals `.bun-version` and refuses when it is
> `undefined` — which is what node gives it. A node-driven publish therefore
> fails by construction, and the workflow says so in a comment so nobody
> "simplifies" it back.

**Rehearse it without publishing.** `dry_run` defaults to **true**, so a
dispatch is a rehearsal unless you say otherwise:

```sh
gh workflow run publish-package.yml           # dry run: resolves, packs, uploads nothing
```

Locally, `bun pm pack` produces the same tarball and fires the same `prepack`.
Inspect it before a first publish of any new export or `bin` path — the `files`
list is `dist`, `src` and `tsconfig.json`, and `stuffbucket/maximal` compiles
the sidecar from the shipped `src`.

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
| 3 | The tag matches `package.json` | `release:prepare vX.Y.Z` sets one from the other; **`release:tag vX.Y.Z` re-reads it off the merged commit**; `release:check version` preflight; `release-tag-check.yml` on tag push, or dispatched by hand |
| 4 | The tag does not exist and is above every release tag that does, locally **and** on `origin` | **`release:prepare vX.Y.Z`, before the bump, and `release:tag vX.Y.Z`, before the tag**; `release:check order` preflight and by-hand path; `release-tag-check.yml` on tag push (`--pushed`), or dispatched by hand |
| 5 | Nothing still open claims to ship in this release | **`release:prepare vX.Y.Z`, before the bump**; `release:check milestone` at preflight |

```sh
bun run release:check pr <n>              # gates 1 + 2 for one PR
bun run release:check milestone vX.Y.Z    # gate 2 across the whole milestone, + gate 5
bun run release:check order vX.Y.Z        # gate 4
bun run release:check version vX.Y.Z      # gate 3
```

Exit codes: `0` clean · `1` a convention was violated · `2` **the gate could not
run** (a `gh` failure, unparseable JSON, a missing `package.json`). Both
workflows treat `2` as non-blocking on purpose: a gate that fails closed on its
own bugs takes the repo down with it. **`release:prepare` and `release:tag` are
the deliberate exception** — there, a `2` from gate 4 or 5 stops the release,
because the only cost is a re-run and the only alternative is a tag nobody can
move.

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

So gate 4 runs **inside `release:prepare`, ahead of `bumpp`** — the same argument
the clean-tree guard makes — and **again inside `release:tag`, immediately before
the tag is created**. The second placement is not redundant: the release PR sits
open for as long as review takes, which is easily long enough for another agent
to push the tag this release is about, and `release:tag` is now the last line
before the tag exists. It also runs in `release-tag-check.yml`, because the
by-hand path below skips both commands entirely and an alarm within seconds of
the push still lands while the tag is deletable.

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
ignore it. So it lists and does not block, the same shape `release:prepare` uses
for untracked files.

The first row was already covered *by accident*: `release:notes` refuses to emit
when a milestone holds an open PR. It is stated as a rule here because that
accident has a hole — `release:prepare` skips the changelog step, `gh` reads
included, when `CHANGELOG.md` already documents the version, so a re-run after a
failed `bumpp` cut the tag with the open PR unnoticed.

**The release PR is exempt from this row, and the two-phase flow depends on it.**
Since the release commit now lands through a pull request, that PR is open in the
milestone being cut from the moment `release:prepare` finishes — and on the
re-run above, where the changelog step is skipped, gate 5 is the only thing still
reading GitHub. `exemption` in `release-gates.ts` skips any PR whose **title** is
`chore: release vX.Y.Z`, the same string that exempts it from gates 1 and 2, so
it does not refuse the release it is cutting. The signal is the title rather than
the branch name because the title is what squash-merge turns into the commit
subject and what every other gate already reads; a branch name is a convention
nothing verifies. `release.test.ts` pins `releaseCommitSubject` against
`RELEASE_COMMIT_RE` so the producer and the exemption cannot drift.

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
- **Neither ruleset has a bypass actor**, and that includes the release. There
  is no exemption left at all.

> **The release used to be the one exemption, and it is not any more.**
> `main-require-pr` once carried an always-mode admin bypass so `release:manual`
> could push the release commit straight to `main`. `bypass_actors` is now empty
> on both rulesets, permanently, so [step 4](#4-bump-land-the-pr-tag) lands the
> release commit through a pull request like everything else and cuts the tag
> afterwards. `bun run rules:check` asserts a bypass is **absent** — a bypass
> actor reappearing on `main-require-pr` is drift now, not a requirement.
>
> Tags are unaffected: both rulesets are `target: branch` and there is no tag
> ruleset, so `git push origin vX.Y.Z` needs no permission this repo restricts.

---

## What this repo does *not* have

Listed so nobody re-derives it from a stale doc:

- **No package on npmjs, and no npm credential.** The package publishes to the
  **GitHub Package Registry**, not to npmjs:
  `https://registry.npmjs.org/@stuffbucket/maximal-core` still 404s and nothing
  here will change that. There is no npm token and no OIDC trusted-publishing
  config in this repo, and GHP needs neither — the per-run `GITHUB_TOKEN` and
  `packages: write` are the whole grant. A consumer therefore needs
  `@stuffbucket:registry=https://npm.pkg.github.com` and an authenticated
  install; GHP has no anonymous read.
- **No publish from a laptop.** [`publish-package.yml`](../.github/workflows/publish-package.yml)
  is the only thing that publishes ([step 5](#the-package-publish)), and it
  pins the Bun version by construction — which is exactly why it exists.
  `release:prepare` does not run `bun publish`; `--no-publish` is accepted and
  does nothing. [`scripts/ops/prepack.ts`](../scripts/ops/prepack.ts) still
  guards the pin, both inside that workflow and for a by-hand `bun pm pack`.
- **Releases v0.2.0 … v0.4.3 shipped without a package at all** — a git tag plus
  the compiled binaries core built at the time, because every one of them ran
  `--no-publish`. That is why `dist/` is committed (see
  [`scripts/ops/check-bindings.ts`](../scripts/ops/check-bindings.ts)) and why
  the git-dependency install path must keep working: consumers pinned to those
  tags resolve a SHA, not a version. Treat the first publish as a first publish
  — rehearse with `bun pm pack` and the workflow's `dry_run` dispatch, and read
  the tarball's file list, before a tag pushes it for real.
- **No release PR that opens itself.** The release now lands *through* a PR, but
  nothing opens one on a schedule, on a merge, or from a label: `release:prepare`
  is run by a human who has already chosen the version from the milestone. There
  is no bot to merge it either, and no `main` bypass to skip it with — the merge
  button is a deliberate act, and the release commit waits on `test`, `windows`
  and `gate` like every other commit.
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
  MSI, or Pages deploy — and no compiled artifact to apply any of them to. Core
  built `bun-darwin-arm64` and `bun-windows-x64` until v0.4.4; delivery is the
  registry package now. The binary that reaches users is compiled in
  `stuffbucket/maximal` from this repo's `src/main.ts`, and signing it is that
  repo's problem, with credentials that do not exist here either.
- No proof that the engine shuts down *gracefully* on Windows. `ci.yml`'s
  `windows` job runs the unit suite there but not `e2e` — the lifecycle harness
  stopped spawning POSIX `sleep` as its decoy parent and would port, but nothing
  runs it on Windows today (#89). Underneath that is a platform limit no harness
  closes: Windows has no SIGTERM, `child.kill("SIGTERM")` is `TerminateProcess`,
  and nothing in Node or Bun can deliver a graceful stop to a child there. So a
  Windows shutdown check could only prove the process is terminable;
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
  is deletable. Gate 5 has no equivalent: it runs only inside `release:prepare`
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
  enforces, and why the release flow has no exemption from it
- [`docs/architecture.md`](architecture.md) → _Release & PR conventions_
- [`scripts/ops/release.ts`](../scripts/ops/release.ts) — both phases end to
  end, the argument for the two-phase split, and the argument for the clean-tree
  definition and the `--all` / `--execute` pair
- [`scripts/ops/release-notes.ts`](../scripts/ops/release-notes.ts) — the
  generator, and the rationale in its header comment
- [`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts) — the five
  gates, and the argument for where each one runs
- [`docs/archive/CHANGELOG-maximal.md`](archive/CHANGELOG-maximal.md) — the
  frozen pre-split history
