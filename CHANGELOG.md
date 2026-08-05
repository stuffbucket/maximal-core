# Changelog

Releases of `maximal-core`. Generated from the GitHub milestone whose title is
the tag being cut:

```sh
bun run release:notes v0.2.1
```

Whatever is assigned to the milestone is what ships, so the contents of a
release are reviewable before the tag exists. See
[`docs/release-runbook.md`](docs/release-runbook.md).

Versions follow Conventional Commit types on the **PR title**, which becomes the
squash-merge subject. While this package is pre-1.0, `feat:` and `fix:` both cut
a patch and a breaking change (`feat!:` / `fix!:`) cuts a minor — so a breaking
change always lands outside a consumer's `^0.y.z` range and can never arrive by
way of a routine upgrade.

Two notes on what is *not* here:

- **`v0.1.0`, `v0.1.1` and `v0.2.0` predate this file.** They were tagged by
  hand before the milestone process existed; see the
  [releases page](https://github.com/stuffbucket/maximal-core/releases). Be
  aware that `v0.1.1` was tagged while `package.json` still read `0.1.0`.
- **History before the split** — this package was extracted from
  [`stuffbucket/maximal`](https://github.com/stuffbucket/maximal) in August
  2026. That repo's changelog came across with the split and now lives, frozen,
  at [`docs/archive/CHANGELOG-maximal.md`](docs/archive/CHANGELOG-maximal.md).
  It is retained because it is the accurate history of the code that became this
  package, but every link in it points at the parent repo and none of its
  entries describes a `maximal-core` release.

<!-- releases below — newest first; `release:notes` output is inserted here -->

## [0.2.1](https://github.com/stuffbucket/maximal-core/compare/v0.2.0...v0.2.1) (2026-08-05)


### Features

* **ops:** generate release notes from a milestone ([#17](https://github.com/stuffbucket/maximal-core/issues/17)) ([862cf7c](https://github.com/stuffbucket/maximal-core/commit/862cf7c535c96407aed038071fd8b775b2ea22dd))


### Bug Fixes

* **messages:** stop message_start reporting zero input tokens on the Responses flow ([#16](https://github.com/stuffbucket/maximal-core/issues/16)) ([9b294df](https://github.com/stuffbucket/maximal-core/commit/9b294df27b8037cd874ff4443a0e6c2d44b7a42f))
