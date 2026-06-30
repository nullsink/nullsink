# Contributing to nullsink

Thanks for your interest. nullsink is a privacy-focused, money-handling system, so contributions are held to a
high bar for correctness — especially anything touching the billing/ledger path or the privacy guarantees.

## Ground rules

- **Money and privacy are load-bearing.** Changes to metering, holds/refunds, the ledger, the payment rails,
  header scrubbing, or logging get extra scrutiny. If a change could affect billing correctness or what the
  service can see/retain, say so explicitly in the PR and add a test.
- **Discuss large changes first.** Open an issue before a big refactor or a new feature so we can agree on the
  shape before you spend the effort.
- **Security issues do not go in public issues/PRs.** Report them privately — see [SECURITY.md](SECURITY.md).

## Development setup

Requires [Bun](https://bun.sh) 1.3.14 (pinned — it matches the box runtime and CI).

```sh
bun install        # one hoisted node_modules + one root bun.lock for both packages
bun run dev        # run core (watch) and the client (vite) together
bun run typecheck  # tsc across both packages
bun run test       # bun test across both packages
bun run build      # core single-binary + client static bundle
```

Target one package with `bun --filter`, e.g. `bun --filter './core' test` or `bun --filter './client' dev`.

Install the pre-push hook so the same checks CI runs happen locally before a push:

```sh
git config core.hooksPath .githooks
```

A PR must pass typecheck + tests for both packages (CI enforces it).

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please) — you don't
write the changelog or bump versions by hand.

- Land work via **squash merge** with a Conventional Commit PR title (`feat(scope): …`, `fix: …`). The
  squashed subject is the only thing release-please reads, so the title is what matters.
- release-please keeps an open "release PR" that bumps the version and regenerates `CHANGELOG.md` from the
  commits since the last release. Merge it when you want to cut a release.
- Merging the release PR tags `vX.Y.Z` and creates the GitHub Release; CI then builds and attaches the
  linux-x64 server + `nsk` binaries, the deploy tree, and the client UI tarball (with `SHA256SUMS`).

Pre-1.0, `feat` and breaking changes bump the minor (`0.x`), `fix` bumps the patch.

## Licensing of contributions

The whole repo is licensed **AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). By opening a pull request you
agree your contribution is licensed under that license (inbound=outbound) — no CLA, no copyright assignment,
and no commit sign-off required.

## Style

Match the surrounding code — naming, comment density, and idiom. The codebase favors small, well-commented,
zero-/low-dependency modules; comments explain *why* (the invariant or the footgun), not *what*. Keep that.
