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

Two notes on provenance:

- **`v0.1.0`, `v0.1.1` and `v0.2.0` were reconstructed from `git log`.** They
  were tagged before the milestone process existed, so there is no milestone to
  regenerate them from; their entries below were written by hand in the shape
  `release:notes` emits. Two artefacts of that era survive in them: the `0.1.x`
  work landed directly on `main` rather than through pull requests, so those
  bullets carry a commit link and no PR link; and `v0.1.1` was tagged while
  `package.json` still read `0.1.0` — the tag is the release, the manifest was
  simply never bumped.
- **History before the split** — this package was extracted from
  [`stuffbucket/maximal`](https://github.com/stuffbucket/maximal) in August
  2026, at `ced18dd`, which is where `0.1.0` below begins. That repo's changelog
  came across with the split and now lives, frozen, at
  [`docs/archive/CHANGELOG-maximal.md`](docs/archive/CHANGELOG-maximal.md).
  It is retained because it is the accurate history of the code that became this
  package, but every link in it points at the parent repo and none of its
  entries describes a `maximal-core` release.

<!-- releases below — newest first; `release:notes` output is inserted here -->

## [0.3.1](https://github.com/stuffbucket/maximal-core/compare/v0.3.0...v0.3.1) (2026-08-05)


### Features

* **ops:** enforce the milestone, semver, and tag-match release gates ([#21](https://github.com/stuffbucket/maximal-core/issues/21)) ([222dfbb](https://github.com/stuffbucket/maximal-core/commit/222dfbbdb4ca174219ca8075ecf91f8f73d5c1a0))


### Tests

* prove the published contract typechecks from a downstream consumer ([#22](https://github.com/stuffbucket/maximal-core/issues/22)) ([9912070](https://github.com/stuffbucket/maximal-core/commit/99120704f1287eae1e9c2ebaaa55a04848e27aee))

## [0.3.0](https://github.com/stuffbucket/maximal-core/compare/v0.2.1...v0.3.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* **server:** split /v1 and the control plane onto separate listeners ([#14](https://github.com/stuffbucket/maximal-core/issues/14)) ([4418483](https://github.com/stuffbucket/maximal-core/commit/4418483658d7e977ec2fc2b88cd413e42ae08a16)), closes [#10](https://github.com/stuffbucket/maximal-core/issues/10)


### Features

* **server:** split /v1 and the control plane onto separate listeners ([#14](https://github.com/stuffbucket/maximal-core/issues/14)) ([4418483](https://github.com/stuffbucket/maximal-core/commit/4418483658d7e977ec2fc2b88cd413e42ae08a16)), closes [#10](https://github.com/stuffbucket/maximal-core/issues/10)


### Bug Fixes

* **supervisor:** regenerate published bindings stranded by the listener split ([#19](https://github.com/stuffbucket/maximal-core/issues/19)) ([7a78b4f](https://github.com/stuffbucket/maximal-core/commit/7a78b4f9251e0be944bfa73edd5dc13da3c9f6cc))
* **supervisor:** stop the ready-line schema lying about its own version field ([#20](https://github.com/stuffbucket/maximal-core/issues/20)) ([9fb5fcf](https://github.com/stuffbucket/maximal-core/commit/9fb5fcfa6c707ba042e6d0fd17f840304a81d5cb))


### Documentation

* **changelog:** backfill v0.1.0, v0.1.1 and v0.2.0 entries ([#18](https://github.com/stuffbucket/maximal-core/issues/18)) ([f1c21c6](https://github.com/stuffbucket/maximal-core/commit/f1c21c6a5771b501d5692a28379cd2cea3da2110))

## [0.2.1](https://github.com/stuffbucket/maximal-core/compare/v0.2.0...v0.2.1) (2026-08-05)


### Features

* **ops:** generate release notes from a milestone ([#17](https://github.com/stuffbucket/maximal-core/issues/17)) ([862cf7c](https://github.com/stuffbucket/maximal-core/commit/862cf7c535c96407aed038071fd8b775b2ea22dd))


### Bug Fixes

* **messages:** stop message_start reporting zero input tokens on the Responses flow ([#16](https://github.com/stuffbucket/maximal-core/issues/16)) ([9b294df](https://github.com/stuffbucket/maximal-core/commit/9b294df27b8037cd874ff4443a0e6c2d44b7a42f))

## [0.2.0](https://github.com/stuffbucket/maximal-core/compare/v0.1.1...v0.2.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* stateless JSON-RPC 2.0 control plane, sidecar supervision, and a busy-port policy ([#11](https://github.com/stuffbucket/maximal-core/issues/11)) ([867dfc4](https://github.com/stuffbucket/maximal-core/commit/867dfc4811a94efe6fb58cf5c895f00c2cd17bb2))


### Features

* stateless JSON-RPC 2.0 control plane, sidecar supervision, and a busy-port policy ([#11](https://github.com/stuffbucket/maximal-core/issues/11)) ([867dfc4](https://github.com/stuffbucket/maximal-core/commit/867dfc4811a94efe6fb58cf5c895f00c2cd17bb2))


### Build System

* compile the sidecar to a signable executable and test that artifact ([#12](https://github.com/stuffbucket/maximal-core/issues/12)) ([acd4c72](https://github.com/stuffbucket/maximal-core/commit/acd4c7210d1dd7fe74cf89f4a6805ad5f71216ff))

## [0.1.1](https://github.com/stuffbucket/maximal-core/compare/v0.1.0...v0.1.1) (2026-08-04)


### Build System

* **pkg:** ship tsconfig.json so sidecar compiles from an installed dep ([d607485](https://github.com/stuffbucket/maximal-core/commit/d607485f8f93164c7174d054bdb1f01aa2b3534d))

## 0.1.0 (2026-08-03)


### Features

* **control:** api-keys, gh, app toggles, diagnostics endpoints ([931dec9](https://github.com/stuffbucket/maximal-core/commit/931dec998a970fa8e98b772324c724790b8b9dbf))
* **control:** auth flow + models/refresh + update-status endpoints ([ec03f19](https://github.com/stuffbucket/maximal-core/commit/ec03f195cb31d3acec1501f5ad63d6e33e199572))
* **control:** ControlClient — the fetch-reader consumer SDK ([69f3649](https://github.com/stuffbucket/maximal-core/commit/69f3649e9992a6d4900f87d447f0a0f3b31fbb03))
* **control:** live /control API + SSE event stream over the ControlHub ([71065ed](https://github.com/stuffbucket/maximal-core/commit/71065ed8d1d4cfd257581369e3c770bd4ef37038))
* **control:** live account switch via activateAccountLive ([bf57c2e](https://github.com/stuffbucket/maximal-core/commit/bf57c2e1cde92485caf4ef94c5860d3c66e6b027))
* **live:** ControlHub spike — cursor/ring/epoch SSE fan-out ([20fcb62](https://github.com/stuffbucket/maximal-core/commit/20fcb621b834b32791c674fdc84a6f9c0da194a8))


### Build System

* **lib:** make core consumable — exports map + tsup lib build ([e2e8089](https://github.com/stuffbucket/maximal-core/commit/e2e80891e43daa8903da6a09c281672faed2eee9))
* **pkg:** ship dist/lib and src for git-dependency installs ([f79f7b6](https://github.com/stuffbucket/maximal-core/commit/f79f7b630cc164d60a1432cf9e7f87b2d7a0a752))


### Documentation

* **spec:** add control API + live event stream design ([3586c43](https://github.com/stuffbucket/maximal-core/commit/3586c43026a3e6fca2c4d316e55a76afc152bc9b))


### Miscellaneous Chores

* **core:** stabilize control surface, docs, knip, and CI ([c38616d](https://github.com/stuffbucket/maximal-core/commit/c38616d299d749aa66ef49ce3a7f5b4790a734ba))
* extract headless proxy core, drop all UI surfaces ([ced18dd](https://github.com/stuffbucket/maximal-core/commit/ced18ddad9dcb9e04885bc88ac8257befa605ef0))
