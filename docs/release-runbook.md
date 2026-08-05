# Release runbook

Single source of truth for shipping a release.

**This repo has no release automation.** `release-please.yml` and `release.yml`
do not exist in `.github/workflows/`, nothing reads `release-please-config.json`
or `.release-please-manifest.json`, and every tag so far was cut by hand. If you
came here from an older revision of this file, or from a doc that describes a
release PR opening itself: that pipeline was inherited from
[`stuffbucket/maximal`](https://github.com/stuffbucket/maximal) in the core
split and was never carried over. Do not go looking for it.

What exists instead is deliberate and manual, in five steps.

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

`feat:` cutting a *patch* is the pre-1.0 convention `release-please-config.json`
declares (`bump-minor-pre-major` + `bump-patch-for-minor-pre-major`). It is kept
because the reason for it is load-bearing:

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

## 2. Pre-flight

CI (`ci.yml`) gates every PR, so a green milestone is already most of this.
`check:deep` is a strict superset of what CI runs:

```sh
bun install
bun run check:deep        # lint, typecheck, casts:check, tests, knip, build
bun run e2e               # seam + feed + lifecycle harnesses
```

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
# package.json version MUST match the tag — see the gate below
git commit -am "chore: release X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"
git push && git push origin vX.Y.Z
```

> **Use `-a`.** A lightweight tag (plain `git tag`) drops the annotation, and
> `git tag -f` without `-a` silently downgrades an annotated tag to one.

> **Gate: the tag must match `package.json`.** Nothing checks this. It has
> already gone wrong once — `v0.1.1` was tagged while `package.json` still read
> `0.1.0` (`git show v0.1.1:package.json`). Milestones make the tag a commitment
> made *in advance*, which widens the window. Verify before pushing:
>
> ```sh
> test "v$(node -p 'require("./package.json").version')" = "vX.Y.Z" \
>   && echo ok || echo MISMATCH
> ```

> **Never move a published tag.** Retagging does not re-resolve a consumer's
> `bun.lock` — it pins the old commit SHA, so `bun install --force` reinstalls
> the *old* tree and only `bun update` re-resolves. A moved tag means two
> machines can hold different code under one version.

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

## What this repo does *not* have

Listed so nobody re-derives it from a stale doc:

- No `release-please.yml`, no `release.yml`, no auto-opened release PR, no
  `autorelease:` labels. `release-please-config.json` and
  `.release-please-manifest.json` are inert — kept only because they record the
  pre-1.0 bump convention above.
- No `Release-As:` handling. Nothing reads the trailer; the milestone title
  carries that intent now. (Commit `867dfc4` used one and a human honoured it
  by hand.)
- No CI signing, notarization, stapling, DMG packaging, checksums, Homebrew tap,
  Windows MSI, or Pages deploy. `build:binary` produces a **signable** artifact;
  it does not sign it.
- No gate that the tag matches `package.json`, that a PR carries a milestone, or
  that a breaking change was bumped as a minor. All three are conventions this
  document asserts and a human upholds.

## See also

- [`docs/architecture.md`](architecture.md) → _Release & PR conventions_
- [`scripts/ops/release-notes.ts`](../scripts/ops/release-notes.ts) — the
  generator, and the rationale in its header comment
- [`docs/archive/CHANGELOG-maximal.md`](archive/CHANGELOG-maximal.md) — the
  frozen pre-split history
