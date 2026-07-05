# Changelog

## [1.6.0](https://github.com/nullsink/nullsink/compare/v1.5.0...v1.6.0) (2026-07-05)


### Features

* **client:** rebuild /api as a side-by-side two-format reference ([#57](https://github.com/nullsink/nullsink/issues/57)) ([e60286c](https://github.com/nullsink/nullsink/commit/e60286ce9c3e74c3e6d21f383973d33927585f68))


### Bug Fixes

* **metrics:** flush the final window after the shutdown drain ([#59](https://github.com/nullsink/nullsink/issues/59)) ([a686d71](https://github.com/nullsink/nullsink/commit/a686d71ce3ca986a1832861b58b83608adabbdff))

## [1.5.0](https://github.com/nullsink/nullsink/compare/v1.4.1...v1.5.0) (2026-07-04)


### Features

* GET /v1/models + OpenAI-compatible client setup docs ([#49](https://github.com/nullsink/nullsink/issues/49)) ([65c9776](https://github.com/nullsink/nullsink/commit/65c977622831db02ddeb0f6b00e6eb442612a198))

## [1.4.1](https://github.com/nullsink/nullsink/compare/v1.4.0...v1.4.1) (2026-07-03)


### Bug Fixes

* **deploy:** v1.4.0 release-audit fixups ([#54](https://github.com/nullsink/nullsink/issues/54)) ([9b9bf2a](https://github.com/nullsink/nullsink/commit/9b9bf2a22f77f75ca5bab6048d31013f33433f45))

## [1.4.0](https://github.com/nullsink/nullsink/compare/v1.3.4...v1.4.0) (2026-07-03)


### Features

* **deploy:** app-box cutover for the bitcoind node-box split ([#50](https://github.com/nullsink/nullsink/issues/50)) ([a781c3a](https://github.com/nullsink/nullsink/commit/a781c3ac15ef3c8fa61edcf254d7ac3a78859931))
* **deploy:** fold the pre-cutover audit gate into the runbook + setup.sh ([#53](https://github.com/nullsink/nullsink/issues/53)) ([8fed78a](https://github.com/nullsink/nullsink/commit/8fed78a3c989c0106c0b246f237af9ea9b8ffce1))
* **deploy:** node-box bootstrap for bitcoind isolation (WireGuard) ([#45](https://github.com/nullsink/nullsink/issues/45)) ([fefdf33](https://github.com/nullsink/nullsink/commit/fefdf33e5deed763ea4f17043401ea4ed42a55a2))


### Bug Fixes

* **deploy:** allow signet RPC (38332) over wg0 on the node box ([#51](https://github.com/nullsink/nullsink/issues/51)) ([be67714](https://github.com/nullsink/nullsink/commit/be677149d233ede1ea7034fa5c819c39c220c321))


### Documentation

* **deploy:** node-box DX — [Peer] block print, ufw + [signet] gotchas ([#52](https://github.com/nullsink/nullsink/issues/52)) ([46397aa](https://github.com/nullsink/nullsink/commit/46397aa02e61b86fff5baa7d7f3be1d2ead5ad9b))

## [1.3.4](https://github.com/nullsink/nullsink/compare/v1.3.3...v1.3.4) (2026-07-02)


### Bug Fixes

* **client:** drop the claude-fable-5 "down" flag on the models page ([#46](https://github.com/nullsink/nullsink/issues/46)) ([e3c5d1b](https://github.com/nullsink/nullsink/commit/e3c5d1b90f5d0fa34709860bbf812dd71590ddd1))

## [1.3.3](https://github.com/nullsink/nullsink/compare/v1.3.2...v1.3.3) (2026-07-01)


### Features

* **pricing:** add claude-sonnet-5 (sync from models.dev) ([#41](https://github.com/nullsink/nullsink/issues/41)) ([ff15d3d](https://github.com/nullsink/nullsink/commit/ff15d3dab7869dfd3b41798c9fb1048649effa2c))


### Chores

* pin release to 1.3.3; price syncs cut patch releases ([#44](https://github.com/nullsink/nullsink/issues/44)) ([06cbe41](https://github.com/nullsink/nullsink/commit/06cbe417715a8a58b7e151ebcf8bb80a081d526f))

## [1.3.2](https://github.com/nullsink/nullsink/compare/v1.3.1...v1.3.2) (2026-06-30)


### Bug Fixes

* **client:** bump stale OpenAI quickstart example to gpt-5.5 ([#39](https://github.com/nullsink/nullsink/issues/39)) ([fd1137d](https://github.com/nullsink/nullsink/commit/fd1137dbbc0d606bc8f8043ff7dad46ecb8544f5))
* **deploy:** remove the monero-wallet-rpc watchdog + node failover ([#37](https://github.com/nullsink/nullsink/issues/37)) ([bdf76f9](https://github.com/nullsink/nullsink/commit/bdf76f90ae79bb4e1f331c55634a3d1c5876a841))

## [1.3.1](https://github.com/nullsink/nullsink/compare/v1.3.0...v1.3.1) (2026-06-30)


### Bug Fixes

* **client:** wordmark stagger survives prod CSP (move delays to CSS) ([#35](https://github.com/nullsink/nullsink/issues/35)) ([58259a8](https://github.com/nullsink/nullsink/commit/58259a8b1a24c7ba3c419326d84d1592508cab1f))

## [1.3.0](https://github.com/nullsink/nullsink/compare/v1.2.0...v1.3.0) (2026-06-30)


### Features

* **client:** /start Tinfoil on-ramp + lighter /models diagram wording ([#22](https://github.com/nullsink/nullsink/issues/22)) ([a95f9e7](https://github.com/nullsink/nullsink/commit/a95f9e7d3112e4b9309f87d0411813d9f20ac642))
* **client:** drop /about page; models copy (Frontier tier, identity line) ([#23](https://github.com/nullsink/nullsink/issues/23)) ([09fcba2](https://github.com/nullsink/nullsink/commit/09fcba27f03afd5b559549515fb4bf64bf6921a2))
* **client:** redesign /models — open-weight vs closed trust tiers ([#20](https://github.com/nullsink/nullsink/issues/20)) ([2140969](https://github.com/nullsink/nullsink/commit/2140969d13add2d24c37736d6bc4f65db6a25418))
* **client:** redesign the landing — two-column home, single key field, models tiers ([#24](https://github.com/nullsink/nullsink/issues/24)) ([2b444ff](https://github.com/nullsink/nullsink/commit/2b444ffcde4f5825d62e3e761ce714525a9d67e0))
* **client:** show the deployed version beside the wordmark ([#18](https://github.com/nullsink/nullsink/issues/18)) ([2452244](https://github.com/nullsink/nullsink/commit/24522442afc20c0fdc9e93b026bac8228f66fa22))
* **client:** UI follow-ups — provider links, /api copy + dual error envelopes, active nav, /rails flicker fix ([#27](https://github.com/nullsink/nullsink/issues/27)) ([e12d611](https://github.com/nullsink/nullsink/commit/e12d611661d88217fded4539a927ba76898e2130))
* **client:** UI polish — persistent hint, remove fades, /api + nav tweaks, drop SEO pages ([#28](https://github.com/nullsink/nullsink/issues/28)) ([6b51e0f](https://github.com/nullsink/nullsink/commit/6b51e0f44e40e7ab44fe387a2398509cf9f65c71))
* **client:** wordmark seed → 999 ([#29](https://github.com/nullsink/nullsink/issues/29)) ([2520c8c](https://github.com/nullsink/nullsink/commit/2520c8c4fdc61e329f781997d8ff25f45bdd16b1))
* **deploy:** MONERO_NODE failover — comma-separated node list + launch wrapper ([#33](https://github.com/nullsink/nullsink/issues/33)) ([bba9bd2](https://github.com/nullsink/nullsink/commit/bba9bd2acdd26872a2638f16a43428b800549906))
* **deploy:** watchdog to restart a hung monero-wallet-rpc ([#30](https://github.com/nullsink/nullsink/issues/30)) ([c6c1fcc](https://github.com/nullsink/nullsink/commit/c6c1fccb7ef762bc5d581071d0bde84e43b3d25f))
* **providers:** Tinfoil provider — namespaced routing + enclave attestation ([#13](https://github.com/nullsink/nullsink/issues/13)) ([96b9946](https://github.com/nullsink/nullsink/commit/96b994620af0b5a51d3b830e143fb0352624a2c2))


### Bug Fixes

* **client:** accessibility + i18n audit fixes ([#31](https://github.com/nullsink/nullsink/issues/31)) ([998005f](https://github.com/nullsink/nullsink/commit/998005fd8b2e50152408f467adb8f52340bee229))
* **deploy:** reconcile timers on redeploy + warn on changed rail-daemon units ([#34](https://github.com/nullsink/nullsink/issues/34)) ([f31ea5a](https://github.com/nullsink/nullsink/commit/f31ea5ada4138a4f96bd54dda0aba5effde45005))


### Refactoring

* **deploy:** trim wallet-rpc watchdog + bound the heal ([#32](https://github.com/nullsink/nullsink/issues/32)) ([b453028](https://github.com/nullsink/nullsink/commit/b4530283b73670696c239c26d7715c7a8e208c69))

## [1.2.0](https://github.com/nullsink/nullsink/compare/v1.1.0...v1.2.0) (2026-06-26)


### Features

* **cli:** add `nsk orders` — operator view of in-flight payment orders ([#14](https://github.com/nullsink/nullsink/issues/14)) ([655ef00](https://github.com/nullsink/nullsink/commit/655ef00173b5726e5b4903710d269ab6c2c7cb1f))

## [1.1.0](https://github.com/nullsink/nullsink/compare/v1.0.2...v1.1.0) (2026-06-25)


### Features

* **providers:** make Anthropic optional, require ≥1 provider (S17) ([#11](https://github.com/nullsink/nullsink/issues/11)) ([17d1478](https://github.com/nullsink/nullsink/commit/17d14784ef36aaeac16c3679c38d8a20e49dd6fb))

## [1.0.2](https://github.com/nullsink/nullsink/compare/v1.0.1...v1.0.2) (2026-06-24)


### Bug Fixes

* **client:** point the GitHub links (footer + About) at the repo ([#9](https://github.com/nullsink/nullsink/issues/9)) ([4ca75f3](https://github.com/nullsink/nullsink/commit/4ca75f380220986a063600a00af04583555399b9))
* **cost:** sanitize usage counts so a malformed upstream can't bill NaN/negative ([#6](https://github.com/nullsink/nullsink/issues/6)) ([582c039](https://github.com/nullsink/nullsink/commit/582c039900d31a0b4f0ed104158d15e07f57ae76))

## [1.0.1](https://github.com/nullsink/nullsink/compare/v1.0.0...v1.0.1) (2026-06-23)


### Bug Fixes

* **release:** grant release-please's build job the attestation permissions ([#2](https://github.com/nullsink/nullsink/issues/2)) ([632dbce](https://github.com/nullsink/nullsink/commit/632dbcee3dd33f96be960c9221f630412e175f57))

## [0.12.0](https://github.com/nullsink/nullsink/compare/v0.11.0...v0.12.0) (2026-06-23)


### Features

* **release:** automate changelog + releases with release-please ([#53](https://github.com/nullsink/nullsink/issues/53)) ([8a2f7ac](https://github.com/nullsink/nullsink/commit/8a2f7ac89acc256d65eb8bfa5ec32ebc3231b413))
