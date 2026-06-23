#!/usr/bin/env bash
# Regenerate bitcoind's rpcauth AND the proxy's BITCOIN_RPC_PASSWORD as ONE matched pair, restart both
# services, and verify the app's RPC auth. This is the cure for a 401 on the BTC rail (which surfaces to
# buyers as `wallet_unavailable` on /buy with rail=bitcoin).
#
# WHY a dedicated tool: bitcoind's rpcauth hash is HMAC-SHA256 keyed by the salt's HEX-STRING bytes
# (salt.encode()), EXACTLY as Bitcoin Core's share/rpcauth/rpcauth.py does it — NOT bytes.fromhex(salt).
# Get that wrong and the conf hash + env password are self-consistent but bitcoind rejects them every
# time (a silent 401). And `bitcoin-cli` keeps working via the datadir cookie, which masks the broken
# rpcauth — so always test the APP path, not just bitcoin-cli. Generating both halves here, from one
# password, guarantees they match.
#
#   sudo deploy/regen-bitcoin-rpcauth.sh
#
# Env overrides (all optional): BITCOIN_CONF, ENV_FILE, BTC_RPC_USER.
set -euo pipefail

CONF="${BITCOIN_CONF:-/var/lib/bitcoind/bitcoin.conf}"
ENVF="${ENV_FILE:-/etc/nullsink.env}"
USER_NAME="${BTC_RPC_USER:-nullsink}"

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }
[ -w "$CONF" ] || { echo "cannot write $CONF (run with sudo?)" >&2; exit 1; }
[ -w "$ENVF" ] || { echo "cannot write $ENVF (run with sudo?)" >&2; exit 1; }

# 1) generate the matched pair and write both files (other lines untouched; ownership preserved)
python3 - "$CONF" "$ENVF" "$USER_NAME" <<'PY'
import os, sys, base64, hmac, hashlib, pathlib
conf_path, env_path, user = sys.argv[1], sys.argv[2], sys.argv[3]
salt = os.urandom(16).hex()
pw = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
# KEY = the salt's hex STRING bytes (salt.encode()), matching Bitcoin Core rpcauth.py. NOT bytes.fromhex(salt).
h = hmac.new(salt.encode(), pw.encode(), hashlib.sha256).hexdigest()
rpcauth = f"rpcauth={user}:{salt}${h}"
conf = pathlib.Path(conf_path)
conf.write_text("\n".join([l for l in conf.read_text().splitlines() if not l.startswith(f"rpcauth={user}:")] + [rpcauth]) + "\n")
env = pathlib.Path(env_path)
env.write_text("\n".join([l for l in env.read_text().splitlines() if not l.startswith("BITCOIN_RPC_PASSWORD=")] + [f"BITCOIN_RPC_PASSWORD={pw}"]) + "\n")
print("wrote matched rpcauth -> %s  and  BITCOIN_RPC_PASSWORD -> %s" % (conf_path, env_path))
PY

# 2) restart both so they load the new pair (bitcoind: new rpcauth; proxy: new env password)
echo "restarting bitcoind + nullsink…"
systemctl restart bitcoind
sleep 4
systemctl restart nullsink
sleep 2

# 3) verify the APP path (reads the env back, does the same Basic-auth getnewaddress; prints status only)
python3 - "$ENVF" <<'PY'
import sys, re, json, base64, pathlib, urllib.request, urllib.error
e = dict(re.findall(r"^(BITCOIN_RPC_\w+)=(.*)$", pathlib.Path(sys.argv[1]).read_text(), re.M))
url, user, pw = e.get("BITCOIN_RPC_URL", ""), e.get("BITCOIN_RPC_USER", ""), e.get("BITCOIN_RPC_PASSWORD", "")
if not url:
    print("VERIFY SKIPPED - BITCOIN_RPC_URL not set in env (Phase B not wired yet)"); sys.exit(0)
a = base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()
req = urllib.request.Request(url, data=b'{"jsonrpc":"1.0","id":"v","method":"getnewaddress","params":[]}',
    headers={"authorization": "Basic " + a, "content-type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print("VERIFY PASS - rpcauth OK -> getnewaddress", json.loads(r.read()).get("result"))
except urllib.error.HTTPError as ex:
    print("VERIFY FAIL - HTTP", ex.code, "(still mismatched?)"); sys.exit(1)
except Exception as ex:
    print("VERIFY FAIL -", ex); sys.exit(1)
PY
