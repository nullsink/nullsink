#!/usr/bin/env bash
# Compare the pinned external versions (deploy/setup.sh) against upstream's latest release and report any
# that are behind. READ-ONLY, notify-only — never bumps anything. Run locally, or in CI (the check-pins
# workflow opens an issue when this exits non-zero). Uses the public GitHub release API; unauthenticated
# works (rate-limited) — CI passes a token via GH_TOKEN. Exit 0 = all current, 1 = something behind.
# Human status lines go to stderr; stdout carries ONLY the markdown report (the issue body) when behind.
set -euo pipefail
cd "$(dirname "$0")/.."

pin() { grep -oE "$1=\"[^\"]+\"" deploy/setup.sh | head -1 | cut -d'"' -f2; }
btc_pinned="$(pin BITCOIN_VERSION)"
xmr_pinned="$(pin MONERO_VERSION)"

gh_get() {  # GET a URL, adding the auth header only when GH_TOKEN is set (CI); unauth works too (rate-limited)
  if [ -n "${GH_TOKEN:-}" ]; then
    curl -fsSL -H "authorization: Bearer $GH_TOKEN" "$1"
  else
    curl -fsSL "$1"
  fi
}
latest() {  # $1=owner/repo $2=tag prefix to strip — prints the latest release version
  gh_get "https://api.github.com/repos/$1/releases/latest" \
    | grep -oE '"tag_name"[ ]*:[ ]*"[^"]+"' | head -1 | cut -d'"' -f4 | sed "s/^$2//"
}

behind=0
report=""
check() {  # $1=name $2=pinned $3=owner/repo $4=tag-prefix
  local up; up="$(latest "$3" "$4" || true)"
  if [ -z "$up" ]; then
    echo "??     $1: could not read upstream latest (skipped)" >&2
  elif [ "$2" != "$up" ]; then
    echo "BEHIND $1: pinned $2, latest $up" >&2
    report="${report}- **$1** — pinned \`$2\`, latest \`$up\`"$'\n'
    behind=1
  else
    echo "ok     $1: $2" >&2
  fi
}
check "Bitcoin Core" "$btc_pinned" bitcoin/bitcoin v
check "Monero CLI" "$xmr_pinned" monero-project/monero v

if [ "$behind" -eq 1 ]; then
  printf '%s' "$report"          # stdout: the markdown report (used as the issue body)
  exit 1
fi
echo "all pins current" >&2
