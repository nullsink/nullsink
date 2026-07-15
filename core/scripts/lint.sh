#!/usr/bin/env bash
# Lint the deploy + ops artifacts: shellcheck every deploy/*.sh, core/scripts/*.sh, and .github/scripts/*.sh;
# then check that the Caddyfile parses, is caddy-fmt clean, and satisfies its live error contract. Run locally
# before pushing — CI runs this exact script with pinned linters. The deploy scripts/units ARE how the box
# runs, so they get gated like app code. Needs `shellcheck`, `caddy`, and `bun` on PATH.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1   # repo root, so it works from any cwd

# --- shell scripts ---
shopt -s nullglob
scripts=(deploy/*.sh scripts/*.sh ../.github/scripts/*.sh)
if [ "${#scripts[@]}" -eq 0 ]; then
  echo "lint: no deploy/*.sh, scripts/*.sh, or .github/scripts/*.sh matched — nothing to check (did the paths move?)" >&2
  exit 1
fi
echo ">>> shellcheck (${#scripts[@]}): ${scripts[*]}"
shellcheck "${scripts[@]}"

# --- Caddyfile: parses + canonical formatting ---
echo ">>> caddy validate"
# The Caddyfile is a {$NULLSINK_DOMAIN} template (the real value reaches Caddy from /etc/nullsink.env via a
# systemd drop-in on the box); supply a dummy here so validation has a non-empty site address to parse.
NULLSINK_DOMAIN=lint.example caddy validate --adapter caddyfile --config deploy/Caddyfile
echo ">>> caddy fmt (formatting check)"
# Compare the file immediately before/after formatting, rather than comparing it with Git's index: a developer
# must be able to lint an intentional, still-uncommitted Caddy change. Locally this auto-fixes and tells you;
# in CI it simply fails the gate.
before_fmt="$(mktemp)"
trap 'rm -f "$before_fmt"' EXIT
cp deploy/Caddyfile "$before_fmt"
caddy fmt --overwrite deploy/Caddyfile
if ! cmp -s "$before_fmt" deploy/Caddyfile; then
  echo "lint: Caddyfile was not caddy-fmt clean — fixed it in your tree above; review and commit." >&2
  exit 1
fi
rm -f "$before_fmt"
trap - EXIT

echo ">>> caddy edge contract (live proxy + body limits)"
bun run test:caddy

echo ">>> deploy lint OK"
