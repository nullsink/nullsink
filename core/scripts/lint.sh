#!/usr/bin/env bash
# Lint + test the deploy + ops artifacts: shellcheck every deploy/*.sh (incl. deploy/test) + scripts/*.sh,
# run the deploy/test/*.test.sh shell tests, and check the Caddyfile both parses and is caddy-fmt clean. Run
# this locally before pushing — CI runs this exact script with pinned linters. The deploy scripts/units ARE
# how the box runs, so they get gated like the app code. Needs `shellcheck` and `caddy` on PATH.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1   # repo root, so it works from any cwd

# --- shell scripts ---
shopt -s nullglob
scripts=(deploy/*.sh deploy/test/*.sh scripts/*.sh)
if [ "${#scripts[@]}" -eq 0 ]; then
  echo "lint: no deploy/*.sh or scripts/*.sh matched — nothing to check (did the paths move?)" >&2
  exit 1
fi
echo ">>> shellcheck (${#scripts[@]}): ${scripts[*]}"
shellcheck "${scripts[@]}"

# --- deploy shell tests (e.g. the wallet launch-wrapper argv/selection guard) ---
dtests=(deploy/test/*.test.sh)
if [ "${#dtests[@]}" -gt 0 ]; then
  echo ">>> deploy tests (${#dtests[@]})"
  for t in "${dtests[@]}"; do echo ">>> bash $t"; bash "$t"; done
fi

# --- Caddyfile: parses + canonical formatting ---
echo ">>> caddy validate"
# The Caddyfile is a {$NULLSINK_DOMAIN} template (the real value reaches Caddy from /etc/nullsink.env via a
# systemd drop-in on the box); supply a dummy here so validation has a non-empty site address to parse.
NULLSINK_DOMAIN=lint.example caddy validate --adapter caddyfile --config deploy/Caddyfile
echo ">>> caddy fmt (formatting check)"
# --overwrite + git-diff is the standard fmt-check idiom: locally it auto-fixes and tells
# you; in CI the diff is what fails the gate.
caddy fmt --overwrite deploy/Caddyfile
if ! git diff --exit-code -- deploy/Caddyfile; then
  echo "lint: Caddyfile was not caddy-fmt clean — fixed it in your tree above; review and commit." >&2
  exit 1
fi

echo ">>> deploy lint OK"
