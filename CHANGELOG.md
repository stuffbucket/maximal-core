# Changelog

Releases of `maximal-core`. Generated from the GitHub milestone whose title is
the tag being cut, and inserted at the anchor below by the release itself:

```sh
bun run release:notes v0.2.1     # preview the block
bun run release:prepare v0.2.1   # generate it, insert it, and open the release PR
bun run release:tag v0.2.1       # once that PR has merged
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

<!-- releases below — newest first; `release:prepare vX.Y.Z` inserts the generated block here -->

## [0.6.3](https://github.com/stuffbucket/maximal-core/compare/v0.6.2...v0.6.3) (2026-08-09)


### Bug Fixes

* **ci:** name the toolchain image by its per-pin tag, not by latest ([#130](https://github.com/stuffbucket/maximal-core/issues/130)) ([850136d](https://github.com/stuffbucket/maximal-core/commit/850136df496c43f60c3ce3f878077e869a4127e4)), closes [#126](https://github.com/stuffbucket/maximal-core/issues/126)
* **container:** mount a linked worktree's git dir so bindings:check can actually run ([#131](https://github.com/stuffbucket/maximal-core/issues/131)) ([9e01350](https://github.com/stuffbucket/maximal-core/commit/9e01350c34a5650f518ae2cd82f9120ccf03221b)), closes [#124](https://github.com/stuffbucket/maximal-core/issues/124)

## [0.6.2](https://github.com/stuffbucket/maximal-core/compare/v0.6.1...v0.6.2) (2026-08-09)


### Miscellaneous Chores

* **toolchain:** pin Bun 1.3.14, digest-pin the CI base image, and refuse off-pin builds ([#125](https://github.com/stuffbucket/maximal-core/issues/125)) ([759509e](https://github.com/stuffbucket/maximal-core/commit/759509e235272e577efe9d20a9127d0c28fc07a7))

## [0.6.1](https://github.com/stuffbucket/maximal-core/compare/v0.6.0...v0.6.1) (2026-08-09)


### Features

* **auth:** accept a GITHUB_API_BASE override for the GitHub hosts ([#118](https://github.com/stuffbucket/maximal-core/issues/118)) ([2050e45](https://github.com/stuffbucket/maximal-core/commit/2050e4592726021de2d6672512a3b30990dcf717)), closes [#5](https://github.com/stuffbucket/maximal-core/issues/5)
* **control:** publish the auth/status union and pin the client's protocol version ([#117](https://github.com/stuffbucket/maximal-core/issues/117)) ([ba0b8c1](https://github.com/stuffbucket/maximal-core/commit/ba0b8c17e278e853852592b50e697c7cdb32ead3))
* **paths:** add a COPILOT_API_HOME_POLICY knob for requiring an existing home ([#121](https://github.com/stuffbucket/maximal-core/issues/121)) ([040d4c1](https://github.com/stuffbucket/maximal-core/commit/040d4c1873cce7f555e4839fde502024c62c9919)), closes [#2](https://github.com/stuffbucket/maximal-core/issues/2)
* **update:** refuse proxy traffic below the manifest's min_supported_version ([#122](https://github.com/stuffbucket/maximal-core/issues/122)) ([af85ed1](https://github.com/stuffbucket/maximal-core/commit/af85ed1982c8f345add406ffdb3052a78745d112)), closes [#7](https://github.com/stuffbucket/maximal-core/issues/7)


### Bug Fixes

* **auth:** log a failed Copilot re-mint instead of silently calling it offline ([#119](https://github.com/stuffbucket/maximal-core/issues/119)) ([76f7834](https://github.com/stuffbucket/maximal-core/commit/76f783490d9bbadcbb6cc89b41031599260328ea))
* **build:** make the emitted settings-types declaration deterministic ([#123](https://github.com/stuffbucket/maximal-core/issues/123)) ([0bca45f](https://github.com/stuffbucket/maximal-core/commit/0bca45fa65aa7384ca195252ae2e577fc12e636e))
* **logger:** scrub secrets on the tee logger's console path, not only the file ([#127](https://github.com/stuffbucket/maximal-core/issues/127)) ([ac8e131](https://github.com/stuffbucket/maximal-core/commit/ac8e13146f6b4eb3a6dc830db99f88547dce56d4))
* **test:** reset the copilot token trio through its owner in token-auth-fatal ([#116](https://github.com/stuffbucket/maximal-core/issues/116)) ([4772eac](https://github.com/stuffbucket/maximal-core/commit/4772eac8f4a92557a8f174ec2d65257caacfd1d5)), closes [#108](https://github.com/stuffbucket/maximal-core/issues/108)


### Continuous Integration

* **triage:** remove the triage caller stub that could never resolve ([#114](https://github.com/stuffbucket/maximal-core/issues/114)) ([0856742](https://github.com/stuffbucket/maximal-core/commit/085674277e8bb20ad9bf2fbf938153e835138b56)), closes [#106](https://github.com/stuffbucket/maximal-core/issues/106)


### Documentation

* **architecture:** state that agent-run state is out of scope for the control plane ([#115](https://github.com/stuffbucket/maximal-core/issues/115)) ([de61810](https://github.com/stuffbucket/maximal-core/commit/de618101aae2b836337eb2b17af1915d7d8ea8f9)), closes [#109](https://github.com/stuffbucket/maximal-core/issues/109)


### Tests

* **auth:** assert a real boot never emits the stored GitHub token ([#120](https://github.com/stuffbucket/maximal-core/issues/120)) ([51ab94b](https://github.com/stuffbucket/maximal-core/commit/51ab94b42ff8e0f5ed8ccf8a3a781d035fcd6fc6)), closes [#6](https://github.com/stuffbucket/maximal-core/issues/6)


### Miscellaneous Chores

* **deps:** reconcile external-surface drift (claude-code 2.1.226, opencode 1.18.15) ([#113](https://github.com/stuffbucket/maximal-core/issues/113)) ([dac0e75](https://github.com/stuffbucket/maximal-core/commit/dac0e75736e8166b3d727bb7ca0f19f9220bbe8c)), closes [#1](https://github.com/stuffbucket/maximal-core/issues/1)

## [0.6.0](https://github.com/stuffbucket/maximal-core/compare/v0.5.1...v0.6.0) (2026-08-09)


### Features

* **supervisor:** publish the boot/quit/update markers and a boot-status parser ([#111](https://github.com/stuffbucket/maximal-core/issues/111)) ([8f9eb72](https://github.com/stuffbucket/maximal-core/commit/8f9eb7245e12883f62841b799b440d424af8b7ff)), closes [#110](https://github.com/stuffbucket/maximal-core/issues/110)

## [0.5.1](https://github.com/stuffbucket/maximal-core/compare/v0.5.0...v0.5.1) (2026-08-07)


### Bug Fixes

* **client:** bind the default fetch to globalThis ([#105](https://github.com/stuffbucket/maximal-core/issues/105)) ([5422724](https://github.com/stuffbucket/maximal-core/commit/54227244f2fb034ef844244e96a99fef2930a57b)), closes [#104](https://github.com/stuffbucket/maximal-core/issues/104)
* **release:** consent to bumpp's prompt when there is no TTY ([#103](https://github.com/stuffbucket/maximal-core/issues/103)) ([191959a](https://github.com/stuffbucket/maximal-core/commit/191959a232d3d0144058714ef0c6e6dd13bc0c54))

## [0.5.0](https://github.com/stuffbucket/maximal-core/compare/v0.4.5...v0.5.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* **ci:** remove the compiled-binary pipeline ([#97](https://github.com/stuffbucket/maximal-core/issues/97)) ([e1a448a](https://github.com/stuffbucket/maximal-core/commit/e1a448aa6285e8084ef758810ea129641ceb0433))
* **client:** reject credential headers on ControlClient ([#52](https://github.com/stuffbucket/maximal-core/issues/52)) ([090fd1a](https://github.com/stuffbucket/maximal-core/commit/090fd1aa46e61b0a8120b34991b1ec8808f0e630))


### Features

* **client:** reject credential headers on ControlClient ([#52](https://github.com/stuffbucket/maximal-core/issues/52)) ([090fd1a](https://github.com/stuffbucket/maximal-core/commit/090fd1aa46e61b0a8120b34991b1ec8808f0e630))


### Continuous Integration

* run the test job in the pinned toolchain image ([#101](https://github.com/stuffbucket/maximal-core/issues/101)) ([b8b5d80](https://github.com/stuffbucket/maximal-core/commit/b8b5d80e18063a3a673f090446b80e651e27a84f)), closes [#88](https://github.com/stuffbucket/maximal-core/issues/88)


### Miscellaneous Chores

* **ci:** remove the compiled-binary pipeline ([#97](https://github.com/stuffbucket/maximal-core/issues/97)) ([e1a448a](https://github.com/stuffbucket/maximal-core/commit/e1a448aa6285e8084ef758810ea129641ceb0433))

## [0.4.5](https://github.com/stuffbucket/maximal-core/compare/v0.4.4...v0.4.5) (2026-08-07)


### Bug Fixes

* **auth:** stop proxying a Copilot bearer that is known expired ([#86](https://github.com/stuffbucket/maximal-core/issues/86)) ([3eb7a14](https://github.com/stuffbucket/maximal-core/commit/3eb7a14247a7994525988ecc4396c6f2df81f1db))
* **bin:** declare the Bun shebang the CLI bundle actually needs ([#95](https://github.com/stuffbucket/maximal-core/issues/95)) ([a018b94](https://github.com/stuffbucket/maximal-core/commit/a018b94c5771e449ccb7e8ddfb1c74b81c54bfb3)), closes [#94](https://github.com/stuffbucket/maximal-core/issues/94)
* **release:** refuse to tag a merged head that is not the release commit ([#87](https://github.com/stuffbucket/maximal-core/issues/87)) ([3b00371](https://github.com/stuffbucket/maximal-core/commit/3b00371ab04ecfcd515c0dc534cc4b31ed3bd14b))


### Build System

* **ci:** add a pinned toolchain container for running checks locally ([#91](https://github.com/stuffbucket/maximal-core/issues/91)) ([de6ecf7](https://github.com/stuffbucket/maximal-core/commit/de6ecf71755d1faeb8c519bb590273ee19ed858f))


### Continuous Integration

* make CI dispatchable by hand ([#99](https://github.com/stuffbucket/maximal-core/issues/99)) ([5b2d7a8](https://github.com/stuffbucket/maximal-core/commit/5b2d7a80d61831216cad70adb8fc5332d63a8f12))
* publish the pinned toolchain image to GHCR ([#98](https://github.com/stuffbucket/maximal-core/issues/98)) ([17299f4](https://github.com/stuffbucket/maximal-core/commit/17299f4d024b9f711a659b957d4a6f3aecea6b58))
* **release:** let the tag tripwire be dispatched by hand ([#93](https://github.com/stuffbucket/maximal-core/issues/93)) ([b12e1ca](https://github.com/stuffbucket/maximal-core/commit/b12e1cabf5a7eaf70a9a8b17108aa2971cd61743))


### Documentation

* **update:** name both producers of the build-info defines ([#96](https://github.com/stuffbucket/maximal-core/issues/96)) ([fd3215e](https://github.com/stuffbucket/maximal-core/commit/fd3215e5871ef96bf59ba584d76c94e76c2e72fc))


### Miscellaneous Chores

* **config:** reconcile external-surface drift from #1 ([#85](https://github.com/stuffbucket/maximal-core/issues/85)) ([f2a07c0](https://github.com/stuffbucket/maximal-core/commit/f2a07c050b177f33d18c3880d76f30b1ba069170))

## [0.4.4](https://github.com/stuffbucket/maximal-core/compare/v0.4.3...v0.4.4) (2026-08-06)


### Features

* **release:** land the release commit through a PR, tag main afterwards ([#83](https://github.com/stuffbucket/maximal-core/issues/83)) ([1038e3a](https://github.com/stuffbucket/maximal-core/commit/1038e3ad78430aa24e29558c5abbef6f8859bfda))
* **release:** publish the package from CI to the GitHub Package Registry ([#82](https://github.com/stuffbucket/maximal-core/issues/82)) ([c390c57](https://github.com/stuffbucket/maximal-core/commit/c390c576b5e9b9ef1ba5c974914e04c2fe92f372))


### Bug Fixes

* four boundary and reachability bugs — a corrupt usage DB kills the proxy after boot, and three more ([#68](https://github.com/stuffbucket/maximal-core/issues/68)) ([02bbbb3](https://github.com/stuffbucket/maximal-core/commit/02bbbb300eb52258b154309df04b857bae5078f9))
* **harness:** drain sidecar stderr from spawn so a failed boot names its cause ([#74](https://github.com/stuffbucket/maximal-core/issues/74)) ([2820a9e](https://github.com/stuffbucket/maximal-core/commit/2820a9e253c9bff79a9b1ba091629ac3405b733d))
* **harness:** make every e2e failure detail state what was observed ([#78](https://github.com/stuffbucket/maximal-core/issues/78)) ([19d70d6](https://github.com/stuffbucket/maximal-core/commit/19d70d632c88938a8269532d3eb64a19d68c5aaf))
* **knip:** report src exports whose only importer is a test ([#63](https://github.com/stuffbucket/maximal-core/issues/63)) ([3ad103f](https://github.com/stuffbucket/maximal-core/commit/3ad103fa70c42f6cc2229041105ed2368f6bec61))
* **mutation:** stop scoring a truncated test run as a surviving mutant ([#80](https://github.com/stuffbucket/maximal-core/issues/80)) ([aacef4d](https://github.com/stuffbucket/maximal-core/commit/aacef4d31bee42505cff5f36ed971ff6ca22083c))
* **release:** refuse a tag that is not above every tag that exists ([#60](https://github.com/stuffbucket/maximal-core/issues/60)) ([09e4b89](https://github.com/stuffbucket/maximal-core/commit/09e4b8929d01513a9e7b988518b98a45e369d638))
* **scripts:** fail check:deep with "dependencies are not installed" ([#75](https://github.com/stuffbucket/maximal-core/issues/75)) ([b0c4dc2](https://github.com/stuffbucket/maximal-core/commit/b0c4dc29331cf7869c2e07a90591e2bb05880338))
* six boundary bugs — a lean quota payload locks an entitled account out of switching, and five more ([#73](https://github.com/stuffbucket/maximal-core/issues/73)) ([cc29cdd](https://github.com/stuffbucket/maximal-core/commit/cc29cdd96b1d5c5a0a56564dcf8148ed37d19d8e))
* **sqlite:** close the database when initialize throws, unlocking a corrupt store on Windows ([#71](https://github.com/stuffbucket/maximal-core/issues/71)) ([62994e6](https://github.com/stuffbucket/maximal-core/commit/62994e6b7f89843ef61586f9b4b3bac853db3fb1))


### Code Refactoring

* remove the macOS-DMG/Windows-installer shim ([#81](https://github.com/stuffbucket/maximal-core/issues/81)) ([c1bbb8b](https://github.com/stuffbucket/maximal-core/commit/c1bbb8b15422c49a32027d97be8605460336ad69))


### Build System

* **bundle:** import only `version` from package.json in build-info ([#62](https://github.com/stuffbucket/maximal-core/issues/62)) ([b30d692](https://github.com/stuffbucket/maximal-core/commit/b30d69253af1bac537141b4d29d392cea17c15f7))
* **deps:** gate circular dependencies with a down-only ratchet ([#56](https://github.com/stuffbucket/maximal-core/issues/56)) ([7107adf](https://github.com/stuffbucket/maximal-core/commit/7107adf6e0660b5301b1650d4feff2e1e95d29cc))


### Continuous Integration

* describe what the deps step now enforces ([#57](https://github.com/stuffbucket/maximal-core/issues/57)) ([4ee5a20](https://github.com/stuffbucket/maximal-core/commit/4ee5a20f5583224bedb4e4df14cb1761bb3edb4c))
* **release:** trip on a tag pushed below one that already exists ([#64](https://github.com/stuffbucket/maximal-core/issues/64)) ([f67fcdf](https://github.com/stuffbucket/maximal-core/commit/f67fcdff2c6f8ca7f66353b36e58f9bcefed7823))
* run dupes:check, and fail when a check:deep step runs in no required CI job ([#66](https://github.com/stuffbucket/maximal-core/issues/66)) ([978d760](https://github.com/stuffbucket/maximal-core/commit/978d760a1e3dc68b1d7b0b43ba8b8879e9092ae6))
* run the from-source e2e suite on ubuntu ([#69](https://github.com/stuffbucket/maximal-core/issues/69)) ([991da1e](https://github.com/stuffbucket/maximal-core/commit/991da1e3f0f406be3b80c18aec77de67940cf253))
* verify main's branch rulesets and document what they enforce ([#59](https://github.com/stuffbucket/maximal-core/issues/59)) ([6b05181](https://github.com/stuffbucket/maximal-core/commit/6b05181ef551e20096a34b06ab3e36a3cfbb6d3c))


### Documentation

* adjudicate post-split documentation debt ([#76](https://github.com/stuffbucket/maximal-core/issues/76)) ([938f3b3](https://github.com/stuffbucket/maximal-core/commit/938f3b34be7bb1d0c246998a254d78b49c122a72))
* **adr:** resolve the two ADRs crediting tests that never existed ([#70](https://github.com/stuffbucket/maximal-core/issues/70)) ([1b290c5](https://github.com/stuffbucket/maximal-core/commit/1b290c5e0bda52f495e486bb83e37dee544765cf))
* correct 19 checkable claims and close the ADR cross-reference hole ([#67](https://github.com/stuffbucket/maximal-core/issues/67)) ([c835812](https://github.com/stuffbucket/maximal-core/commit/c8358129125a0901e5d9c1997f8542e9b389e4c3))
* re-verify falsifiable claims against the current repo ([#53](https://github.com/stuffbucket/maximal-core/issues/53)) ([e81a664](https://github.com/stuffbucket/maximal-core/commit/e81a6648db90a6ea832dfe692508f1eb889574fc))
* rewrite the auth-transport wire spec against current source ([#54](https://github.com/stuffbucket/maximal-core/issues/54)) ([a7c9e09](https://github.com/stuffbucket/maximal-core/commit/a7c9e0901440c39a86e8bf9bd73f8bf2d93d8d85))


### Tests

* detect copy-paste with a ratcheted jscpd gate, and stop guessing ports ([#61](https://github.com/stuffbucket/maximal-core/issues/61)) ([1c84524](https://github.com/stuffbucket/maximal-core/commit/1c845249ba58f55fc0f34777f33447466367d437))
* fix three tests that could not fail, found by mutation testing ([#77](https://github.com/stuffbucket/maximal-core/issues/77)) ([0abbca5](https://github.com/stuffbucket/maximal-core/commit/0abbca5a91a73878130eba0d6bef2f7aca1eadf8))
* **security:** assert the ADR-0021 §6.6 CLI invariant against the real server ([#72](https://github.com/stuffbucket/maximal-core/issues/72)) ([73613e5](https://github.com/stuffbucket/maximal-core/commit/73613e599f39605aef122bc5cde6ff00b5bc149a))
* **security:** make the Origin-guard route enumeration real ([#58](https://github.com/stuffbucket/maximal-core/issues/58)) ([6395552](https://github.com/stuffbucket/maximal-core/commit/6395552764f21a81ddf02fff7f1d85270dbcc740))
* **security:** pin the MAXIMAL_SHELL_KEY auth bypass, found by mutation testing ([#79](https://github.com/stuffbucket/maximal-core/issues/79)) ([1865926](https://github.com/stuffbucket/maximal-core/commit/1865926385b519d3d833cacb934b8bd79decb79a))
* **windows:** make the unit suite pass on Windows and run it in CI ([#55](https://github.com/stuffbucket/maximal-core/issues/55)) ([3ad020a](https://github.com/stuffbucket/maximal-core/commit/3ad020a56a54d3dea789a8e791757cb1184a9d29))


### Miscellaneous Chores

* **repo:** drop pr-artifacts screenshots carried over from the split ([#65](https://github.com/stuffbucket/maximal-core/issues/65)) ([9670b14](https://github.com/stuffbucket/maximal-core/commit/9670b149386a1be1953cb7fd91be67b0279a7ff3))

## [0.4.3](https://github.com/stuffbucket/maximal-core/compare/v0.4.2...v0.4.3) (2026-08-06)


### Bug Fixes

* **ci:** make the prepare script run on Windows ([#46](https://github.com/stuffbucket/maximal-core/issues/46)) ([d4870dc](https://github.com/stuffbucket/maximal-core/commit/d4870dc8fc8164c178ed77bd4555fe288a190e5c))
* **ops:** stop fixture-driven tests emitting real CI annotations ([#50](https://github.com/stuffbucket/maximal-core/issues/50)) ([83c990a](https://github.com/stuffbucket/maximal-core/commit/83c990a7bff8ad88c38a10cecd627a78ca879598))


### Continuous Integration

* run the Windows release leg on every PR ([#49](https://github.com/stuffbucket/maximal-core/issues/49)) ([44d9093](https://github.com/stuffbucket/maximal-core/commit/44d9093960e695e3fb9ce33caf48f6f6edf46392))


### Tests

* **e2e:** cover --replace takeover, refusal, and the credential-free shutdown POST ([#47](https://github.com/stuffbucket/maximal-core/issues/47)) ([1c5b626](https://github.com/stuffbucket/maximal-core/commit/1c5b626dfa1d8da46bd853b338d8e676d0b493b4))

## [0.4.2](https://github.com/stuffbucket/maximal-core/compare/v0.4.1...v0.4.2) (2026-08-06)


### Bug Fixes

* **lint:** widen tokenAttachmentGuard to the shapes credentials actually use ([#38](https://github.com/stuffbucket/maximal-core/issues/38)) ([8ee9460](https://github.com/stuffbucket/maximal-core/commit/8ee94602b02cecb1adbea52df611b78cfa127788))
* **release:** generate and insert the CHANGELOG entry inside the release commit ([#44](https://github.com/stuffbucket/maximal-core/issues/44)) ([6700aa5](https://github.com/stuffbucket/maximal-core/commit/6700aa56d0462b070046002df1b78d6f08d93e4c))
* **security:** stop sending the inbound API key on the --replace shutdown POST ([#42](https://github.com/stuffbucket/maximal-core/issues/42)) ([9c510d0](https://github.com/stuffbucket/maximal-core/commit/9c510d08b8021d8550e064afde902434566ca897))
* **stream:** make the SSE frame reads behind the trusted-chunk casts total ([#40](https://github.com/stuffbucket/maximal-core/issues/40)) ([ca14720](https://github.com/stuffbucket/maximal-core/commit/ca1472089fc6d6d0e9bafee3a53f611d706017ac))
* **tests:** restore mock.module from a pre-install snapshot, not the live namespace ([#43](https://github.com/stuffbucket/maximal-core/issues/43)) ([e6488b6](https://github.com/stuffbucket/maximal-core/commit/e6488b6e87de52ca54c336af318a5636b7c32658))


### Continuous Integration

* nightly randomized-order test run ([#39](https://github.com/stuffbucket/maximal-core/issues/39)) ([ee33fea](https://github.com/stuffbucket/maximal-core/commit/ee33feafa06753e602b3f920abf8bbb65d71372f))


### Documentation

* release:manual now takes the tag ([#45](https://github.com/stuffbucket/maximal-core/issues/45)) ([8abfde6](https://github.com/stuffbucket/maximal-core/commit/8abfde6766c5795b71c1f0bd1928371573776431))


### Tests

* record module evaluation order and mock.module installs behind MAXIMAL_TEST_TRACE ([#41](https://github.com/stuffbucket/maximal-core/issues/41)) ([b0a3fbd](https://github.com/stuffbucket/maximal-core/commit/b0a3fbd6fa0365b2cf1c10d5b56c169866241629))

## [0.4.1](https://github.com/stuffbucket/maximal-core/compare/v0.4.0...v0.4.1) (2026-08-05)


### Features

* **release:** rebuild and stage dist/ inside the release commit ([#33](https://github.com/stuffbucket/maximal-core/issues/33)) ([be3b598](https://github.com/stuffbucket/maximal-core/commit/be3b5982b9895b23847a032074709dc5db6d2b92))


### Bug Fixes

* **config:** enforce the guards that only looked enforced ([#37](https://github.com/stuffbucket/maximal-core/issues/37)) ([6777bce](https://github.com/stuffbucket/maximal-core/commit/6777bce866c4b12b391d82e6fb0806eda540b001))


### Continuous Integration

* **release:** enforce the pinned Bun in prepack ([#32](https://github.com/stuffbucket/maximal-core/issues/32)) ([0d6ae48](https://github.com/stuffbucket/maximal-core/commit/0d6ae482a331c147b44688c991d7325f83d67e9e))


### Documentation

* describe what release:manual actually does now ([#35](https://github.com/stuffbucket/maximal-core/issues/35)) ([4bfafff](https://github.com/stuffbucket/maximal-core/commit/4bfafffaebe190dd0f059bcbd8039ffad5ad4148))
* stop recommending the mock restore that cannot work ([#36](https://github.com/stuffbucket/maximal-core/issues/36)) ([3329819](https://github.com/stuffbucket/maximal-core/commit/3329819906796de97a531e1a0f47540497a2479e))


### Tests

* fix order-dependent flakes and correct the mock.module leak guard ([#34](https://github.com/stuffbucket/maximal-core/issues/34)) ([8e7a7a4](https://github.com/stuffbucket/maximal-core/commit/8e7a7a4f83d2d7c7de6b489a6ed32cf7bcf8ba3f))

## [0.4.0](https://github.com/stuffbucket/maximal-core/compare/v0.3.2...v0.4.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* resolve the Anthropic key env-first and fully revert the Claude Desktop profile ([#27](https://github.com/stuffbucket/maximal-core/issues/27)) ([b1554a2](https://github.com/stuffbucket/maximal-core/commit/b1554a25bec07c19808817728d901cf6f923e38b))


### Bug Fixes

* resolve the Anthropic key env-first and fully revert the Claude Desktop profile ([#27](https://github.com/stuffbucket/maximal-core/issues/27)) ([b1554a2](https://github.com/stuffbucket/maximal-core/commit/b1554a25bec07c19808817728d901cf6f923e38b))

## [0.3.2](https://github.com/stuffbucket/maximal-core/compare/v0.3.1...v0.3.2) (2026-08-05)


### Features

* **ops:** fail CI when the committed dist/lib bindings go stale ([#24](https://github.com/stuffbucket/maximal-core/issues/24)) ([9eda959](https://github.com/stuffbucket/maximal-core/commit/9eda95996ba3c08b1e13ee28ff632c7444ec41a4))


### Continuous Integration

* **release:** build, verify, and publish binaries on a tag ([#28](https://github.com/stuffbucket/maximal-core/issues/28)) ([74b9822](https://github.com/stuffbucket/maximal-core/commit/74b9822dd3fdc2158b2e00ce4df50573e25fd7d1))


### Documentation

* correct claims that no longer match the repo ([#25](https://github.com/stuffbucket/maximal-core/issues/25)) ([0af6070](https://github.com/stuffbucket/maximal-core/commit/0af607092be4a188a9172339f8a0e87b0dc0f69d))


### Tests

* **docs:** add the docs-reference parity test the strategy doc promised ([#26](https://github.com/stuffbucket/maximal-core/issues/26)) ([10620e5](https://github.com/stuffbucket/maximal-core/commit/10620e56e142339147cf0b31c70d24e79f292bfa))


### Miscellaneous Chores

* **release:** delete the inert release-please config and manifest ([#23](https://github.com/stuffbucket/maximal-core/issues/23)) ([2a0baf2](https://github.com/stuffbucket/maximal-core/commit/2a0baf2b109befa4e69daf919a2c1fdc7ffe518e))

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
