#!/usr/bin/env bash
# Rotate the dedicated node's bitcoind rpcauth and print the matching app-box password exactly once. The
# node never receives or edits the app environment; the operator transfers the one generated assignment.
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

CONF="${BITCOIN_CONF:-/var/lib/bitcoind/bitcoin.conf}"
USER_NAME="${BTC_RPC_USER:-nullsink}"

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }
[ -w "$CONF" ] || { echo "cannot write $CONF (run with sudo?)" >&2; exit 1; }
systemctl cat bitcoind.service >/dev/null 2>&1 || {
  echo "refusing: this is not a configured node box" >&2
  exit 2
}
systemctl cat nullsink-proxy.service >/dev/null 2>&1 && {
  echo "refusing: app services are installed on this host" >&2
  exit 2
}

password="$(python3 - "$CONF" "$USER_NAME" <<'PY'
import base64
import hashlib
import hmac
import os
import pathlib
import sys

conf_path, user = sys.argv[1], sys.argv[2]
salt = os.urandom(16).hex()
password = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
digest = hmac.new(salt.encode(), password.encode(), hashlib.sha256).hexdigest()
rpcauth = f"rpcauth={user}:{salt}${digest}"
conf = pathlib.Path(conf_path)
lines = [line for line in conf.read_text().splitlines() if not line.startswith(f"rpcauth={user}:")]
conf.write_text("\n".join(lines + [rpcauth]) + "\n")
print(password)
PY
)"

systemctl restart bitcoind

echo "bitcoind restarted with the rotated rpcauth"
echo "Paste this line into the app box's /etc/nullsink-payments.env, restart nullsink-payments, then run status-check.service:"
printf 'BITCOIN_RPC_PASSWORD=%s\n' "$password"
