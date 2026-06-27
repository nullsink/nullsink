#!/usr/bin/env bash
# Lean rail + app health check — privacy-safe and near-stateless: it reads the billing DBs only for an
# integrity pragma, and otherwise no user data / request content.
#
# Run every 10 min by status-check.timer; a non-zero exit trips status-check.service's OnFailure= and pages
# Telegram (deploy/alert.sh). Checks, in order of "is the service actually working for customers?":
#   1. The ENABLED core units are active (nullsink, caddy, monero-wallet-rpc or bitcoind, tor) + the app serves
#      /healthz. A unit that is NOT enabled is SKIPPED — so an Anthropic-only box with no buy rail, or a
#      pre-public box with caddy not yet started, doesn't page every tick; an enabled-but-down unit alerts.
#   2. Host: disk/inode headroom for the billing DBs, that the SQLite WAL sidecars are still owned by the
#      service user (a root CLI/backup write leaves root-owned sidecars that silently break billing writes),
#      a per-DB integrity pragma (catches silent corruption that breaks billing), and backup freshness.
#   3. Recent app journal: upstream BILLING errors (our prepaid account ran dry -> everyone 503s) and XMR
#      rate-source failures (/buy down). Greps the operator's own journal; emits only a flag, never content.
#   4. The buy rail (whichever watcher is enabled): Monero — view-only wallet vs. the remote node over Tor;
#      Bitcoin — the pruned node is synced (blocks≈headers, not in IBD) and the watch-only wallet is loaded.
#
# On success it optionally pings HEARTBEAT_URL — a dead-man's-switch: an off-box monitor pages when the ping
# STOPS, catching a dead box/network/timer that OnFailure structurally cannot. Outbound-only, no data.
# Exit 0 if healthy, 1 otherwise. Run on the box (needs local wallet-rpc + Tor SOCKS + the node env).
set -u

WALLET_RPC="${MONERO_WALLET_RPC_URL:-http://127.0.0.1:18083/json_rpc}"
TOR_SOCKS="${TOR_SOCKS:-127.0.0.1:9050}"
NODE_ENV_FILE="${NODE_ENV_FILE:-/etc/monero-wallet-rpc.env}"
LAG_BLOCKS="${LAG_BLOCKS:-3}"                  # wallet may trail the tip by a block or two while scanning; alert past this
RPC_TIMEOUT="${RPC_TIMEOUT:-15}"
DB_DIR="${DB_DIR:-/var/lib/nullsink}"    # where balances.db / pending.db (+ WAL sidecars) live
SVC_USER="${SVC_USER:-nullsink}"         # the user the DBs + sidecars must stay owned by
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
APP_HEALTHZ="${APP_HEALTHZ_URL:-http://127.0.0.1:8080/healthz}"
LOG_WINDOW="${LOG_WINDOW:-15 min ago}"         # journal lookback for the error greps (a bit over the 10m tick)
BACKUP_DIR="${BACKUP_DIR:-$DB_DIR/backups}"    # where backup.sh writes artifacts (for the freshness check)
BACKUP_MAX_AGE_H="${BACKUP_MAX_AGE_H:-28}"     # stale if newest backup older than this (daily + RandomizedDelay + a slow run)
STAMP="${STAMP:-/run/status-check.failed}"     # open-incident marker (tmpfs, clears on reboot) for the recovery page
MEM_WARN_PCT="${MEM_WARN_PCT:-75}"             # early OOM warning: page when nullsink's cgroup memory crosses this % of MemoryMax
NRESTARTS_WARN="${NRESTARTS_WARN:-5}"          # page when auto-restarts since last clean start reach this (crash-flap; ~StartLimitBurst)

fail=0
ok()   { echo "OK   $*"; }
warn() { echo "WARN $*"; fail=1; }

# Pull the first JSON number for a key out of an RPC response without a jq dependency.
jnum() { grep -o "\"$2\" *: *[0-9]\+" <<<"$1" | head -1 | grep -o '[0-9]\+'; }

# --- 1. units (skip a unit that isn't enabled — an intentionally-absent component, not a failure) ---
for unit in nullsink caddy monero-wallet-rpc bitcoind tor tinfoil-proxy; do
  systemctl is-enabled --quiet "$unit" 2>/dev/null || { echo "skip unit $unit (not enabled)"; continue; }
  if [ "$(systemctl is-active "$unit" 2>/dev/null)" = active ]; then ok "unit $unit active"
  else warn "unit $unit NOT active"; fi
done

# --- 1b. app actually SERVES (only if it's running): /healthz is unauthenticated + never forwarded, so it
#     reveals nothing; catches a process that is "active" but hung. ---
if systemctl is-active --quiet nullsink 2>/dev/null; then
  if [ "$(curl -sS --max-time "$RPC_TIMEOUT" -o /dev/null -w '%{http_code}' "$APP_HEALTHZ" 2>/dev/null)" = 200 ]; then ok "app /healthz 200"
  else warn "app /healthz NOT 200 (nullsink hung or not serving)"; fi
fi

# --- 1c. app memory headroom + restart flap: an EARLY warning, BEFORE the cgroup OOM killer (MemoryMax in
#     nullsink.service) reaps the unit. §1/§1b only fire once it's already down/hung; this pages while there's
#     still room to react (shed load, raise MemoryMax). Setting MemoryMax implicitly enables MemoryAccounting,
#     so MemoryCurrent is populated; skip cleanly if it isn't (older systemd) or the unit is unbounded. ---
if systemctl is-active --quiet nullsink 2>/dev/null; then
  mem_cur="$(systemctl show nullsink -p MemoryCurrent --value 2>/dev/null)"
  mem_max="$(systemctl show nullsink -p MemoryMax --value 2>/dev/null)"
  if [ -n "$mem_cur" ] && [ "$mem_cur" -gt 0 ] 2>/dev/null && [ -n "$mem_max" ] && [ "$mem_max" -gt 0 ] 2>/dev/null; then
    mem_pct=$(( mem_cur * 100 / mem_max ))
    if [ "$mem_pct" -ge "$MEM_WARN_PCT" ]; then
      warn "nullsink memory ${mem_pct}% of MemoryMax ($((mem_cur/1024/1024))M/$((mem_max/1024/1024))M) — approaching the cgroup OOM cap; shed load or raise MemoryMax before it's killed"
    else ok "nullsink memory ${mem_pct}% of MemoryMax ($((mem_cur/1024/1024))M)"; fi
  else
    echo "skip memory headroom (cgroup MemoryCurrent/Max not exposed or unbounded)"
  fi
  # NRestarts is cumulative since the last clean start / reset-failed, so a climbing count is the auto-restart
  # flap that StartLimitBurst (default 5) soon turns into a hard 'failed' stop — page before it goes dark. An
  # OOM kill shows up here too; cross-check the boot log for 'recovered N stranded hold(s)' (index.ts).
  nrestarts="$(systemctl show nullsink -p NRestarts --value 2>/dev/null)"
  if [ -n "$nrestarts" ] && [ "$nrestarts" -ge "$NRESTARTS_WARN" ] 2>/dev/null; then
    warn "nullsink restarted ${nrestarts}× since last clean start — crash-flap nearing StartLimitBurst, after which systemd stops retrying (hard outage). Check boot logs for an OOM/'stranded hold' cause"
  else ok "nullsink restart count ${nrestarts:-?} since last clean start"; fi
fi

# --- 1d. tinfoil-proxy readiness (only if active): the rung-2 verifier fails CLOSED, exiting before it binds
#     :3301, so a port that ACCEPTS a connection means startup attestation passed. Keyless + privacy-safe — any
#     HTTP status (even a 401/403/404 from the enclave) proves the proxy answered; a refused/hung connect reads
#     as 000. NOTE: this proves STARTUP attestation only; a mid-session enclave cert-rotation failure surfaces as
#     upstream 502s in the app journal (§3), not here. ---
if systemctl is-active --quiet tinfoil-proxy 2>/dev/null; then
  tf_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3301/ 2>/dev/null)"
  if [ -n "$tf_code" ] && [ "$tf_code" != 000 ]; then ok "tinfoil-proxy answering :3301 (attested at startup, HTTP $tf_code)"
  else warn "tinfoil-proxy NOT answering :3301 — attestation failed at startup (fail-closed) or the proxy is hung; Tinfoil requests will fail (other providers unaffected)"; fi
fi

# --- 2. host: disk + WAL-sidecar ownership (a full disk or root-owned sidecars silently break billing) ---
disk_pct="$(df --output=pcent "$DB_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')"
inode_pct="$(df --output=ipcent "$DB_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ -n "$disk_pct" ] && [ "$disk_pct" -ge "$DISK_WARN_PCT" ]; then warn "disk ${disk_pct}% full on $DB_DIR — billing writes at risk"
else ok "disk ${disk_pct:-?}% on $DB_DIR"; fi
[ -n "$inode_pct" ] && [ "$inode_pct" -ge "$DISK_WARN_PCT" ] && warn "inodes ${inode_pct}% used on $DB_DIR"
sidecar_bad=0
for sc in "$DB_DIR"/*.db-wal "$DB_DIR"/*.db-shm; do
  [ -e "$sc" ] || continue
  owner="$(stat -c '%U' "$sc" 2>/dev/null)"
  [ "$owner" = "$SVC_USER" ] || { warn "sidecar $(basename "$sc") owned by '$owner' (expected '$SVC_USER') — a root write broke billing perms; chown back"; sidecar_bad=1; }
done
[ "$sidecar_bad" -eq 0 ] && ok "DB WAL sidecars owned by $SVC_USER (or none present)"

# --- 2b. billing-DB integrity + backup freshness. Run the integrity pragma AS THE SERVICE USER so any
#     sidecar it touches stays service-owned (root would re-create the very breakage section 2 warns about);
#     quick_check reads page structure for corruption, never identity/row content. ---
if command -v sqlite3 >/dev/null; then
  for db in balances pending; do
    f="$DB_DIR/$db.db"; [ -e "$f" ] || continue
    # busy_timeout: the CLI's own connection has none, so a concurrent settler write lock would otherwise
    # return SQLITE_BUSY and read as a false integrity failure.
    res="$(sudo -u "$SVC_USER" sqlite3 -cmd '.timeout 10000' "$f" 'PRAGMA quick_check;' 2>/dev/null | head -1)"
    if [ "$res" = ok ]; then ok "$db.db integrity ok"
    else warn "$db.db integrity check FAILED ('${res:-no result}') — DB may be corrupt; restore from backup"; fi
  done
else
  echo "skip DB integrity (sqlite3 not installed — apt-get install sqlite3)"
fi
# Backup freshness: a stopped backup.timer is a silent data-loss risk. Skip if backups aren't set up here.
if [ -d "$BACKUP_DIR" ]; then
  # shellcheck disable=SC2012  # names are our own controlled backup-*.tar(.age); ls -t sorts by mtime (newest first), which find can't do as tersely
  newest="$(ls -1t "$BACKUP_DIR"/backup-*.tar "$BACKUP_DIR"/backup-*.tar.age 2>/dev/null | head -1)"
  if [ -z "$newest" ]; then warn "no backups in $BACKUP_DIR — is backup.timer running? (seed one: systemctl start backup.service)"
  else
    ts="$(stat -c %Y "$newest" 2>/dev/null)"
    if [ -z "$ts" ]; then warn "could not stat newest backup ($newest)"
    else
      age_h=$(( ( $(date +%s) - ts ) / 3600 ))
      if [ "$age_h" -le "$BACKUP_MAX_AGE_H" ]; then ok "newest backup ${age_h}h old"
      else warn "newest backup ${age_h}h old (> ${BACKUP_MAX_AGE_H}h) — backups stale or stopped"; fi
    fi
  fi
else
  echo "skip backup freshness ($BACKUP_DIR absent — backups not configured here)"
fi

# --- 3. recent app journal: our-account-dry + rate-source down (symptom greps; emit only a flag) ---
if systemctl is-active --quiet nullsink 2>/dev/null; then
  jlog="$(journalctl -u nullsink --since "$LOG_WINDOW" --no-pager 2>/dev/null)"
  if grep -qiE 'credit balance is too low|insufficient_quota|purchase credits' <<<"$jlog"; then
    warn "upstream BILLING error in the last ${LOG_WINDOW% ago} — prepaid account may be empty; TOP UP"
  else ok "no upstream billing errors (${LOG_WINDOW% ago})"; fi
  # A money-safety anomaly the app logs at ERROR (src/handler.ts billActual / reconcile): a 2xx or stream we
  # SERVED but couldn't meter ("refunded in full" — real usage delivered, billed nothing), or an actual cost
  # that priced above the up-front hold ("exceeded hold" — refund clamped to 0, no overdraft). src/log.ts marks
  # the refunded-in-full line "alert on that line specifically"; this IS that page. Keep these grep tokens in
  # sync with those [bill] log lines (metrics.ts also trends them as bill:refunded / bill:holdexceeded).
  if grep -qiE 'refunded in full|exceeded hold' <<<"$jlog"; then
    warn "BILLING anomaly in the last ${LOG_WINDOW% ago} — a request was served-but-unbilled or priced above its hold; see the '[bill]' journal lines and reconcile"
  else ok "no billing anomalies (${LOG_WINDOW% ago})"; fi
  if grep -qiE 'rate unavailable' <<<"$jlog"; then
    warn "rate source unavailable in the last ${LOG_WINDOW% ago} — /buy is failing (rate sources / Tor)"
  else ok "rate source ok (${LOG_WINDOW% ago})"; fi
  # A rail's settlement poller has failed POLL_FAIL_ALERT consecutive ticks (the app emits this ERROR marker —
  # src/index.ts pollRail). This is the AUTHORITATIVE deposit-detection signal: §4/§4b below probe the node
  # over a FRESH connection, so they can't see an app-side fault (e.g. a stale keep-alive socket the long-lived
  # poller reused). Keep the "POLL BLIND" grep token in sync with that log line.
  if grep -qiE 'POLL BLIND' <<<"$jlog"; then
    warn "POLL BLIND in the last ${LOG_WINDOW% ago} — a rail's deposit detection is DOWN (the APP can't reach its node/wallet); a confirmed deposit will NOT credit until it recovers. See the 'POLL BLIND' journal lines."
  else ok "poller healthy (no POLL BLIND, ${LOG_WINDOW% ago})"; fi
fi

# --- 4. buy rail (only when enabled) ---
if systemctl is-enabled --quiet monero-wallet-rpc 2>/dev/null; then
  wallet_resp="$(curl -sS --max-time "$RPC_TIMEOUT" "$WALLET_RPC" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":"0","method":"get_height"}' 2>/dev/null)"
  wallet_h="$(jnum "$wallet_resp" height)"
  if [ -n "$wallet_h" ]; then ok "wallet height $wallet_h"
  else warn "wallet-rpc unreachable or no height (get_height failed)"; fi

  # remote node over Tor: get_info (stateless stall + fault isolation)
  # shellcheck disable=SC1090
  [ -r "$NODE_ENV_FILE" ] && . "$NODE_ENV_FILE"
  if [ -z "${MONERO_NODE:-}" ]; then
    warn "MONERO_NODE not set (cannot reach node to compare height) — check $NODE_ENV_FILE"
  else
    # Tor circuits flake (~1 in 5 ticks in practice), so a single attempt false-pages. Retry up to 3× with
    # distinct SOCKS credentials — Tor's IsolateSOCKSAuth (on by default) gives each attempt a fresh
    # circuit — so only a genuinely down node/Tor warns. Stays stateless: all retries within this run.
    node_resp="" node_h=""
    for attempt in 1 2 3; do
      node_resp="$(curl -sS --max-time "$RPC_TIMEOUT" --socks5-hostname "$TOR_SOCKS" \
        --proxy-user "hc:circuit$attempt" \
        "http://$MONERO_NODE/json_rpc" -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}' 2>/dev/null)"
      node_h="$(jnum "$node_resp" height)"
      [ -n "$node_h" ] && break
      sleep 5
    done
    if [ -z "$node_h" ]; then
      warn "node unreachable over Tor (get_info failed) — node or Tor is down"
    else
      if grep -q '"synchronized" *: *true' <<<"$node_resp"; then
        ok "node height $node_h synchronized"
      else
        warn "node height $node_h NOT synchronized (still catching up)"
      fi
      if [ -n "${wallet_h:-}" ]; then
        if [ "$wallet_h" -ge "$((node_h - LAG_BLOCKS))" ]; then ok "wallet in sync with node (lag $((node_h - wallet_h)))"
        else warn "wallet STALLED: $((node_h - wallet_h)) blocks behind node — deposits won't credit"; fi
      fi
    fi
  fi
else
  echo "skip buy rail (monero-wallet-rpc not enabled)"
fi

# --- 4b. Bitcoin buy rail (only when enabled): pruned node synced + the watch-only wallet loaded. Uses
#     bitcoin-cli (reads the datadir's cookie/conf for auth) as the service user. ---
if systemctl is-enabled --quiet bitcoind 2>/dev/null; then
  BTC_DATADIR="${BTC_DATADIR:-/var/lib/bitcoind}"
  BTC_WALLET="${BTC_WALLET:-nullsink}"
  bcli() { sudo -u "$SVC_USER" bitcoin-cli -datadir="$BTC_DATADIR" "$@" 2>/dev/null; }
  if ! command -v bitcoin-cli >/dev/null; then
    warn "bitcoin-cli not installed — cannot probe the BTC rail"
  else
    chaininfo="$(bcli getblockchaininfo)"
    blocks="$(jnum "$chaininfo" blocks)"; headers="$(jnum "$chaininfo" headers)"
    if [ -z "$blocks" ]; then
      warn "bitcoind unreachable (getblockchaininfo failed) — node down or RPC creds wrong"
    else
      ok "bitcoind block height $blocks"
      if grep -q '"initialblockdownload" *: *true' <<<"$chaininfo"; then
        warn "bitcoind still in initial block download — deposits won't credit until it's synced"
      elif [ -n "$headers" ] && [ "$blocks" -ge "$((headers - LAG_BLOCKS))" ]; then
        ok "bitcoind in sync (lag $((headers - blocks)))"
      else
        warn "bitcoind STALLED: $((headers - blocks)) blocks behind headers — deposits won't credit"
      fi
      # The watch-only wallet MUST be loaded for the rail to see deposits (createAddress / listunspent).
      if bcli -rpcwallet="$BTC_WALLET" getwalletinfo | grep -q '"walletname"'; then
        ok "watch-only wallet '$BTC_WALLET' loaded"
      else
        warn "watch-only wallet '$BTC_WALLET' NOT loaded — loadwallet it (deposits won't be seen)"
      fi
      # The poller detects deposits via listunspent (minconf=0 + include_unsafe); if THIS read fails,
      # confirmed BTC won't be seen even with the wallet loaded. Read-only — we deliberately do NOT
      # getnewaddress per tick (that would burn the descriptor's keypool range and break real derivation).
      if bcli -rpcwallet="$BTC_WALLET" listunspent 0 9999999 '[]' true >/dev/null 2>&1; then
        ok "BTC deposit scan (listunspent) responds"
      else
        warn "BTC listunspent failed — the poller can't see deposits (wallet/RPC issue)"
      fi
    fi
  fi
else
  echo "skip BTC buy rail (bitcoind not enabled)"
fi

[ "$fail" -eq 0 ] && echo "--- all healthy ---" || echo "--- ATTENTION NEEDED ---"

# Incident open/close: mark a failure; on the first healthy run after one, page "recovered" so the operator
# knows the incident is over without SSHing in. OnFailure= keeps paging the failures; this only closes them.
# /run is tmpfs so a reboot clears the marker (fine: the off-box heartbeat covers a box that dies mid-incident).
if [ "$fail" -ne 0 ]; then
  touch "$STAMP" 2>/dev/null || true
elif [ -e "$STAMP" ]; then
  rm -f "$STAMP" 2>/dev/null || true
  "$(dirname "$0")/alert.sh" --recovered status-check.service || true
fi

# Dead-man's-switch: ping an off-box monitor so SILENCE = alarm (catches a dead box/network/timer that
# OnFailure cannot). healthchecks.io convention: base URL on success, base/fail on failure. No-op if unset.
if [ -n "${HEARTBEAT_URL:-}" ]; then
  if [ "$fail" -eq 0 ]; then curl -fsS --max-time 10 -o /dev/null "$HEARTBEAT_URL" 2>/dev/null || true
  else curl -fsS --max-time 10 -o /dev/null "${HEARTBEAT_URL%/}/fail" 2>/dev/null || true; fi
fi

exit "$fail"
