# Changelog

## [1.10.1](https://github.com/nullsink/nullsink/compare/v1.10.0...v1.10.1) (2026-07-23)


### Bug Fixes

* **deploy:** wait for credit socket readiness ([#129](https://github.com/nullsink/nullsink/issues/129)) ([5e4dd98](https://github.com/nullsink/nullsink/commit/5e4dd9891fcaf715559fd21d9a8c4e96da57c3f4))

## [1.10.0](https://github.com/nullsink/nullsink/compare/v1.9.1...v1.10.0) (2026-07-22)


### Features

* **deploy:** define backup and financial egress ([#127](https://github.com/nullsink/nullsink/issues/127)) ([5444997](https://github.com/nullsink/nullsink/commit/54449971e975774c496aec3b583bb8b286dcad1e))


### Bug Fixes

* **privacy:** scrub delivered credit linkage ([#124](https://github.com/nullsink/nullsink/issues/124)) ([0e5eb0f](https://github.com/nullsink/nullsink/commit/0e5eb0f21d7b27c1de040094b5c10f3be57f3753))

## [1.9.1](https://github.com/nullsink/nullsink/compare/v1.9.0...v1.9.1) (2026-07-17)


### Maintenance

* **deploy:** pin tinfoil-proxy v0.1.7 ([#121](https://github.com/nullsink/nullsink/issues/121)) ([1efd787](https://github.com/nullsink/nullsink/commit/1efd7870c0a6beb315cb0ca11d201b0000585c08))

## [1.9.0](https://github.com/nullsink/nullsink/compare/v1.8.2...v1.9.0) (2026-07-16)


### Features

* **deploy:** add guarded component upgrades ([#120](https://github.com/nullsink/nullsink/issues/120)) ([2c99826](https://github.com/nullsink/nullsink/commit/2c998262f2165ba948588ee9e691c862257c5c01))


### Bug Fixes

* **client:** collapse same-turn quote submits ([#113](https://github.com/nullsink/nullsink/issues/113)) ([857e161](https://github.com/nullsink/nullsink/commit/857e16189bfd2452a2bd90783e09530a6d60b1be))
* **client:** distinguish payment check failures ([#102](https://github.com/nullsink/nullsink/issues/102)) ([a870ff0](https://github.com/nullsink/nullsink/commit/a870ff0146f8982fe2502b2077483ec88373de5c))
* **client:** keep expired orders trackable ([#114](https://github.com/nullsink/nullsink/issues/114)) ([e991d69](https://github.com/nullsink/nullsink/commit/e991d69f728f17044ec281747336efc9e10a4a48))
* **client:** require authoritative payment verification ([#116](https://github.com/nullsink/nullsink/issues/116)) ([b55e1a7](https://github.com/nullsink/nullsink/commit/b55e1a7d4bebfc8bc1f525b93e60c1105b0611cb))
* **client:** state the single-use constraint on the pay screen ([#98](https://github.com/nullsink/nullsink/issues/98)) ([0a7aa14](https://github.com/nullsink/nullsink/commit/0a7aa148566df584163fece2e46d39364418f418))
* **deploy:** do not cache balance responses ([#105](https://github.com/nullsink/nullsink/issues/105)) ([1c59356](https://github.com/nullsink/nullsink/commit/1c59356b4138510cc99ed0cf0c6282328c962e95))
* **deploy:** preserve API errors during edge outages ([#104](https://github.com/nullsink/nullsink/issues/104)) ([922f63b](https://github.com/nullsink/nullsink/commit/922f63b5f50974095a36de854627c7398d932fa4))
* **deploy:** preserve edge error contracts ([#107](https://github.com/nullsink/nullsink/issues/107)) ([36712b1](https://github.com/nullsink/nullsink/commit/36712b12aff57f51197900adbf74a23d8823ddde))
* **deploy:** relocate Monero shared ringdb ([#119](https://github.com/nullsink/nullsink/issues/119)) ([9f8b5c1](https://github.com/nullsink/nullsink/commit/9f8b5c1ac37eb26e1522b601ef67d0eb9ce15b65))
* **errors:** clarify read failures ([#97](https://github.com/nullsink/nullsink/issues/97)) ([e361301](https://github.com/nullsink/nullsink/commit/e3613016b1fd72312ce5b710bfe8833683116945))
* **metrics:** expose aggregate payment delivery health ([#117](https://github.com/nullsink/nullsink/issues/117)) ([c1beb7f](https://github.com/nullsink/nullsink/commit/c1beb7f81230c63065fadd424c09f98adf6fd451))
* **release:** distinguish prereleases and maintenance changes ([#106](https://github.com/nullsink/nullsink/issues/106)) ([1ce9257](https://github.com/nullsink/nullsink/commit/1ce92576566ef402d27557f7546464b9a02be9e5))


### Maintenance

* **deploy:** bump pinned dependencies ([#103](https://github.com/nullsink/nullsink/issues/103)) ([0306f12](https://github.com/nullsink/nullsink/commit/0306f1237c2e198fc0f9be0ccfdae5777f375064))
* sanity-sweep cleanup — dead code, lying comments, stale references ([#99](https://github.com/nullsink/nullsink/issues/99)) ([b73c8a2](https://github.com/nullsink/nullsink/commit/b73c8a22fb381c3aa52d3ea6cdc585861159c660))

## [1.8.2](https://github.com/nullsink/nullsink/compare/v1.8.1...v1.8.2) (2026-07-11)


### Bug Fixes

* **deploy:** status-check fails loud when PAY_RAILS is unset; deploy.sh survives a box without nsk ([311e428](https://github.com/nullsink/nullsink/commit/311e428811c85f2ae967b26675192d6f748c436c))
* **order-status:** scope a status lookup to the order the client is tracking ([#78](https://github.com/nullsink/nullsink/issues/78)) ([ed17254](https://github.com/nullsink/nullsink/commit/ed172547a253881b2e0e41e3fd53a6093ab4aa5b))
* **payments:** say the proxy is unreachable instead of relaying Bun's typo hint ([311e428](https://github.com/nullsink/nullsink/commit/311e428811c85f2ae967b26675192d6f748c436c))

## [1.8.1](https://github.com/nullsink/nullsink/compare/v1.8.0...v1.8.1) (2026-07-10)


### Bug Fixes

* **client:** order fable first among Anthropic models, tier gpt-5.6 sol/terra/luna ([#89](https://github.com/nullsink/nullsink/issues/89)) ([6e8209f](https://github.com/nullsink/nullsink/commit/6e8209f1cfad445d011ec6de5a0465d10f9ad19f))
* **pricing:** bill gpt-5.6 cache writes; complete, table-driven rate card ([#87](https://github.com/nullsink/nullsink/issues/87)) ([59bd921](https://github.com/nullsink/nullsink/commit/59bd921aa8935c8603012bd43206d07e62832003))
* **pricing:** sync prices from models.dev ([#83](https://github.com/nullsink/nullsink/issues/83)) ([3041c6d](https://github.com/nullsink/nullsink/commit/3041c6d5c31bf6396cc500a3f97881dff3c42107))


### Documentation

* **deploy:** document the split cutover bootstrap + the rollback enable trap ([#85](https://github.com/nullsink/nullsink/issues/85)) ([24c568a](https://github.com/nullsink/nullsink/commit/24c568ac85f5193ba4e22b6548f05e2d84b0d706))

## [1.8.0](https://github.com/nullsink/nullsink/compare/v1.7.1...v1.8.0) (2026-07-10)


### Features

* **app:** split into proxy + payments processes over a credit socket ([#73](https://github.com/nullsink/nullsink/issues/73)) ([545c9b7](https://github.com/nullsink/nullsink/commit/545c9b7fbbf84ec934a417dea72374b23d0f2ffc))

## [1.7.1](https://github.com/nullsink/nullsink/compare/v1.7.0...v1.7.1) (2026-07-10)


### Documentation

* Open WebUI guide with a bundled Claude pipe function ([#80](https://github.com/nullsink/nullsink/issues/80)) ([d6b41eb](https://github.com/nullsink/nullsink/commit/d6b41eb0abe88ff1f61d7ba35f601b9f77301bb3))
* remove the LibreChat section from the README ([#82](https://github.com/nullsink/nullsink/issues/82)) ([517d561](https://github.com/nullsink/nullsink/commit/517d561f01e6ea4067c384a74021a3b94fcbb8de))

## [1.7.0](https://github.com/nullsink/nullsink/compare/v1.6.1...v1.7.0) (2026-07-09)


### Features

* **cli:** add `nsk migrate-revenue` so the cutover can run on a box ([#75](https://github.com/nullsink/nullsink/issues/75)) ([77d34bc](https://github.com/nullsink/nullsink/commit/77d34bc8f523130d3a204f5fd5978168359bd88c))


### Bug Fixes

* **deploy:** keep backup/restore from destroying paid-but-undelivered credits ([#76](https://github.com/nullsink/nullsink/issues/76)) ([bfda391](https://github.com/nullsink/nullsink/commit/bfda39100d67c883c9be147a8c14ffadb91a0b44))
* **deploy:** make the install + verify scripts fail loud, not silent ([#79](https://github.com/nullsink/nullsink/issues/79)) ([ed8ce9d](https://github.com/nullsink/nullsink/commit/ed8ce9d36232386a917acf4b6002a02e91713f28))
* **edge:** route GET /v1/models through Caddy (public 404 regression) ([#72](https://github.com/nullsink/nullsink/issues/72)) ([342fdec](https://github.com/nullsink/nullsink/commit/342fdeca264627b2cc0441f7f428d60f920d4002))
* persist payment sightings so a restart cannot reap or hide a paid order ([#74](https://github.com/nullsink/nullsink/issues/74)) ([616b8a8](https://github.com/nullsink/nullsink/commit/616b8a8ae6b5ea9d26b3fb219896287b043436df))


### Refactoring

* **ledger:** inject DB stores at the composition root (drop import-time singletons) ([#67](https://github.com/nullsink/nullsink/issues/67)) ([8d5fe9e](https://github.com/nullsink/nullsink/commit/8d5fe9e3470e0857143b9848f0df80ae6ff88d59))
* **ledger:** route settle through a durable in-process credit outbox ([#71](https://github.com/nullsink/nullsink/issues/71)) ([7aa29ef](https://github.com/nullsink/nullsink/commit/7aa29ef31a9a28986d4f7be629d49543e0cf2040))


### Documentation

* **deploy:** rewrite the cutover runbook from the staging run ([#77](https://github.com/nullsink/nullsink/issues/77)) ([a2b086a](https://github.com/nullsink/nullsink/commit/a2b086a6b2a7dedc94336bc3f5cd0861bf4ee293))

## [1.6.1](https://github.com/nullsink/nullsink/compare/v1.6.0...v1.6.1) (2026-07-05)


### Bug Fixes

* **client:** rename /api coins class off the shared .coins (pay-picker regression) ([#61](https://github.com/nullsink/nullsink/issues/61)) ([8dcc6fa](https://github.com/nullsink/nullsink/commit/8dcc6fa922fb3ef6b03496fbf47ba4e5378fa59b))

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
