#!/usr/bin/env bash
# Refresh the watch-only Bitcoin address-label export as the payments principal. backup.service may read the
# resulting file through nullsink-payments-read, but never receives the RPC credentials used to create it.
set -euo pipefail

LABELS_PATH="${BITCOIN_LABELS_PATH:-/var/lib/nullsink-payments/bitcoin-wallet-labels.json}"
[[ "$LABELS_PATH" != / && "$LABELS_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "bitcoin-label-export: invalid BITCOIN_LABELS_PATH" >&2
  exit 1
}

case ",${PAY_RAILS:-${PAY_RAIL:-monero}}," in
  *,bitcoin,*) ;;
  *) rm -f -- "$LABELS_PATH"; exit 0 ;;
esac

if [ -z "${BITCOIN_RPC_URL:-}" ]; then
  rm -f -- "$LABELS_PATH"
  exit 0
fi

tmp="$LABELS_PATH.partial.$$"
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
auth=()
[ -n "${BITCOIN_RPC_USER:-}" ] && auth=(--user "$BITCOIN_RPC_USER:${BITCOIN_RPC_PASSWORD:-}")
if curl -fsS --max-time 15 "${auth[@]}" -H 'content-type: application/json' \
    --data '{"jsonrpc":"1.0","id":"backup","method":"listreceivedbyaddress","params":[0,true,true]}' \
    "$BITCOIN_RPC_URL" -o "$tmp" 2>/dev/null \
    && grep -Eq '"result"[[:space:]]*:[[:space:]]*\[' "$tmp" \
    && grep -Eq '"error"[[:space:]]*:[[:space:]]*null' "$tmp"; then
  chmod 0640 "$tmp"
  mv -f -- "$tmp" "$LABELS_PATH"
else
  rm -f -- "$LABELS_PATH"
  echo "bitcoin-label-export: WARN node/wallet unavailable or invalid response; money-DB backup continues without labels" >&2
fi
