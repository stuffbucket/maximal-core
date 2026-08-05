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
well-formed.

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
bun run check:deep        # lint, typecheck, casts:check, tests, knip, build
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
bun run release:manual    # bumpp prompts for the version; commits, tags, pushes
```

Or by hand, if you want the commit message under your own control:

```sh
# package.json version MUST match the tag — checked by the preflight below
bun run release:check version vX.Y.Z
git commit -am "chore: release X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"
git push && git push origin vX.Y.Z
```

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


## 5. Build the artifact and publish

```sh
bun run build:binary      # compiled, signable Mach-O / PE per target
bun run verify:build      # asserts x-maximal-version matches the build
bun run e2e:binary        # the e2e suite against the compiled artifact
```

```sh
gh release create vX.Y.Z --title "vX.Y.Z — <summary>" \
  --notes "$(bun run release:notes vX.Y.Z --release-body)"
```

Attach the binaries if the release ships them.

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

- No `release-please.yml`, no `release.yml`, no auto-opened release PR, no
  `autorelease:` labels, and no release-please config. `release-please-config.json`
  and `.release-please-manifest.json` were inert leftovers of the split and are
  deleted; the bump convention they recorded lives in
  [Choosing the version](#choosing-the-version) and in `requiredBump`, and the
  manifest's copy of the version had already drifted from `package.json`.
- No `Release-As:` handling. Nothing reads the trailer; the milestone title
  carries that intent now. (Commit `867dfc4` used one and a human honoured it
  by hand.)
- No CI signing, notarization, stapling, DMG packaging, checksums, Homebrew tap,
  Windows MSI, or Pages deploy. `build:binary` produces a **signable** artifact;
  it does not sign it.
- No check that a tag is *annotated*. `release-tag-check.yml` compares the
  version and nothing else; `-a` is still on you.
- No prerelease support anywhere. `vX.Y.Z-rc.1` is not a release tag to any of
  this tooling, and a milestone named that fails gate 1.
- No automatic *creation* of the next milestone, and no check that a merged PR's
  milestone is still open.


## See also

- [`docs/architecture.md`](architecture.md) → _Release & PR conventions_
- [`scripts/ops/release-notes.ts`](../scripts/ops/release-notes.ts) — the
  generator, and the rationale in its header comment
- [`scripts/ops/release-gates.ts`](../scripts/ops/release-gates.ts) — the three
  gates, and the argument for where each one runs
- [`docs/archive/CHANGELOG-maximal.md`](archive/CHANGELOG-maximal.md) — the
  frozen pre-split history
