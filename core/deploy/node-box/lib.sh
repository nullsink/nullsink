# shellcheck shell=bash
# Bitcoin Core installation primitives for the standalone node-box bundle. Nothing in this file is shipped
# in the app deploy artifact.

BITCOIN_VERSION="31.1"
BITCOIN_SHA256_X64="b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"

fetch_verified() {  # $1=url $2=sha256 $3=dest
  curl -fsSL "$1" -o "$3" || return 1
  echo "$2  $3" | sha256sum -c - || {
    echo "    !! CHECKSUM MISMATCH for $3 — refusing to install" >&2
    return 1
  }
}

require_x86_64() {
  if [ "$(uname -m)" != x86_64 ]; then
    echo "    !! Bitcoin Core pin is x86_64 only; this box is $(uname -m)" >&2
    return 1
  fi
}

bitcoin_binary_matches_pin() {  # $1=bitcoind path
  local first
  first="$("$1" --version 2>/dev/null | sed -n '1p')" || return 1
  [[ "$first" == *" version v${BITCOIN_VERSION} "* ||
     "$first" == *" version v${BITCOIN_VERSION}.0 "* ]]
}

bitcoin_is_pinned() {
  bitcoin_binary_matches_pin /usr/local/bin/bitcoind
}

stage_verified_bitcoind() {  # $1=dest
  require_x86_64 || return 1
  local dest="$1" tmp
  mkdir -p "$dest" || return 1
  tmp="$(mktemp -d)" || return 1
  fetch_verified \
    "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz" \
    "$BITCOIN_SHA256_X64" "$tmp/bitcoin.tar.gz" || { rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/bitcoin.tar.gz" -C "$tmp" --strip-components=1 || {
    rm -rf "$tmp"
    return 1
  }
  install -m755 "$tmp/bin/bitcoind" "$dest/bitcoind" || { rm -rf "$tmp"; return 1; }
  install -m755 "$tmp/bin/bitcoin-cli" "$dest/bitcoin-cli" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

install_verified_bitcoind() {
  if bitcoin_is_pinned; then return 0; fi
  local tmp
  tmp="$(mktemp -d)" || return 1
  stage_verified_bitcoind "$tmp" || { rm -rf "$tmp"; return 1; }
  install -m755 "$tmp/bitcoind" "$tmp/bitcoin-cli" /usr/local/bin/ || {
    rm -rf "$tmp"
    return 1
  }
  rm -rf "$tmp"
  echo "    $(/usr/local/bin/bitcoind --version | head -1) installed"
}
