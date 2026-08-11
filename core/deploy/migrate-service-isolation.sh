#!/usr/bin/env bash
# One-time, idempotent migration from the legacy shared nullsink uid/env/state to distinct proxy, payments,
# backup, and operator principals. Preparation is an explicit quiet-window operation before the first isolated
# deploy; finalization is explicit only after health, backup, and offline restore proof. No secret or row prints.
set -euo pipefail

mode="${1:---prepare}"
case "$mode" in --prepare|--finalize) ;; *) echo "usage: $0 [--prepare|--finalize]" >&2; exit 2 ;; esac

APP_DIR="${APP_DIR:-/opt/nullsink}"
ETC_DIR="${NULLSINK_ETC_DIR:-/etc}"
STATE_ROOT="${NULLSINK_STATE_ROOT:-/var/lib}"
SYSTEMD_DIR="${NULLSINK_SYSTEMD_DIR:-/etc/systemd/system}"
ROOT_GROUP="${NULLSINK_ROOT_GROUP:-root}"

OPERATOR_USER="${NULLSINK_OPERATOR_USER:-nullsink}"
PROXY_USER="${NULLSINK_PROXY_USER:-nullsink-proxy}"
PAYMENTS_USER="${NULLSINK_PAYMENTS_USER:-nullsink-payments}"
BACKUP_USER="${NULLSINK_BACKUP_USER:-nullsink-backup}"
PROXY_READ_GROUP="${NULLSINK_PROXY_READ_GROUP:-nullsink-proxy-read}"
PAYMENTS_READ_GROUP="${NULLSINK_PAYMENTS_READ_GROUP:-nullsink-payments-read}"
BACKUP_GROUP="${NULLSINK_BACKUP_GROUP:-nullsink-backup}"
CREDIT_GROUP="${NULLSINK_CREDIT_GROUP:-nullsink-credit}"
EXPORT_USER="${NULLSINK_EXPORT_USER:-nullsink-backup-export}"
EXPORT_GROUP="${NULLSINK_EXPORT_GROUP:-nullsink-backup-export}"

LEGACY_ENV="${NULLSINK_LEGACY_ENV:-$ETC_DIR/nullsink.env}"
PROXY_ENV="${NULLSINK_PROXY_ENV:-$ETC_DIR/nullsink-proxy.env}"
PAYMENTS_ENV="${NULLSINK_PAYMENTS_ENV:-$ETC_DIR/nullsink-payments.env}"
BACKUP_ENV="${NULLSINK_BACKUP_ENV:-$ETC_DIR/nullsink-backup.env}"
MONITOR_ENV="${NULLSINK_MONITOR_ENV:-$ETC_DIR/nullsink-monitor.env}"

LEGACY_STATE="${NULLSINK_LEGACY_STATE:-$STATE_ROOT/nullsink}"
PROXY_STATE="${NULLSINK_PROXY_STATE:-$STATE_ROOT/nullsink-proxy}"
PAYMENTS_STATE="${NULLSINK_PAYMENTS_STATE:-$STATE_ROOT/nullsink-payments}"
BACKUP_STATE="${NULLSINK_BACKUP_STATE:-$STATE_ROOT/nullsink-backup}"
PREPARED_MARKER="${NULLSINK_PREPARED_MARKER:-$ETC_DIR/nullsink-service-isolation.prepared}"
FINALIZED_MARKER="${NULLSINK_FINALIZED_MARKER:-$ETC_DIR/nullsink-service-isolation.finalized}"

PROXY_UNIT="${PROXY_UNIT:-nullsink-proxy}"
PAYMENTS_UNIT="${PAYMENTS_UNIT:-nullsink-payments}"

env_tmpdir=""
die() {
  echo "service-isolation: $*" >&2
  [ -z "$env_tmpdir" ] || rm -rf -- "$env_tmpdir"
  exit 1
}
simple_abs() { [[ "$1" != / && "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]; }
for path in "$APP_DIR" "$ETC_DIR" "$STATE_ROOT" "$SYSTEMD_DIR" "$LEGACY_ENV" "$PROXY_ENV" \
  "$PAYMENTS_ENV" "$BACKUP_ENV" "$MONITOR_ENV" "$LEGACY_STATE" "$PROXY_STATE" "$PAYMENTS_STATE" \
  "$BACKUP_STATE" "$PREPARED_MARKER" "$FINALIZED_MARKER"; do
  simple_abs "$path" || die "path must be simple, absolute, and non-root: $path"
done
[ "$(id -u)" -eq 0 ] || die "run as root"

ensure_group() { getent group "$1" >/dev/null 2>&1 || groupadd --system "$1"; }
ensure_user() { # $1=user $2=primary-group $3=home
  if ! id "$1" >/dev/null 2>&1; then
    if [ "$3" = /nonexistent ]; then
      useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid "$2" "$1"
    else
      useradd --system --create-home --home-dir "$3" --shell /usr/sbin/nologin --gid "$2" "$1"
    fi
  fi
  usermod -g "$2" "$1"
}

ensure_identities() {
  ensure_group "$PROXY_READ_GROUP"
  ensure_group "$PAYMENTS_READ_GROUP"
  ensure_group "$BACKUP_GROUP"
  ensure_group "$CREDIT_GROUP"
  ensure_group "$OPERATOR_USER"
  ensure_user "$OPERATOR_USER" "$OPERATOR_USER" "$STATE_ROOT/$OPERATOR_USER-home"
  ensure_user "$PROXY_USER" "$PROXY_READ_GROUP" /nonexistent
  ensure_user "$PAYMENTS_USER" "$PAYMENTS_READ_GROUP" /nonexistent
  ensure_user "$BACKUP_USER" "$BACKUP_GROUP" "$STATE_ROOT/$BACKUP_USER-home"
  usermod -a -G "$PROXY_READ_GROUP,$PAYMENTS_READ_GROUP" "$OPERATOR_USER"
  usermod -a -G "$PROXY_READ_GROUP,$PAYMENTS_READ_GROUP" "$BACKUP_USER"
  usermod -a -G "$CREDIT_GROUP" "$PAYMENTS_USER"
}

append_env() { printf '%s\n' "$2" >> "$1"; }

route_legacy_assignment() { # $1=key $2=raw assignment
  local key="$1" line="$2"
  case "$key" in
    HOST|READ_RATE_CAPACITY|READ_RATE_REFILL_PER_MIN|METRICS_FLUSH_MS)
      append_env "$tmp_proxy" "$line"; append_env "$tmp_payments" "$line" ;;
    PORT|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_VERSION|OPENAI_API_KEY|OPENAI_BASE_URL|TINFOIL_API_KEY|TINFOIL_BASE_URL|HOLD_ESTIMATOR|UPSTREAM_TIMEOUT_MS|STREAM_SETTLE_DEADLINE_MS|COUNT_TOKENS_TIMEOUT_MS|DEFAULT_MAX_OUTPUT_TOKENS|SHUTDOWN_GRACE_MS)
      append_env "$tmp_proxy" "$line" ;;
    PAYMENTS_PORT|CREDIT_TIMEOUT_MS|OUTBOX_AGE_ALERT_MS|MARGIN|BUY_MIN_USD|BUY_MAX_USD|POLL_INTERVAL_MS|POLL_FAIL_ALERT|MAX_OPEN_ORDERS|ORDER_TTL_MS|REAP_GRACE_MS|ORDER_BACKSTOP_MS|BUY_RATE_CAPACITY|BUY_RATE_REFILL_PER_MIN|RATE_URL|RATE_URL_COINGECKO|RATE_SOURCES|RATE_CACHE_MS|RATE_TIMEOUT_MS|RATE_MIN_USD|RATE_MAX_USD|BTC_RATE_URL|BTC_RATE_URL_COINGECKO|BTC_RATE_MIN_USD|BTC_RATE_MAX_USD)
      append_env "$tmp_payments" "$line" ;;
    PAY_RAILS|PAY_RAIL|MONERO_WALLET_RPC_URL|MONERO_ACCOUNT_INDEX|MONERO_TIMEOUT_MS|MONERO_CONFIRMATIONS|BITCOIN_RPC_URL|BITCOIN_RPC_USER|BITCOIN_RPC_PASSWORD|BITCOIN_TIMEOUT_MS|BITCOIN_CONFIRMATIONS)
      append_env "$tmp_payments" "$line" ;;
    BACKUP_AGE_RECIPIENT|BACKUP_KEEP|BACKUP_PUSH_CMD|BACKUP_PUSH_ALLOW_PLAINTEXT)
      append_env "$tmp_backup" "$line" ;;
    NULLSINK_DOMAIN|NULLSINK_WEBROOT|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|HEARTBEAT_URL|TOR_SOCKS|NODE_ENV_FILE|LAG_BLOCKS|RPC_TIMEOUT|DISK_WARN_PCT|PROXY_HEALTHZ_URL|PAYMENTS_HEALTHZ_URL|LOG_WINDOW|BACKUP_MAX_AGE_H|STAMP|MEM_WARN_PCT|NRESTARTS_WARN)
      append_env "$tmp_monitor" "$line" ;;
    DB_PATH|BALANCES_DB_PATH|PENDING_DB_PATH|CREDIT_SOCK|BACKUP_DIR|BACKUP_EXPORT_GROUP)
      die "$key must be unit-owned; remove it from $LEGACY_ENV before migration" ;;
    *) die "unknown setting '$key' in $LEGACY_ENV; classify it before migration" ;;
  esac
}

write_default_envs() {
  cat > "$tmp_proxy" <<'EOF'
# nullsink proxy trust domain — provider credentials and metering controls only.
ANTHROPIC_API_KEY=replace-me
OPENAI_API_KEY=
TINFOIL_API_KEY=
HOST=127.0.0.1
PORT=8080
EOF
  cat > "$tmp_payments" <<'EOF'
# nullsink payments trust domain — buy rails, wallet/node credentials, and settlement controls only.
HOST=127.0.0.1
PAYMENTS_PORT=8081
PAY_RAILS=monero
MONERO_WALLET_RPC_URL=http://127.0.0.1:18083/json_rpc
BITCOIN_RPC_URL=http://10.55.0.2:8332/wallet/nullsink
BITCOIN_RPC_USER=
BITCOIN_RPC_PASSWORD=
EOF
  cat > "$tmp_backup" <<'EOF'
# nullsink backup trust domain — encryption recipient, retention, and optional ciphertext push only.
BACKUP_AGE_RECIPIENT=
BACKUP_KEEP=84
BACKUP_PUSH_CMD=
EOF
  cat > "$tmp_monitor" <<'EOF'
# root control plane — public edge, alerting, and dead-man monitoring.
NULLSINK_DOMAIN=
NULLSINK_WEBROOT=/var/www/nullsink/current-web
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
HEARTBEAT_URL=
EOF
}

split_or_create_envs() {
  local tmpdir line key
  tmpdir="$(mktemp -d)"
  env_tmpdir="$tmpdir"
  tmp_proxy="$tmpdir/proxy.env"
  tmp_payments="$tmpdir/payments.env"
  tmp_backup="$tmpdir/backup.env"
  tmp_monitor="$tmpdir/monitor.env"

  if [ -f "$LEGACY_ENV" ]; then
    printf '%s\n' '# Migrated from the legacy shared environment; edit this role-specific file from now on.' > "$tmp_proxy"
    printf '%s\n' '# Migrated from the legacy shared environment; edit this role-specific file from now on.' > "$tmp_payments"
    printf '%s\n' '# Migrated from the legacy shared environment; edit this role-specific file from now on.' > "$tmp_backup"
    printf '%s\n' '# Migrated from the legacy shared environment; edit this role-specific file from now on.' > "$tmp_monitor"
    while IFS= read -r line || [ -n "$line" ]; do
      [[ "$line" =~ ^[[:space:]]*$|^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || die "unsupported line in $LEGACY_ENV (expected KEY=value or comment)"
      key="${BASH_REMATCH[1]}"
      route_legacy_assignment "$key" "$line"
    done < "$LEGACY_ENV"
  else
    write_default_envs
  fi

  [ -f "$PROXY_ENV" ] || install -o root -g "$ROOT_GROUP" -m 0600 "$tmp_proxy" "$PROXY_ENV"
  [ -f "$PAYMENTS_ENV" ] || install -o root -g "$ROOT_GROUP" -m 0600 "$tmp_payments" "$PAYMENTS_ENV"
  [ -f "$BACKUP_ENV" ] || install -o root -g "$ROOT_GROUP" -m 0600 "$tmp_backup" "$BACKUP_ENV"
  [ -f "$MONITOR_ENV" ] || install -o root -g "$ROOT_GROUP" -m 0600 "$tmp_monitor" "$MONITOR_ENV"

  for role_env in "$PROXY_ENV" "$PAYMENTS_ENV" "$BACKUP_ENV" "$MONITOR_ENV"; do
    chown "root:$ROOT_GROUP" "$role_env"
    chmod 0600 "$role_env"
  done

  for role_env in "$PROXY_ENV" "$PAYMENTS_ENV" "$BACKUP_ENV" "$MONITOR_ENV"; do
    if grep -Eq '^(DB_PATH|BALANCES_DB_PATH|PENDING_DB_PATH|CREDIT_SOCK|BACKUP_DIR|BACKUP_EXPORT_GROUP)=' "$role_env"; then
      die "storage/socket settings must be unit-owned, not present in $role_env"
    fi
  done
  rm -rf -- "$tmpdir"
  env_tmpdir=""

  # systemd reads EnvironmentFile as root before dropping privileges, so root-locking the legacy file does not
  # impair rollback to the old units. It does immediately remove the operator principal's obsolete all-secrets
  # view; the legacy databases remain writable until explicit finalization because an app rollback may need them.
  if [ -f "$LEGACY_ENV" ]; then chown "root:$ROOT_GROUP" "$LEGACY_ENV"; chmod 0600 "$LEGACY_ENV"; fi
}

export_enabled() {
  getent group "$EXPORT_GROUP" >/dev/null 2>&1 && id "$EXPORT_USER" >/dev/null 2>&1
}

ensure_directories() {
  install -d -o "$PROXY_USER" -g "$PROXY_READ_GROUP" -m 0750 "$PROXY_STATE"
  install -d -o "$PAYMENTS_USER" -g "$PAYMENTS_READ_GROUP" -m 0750 "$PAYMENTS_STATE"
  if export_enabled; then
    install -d -o "$BACKUP_USER" -g "$EXPORT_GROUP" -m 0750 "$BACKUP_STATE"
  else
    install -d -o "$BACKUP_USER" -g "$BACKUP_GROUP" -m 0700 "$BACKUP_STATE"
  fi
  if [ -d "$APP_DIR" ]; then
    chown -R "root:$ROOT_GROUP" "$APP_DIR"
    chmod -R go-w "$APP_DIR"
  fi
}

write_marker() { # $1=path $2=content
  install -o root -g "$ROOT_GROUP" -m 0600 /dev/null "$1"
  printf '%s\n' "$2" > "$1"
}

table_exists() { [ "$(sqlite3 -readonly "$1" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$2';")" = 1 ]; }
count_or_zero() { # $1=db $2=table $3=query
  if [ -f "$1" ] && table_exists "$1" "$2"; then sqlite3 -readonly "$1" "$3"; else echo 0; fi
}

quiet_gate() {
  local balances="$LEGACY_STATE/balances.db" pending="$LEGACY_STATE/pending.db"
  local holds open_orders unacked partial
  holds="$(count_or_zero "$balances" holds 'SELECT COUNT(*) FROM holds;')"
  open_orders="$(count_or_zero "$pending" pending_orders 'SELECT COUNT(*) FROM pending_orders;')"
  unacked="$(count_or_zero "$pending" credit_outbox 'SELECT COUNT(*) FROM credit_outbox WHERE acked_at IS NULL;')"
  partial="$(count_or_zero "$pending" credit_outbox "SELECT COUNT(*) FROM credit_outbox WHERE (hash = '' AND micros <> 0) OR (hash <> '' AND micros = 0);")"
  printf 'service-isolation: quiet gate holds=%s open_orders=%s unacked=%s partial_scrub=%s\n' \
    "$holds" "$open_orders" "$unacked" "$partial"
  [ "$holds" -eq 0 ] && [ "$open_orders" -eq 0 ] && [ "$unacked" -eq 0 ] && [ "$partial" -eq 0 ] ||
    die "legacy billing state is not quiet; migration refused and old services will be restarted"
}

db_fingerprint() { sqlite3 -readonly "$1" '.dump' | sha256sum | cut -d' ' -f1; }
migrate_db() { # $1=source $2=target $3=owner $4=group
  local source="$1" target="$2" owner="$3" group="$4" stage source_fp stage_fp check
  [ -f "$source" ] || return 0
  stage="$target.migrating"
  rm -f -- "$stage" "$stage-wal" "$stage-shm"
  sqlite3 -readonly -cmd '.timeout 10000' "$source" ".backup '$stage'"
  check="$(sqlite3 -readonly "$stage" 'PRAGMA quick_check;' | head -1)"
  [ "$check" = ok ] || die "integrity check failed for staged $(basename "$target")"
  source_fp="$(db_fingerprint "$source")"
  stage_fp="$(db_fingerprint "$stage")"
  [ "$source_fp" = "$stage_fp" ] || die "logical fingerprint mismatch for $(basename "$target")"
  install -o "$owner" -g "$group" -m 0640 "$stage" "$target.new"
  mv -f -- "$target.new" "$target"
  rm -f -- "$stage" "$stage-wal" "$stage-shm"
  [ "$(db_fingerprint "$target")" = "$source_fp" ] || die "activated fingerprint mismatch for $(basename "$target")"
  echo "service-isolation: migrated $(basename "$target") (integrity and logical fingerprint preserved)"
}

migrate_backups() {
  local old="$LEGACY_STATE/backups" file base auth dropin
  [ -d "$old" ] || return 0
  while IFS= read -r file; do
    base="$(basename "$file")"
    install -p -o "$BACKUP_USER" -g "$BACKUP_GROUP" -m 0600 "$file" "$BACKUP_STATE/$base"
    if export_enabled && [[ "$base" = backup-*.tar.age || "$base" = report-*.json ]]; then
      chgrp "$EXPORT_GROUP" "$BACKUP_STATE/$base"
      chmod 0640 "$BACKUP_STATE/$base"
    fi
  done < <(find "$old" -maxdepth 1 -type f \( -name 'backup-*.tar' -o -name 'backup-*.tar.age' -o -name 'report-*.json' \) -print)

  if export_enabled; then
    auth="$STATE_ROOT/$EXPORT_USER/.ssh/authorized_keys"
    if [ -f "$auth" ]; then
      sed -i "s#$LEGACY_STATE/backups#$BACKUP_STATE#g" "$auth"
    fi
    dropin="$SYSTEMD_DIR/backup.service.d/export.conf"
    if [ -f "$dropin" ]; then
      cat > "$dropin" <<EOF
[Service]
SupplementaryGroups=$EXPORT_GROUP
Environment=BACKUP_EXPORT_GROUP=$EXPORT_GROUP
Environment=BACKUP_DIR=$BACKUP_STATE
ReadWritePaths=$BACKUP_STATE
EOF
    fi
  fi
}

was_proxy=0; was_payments=0; was_backup_timer=0; was_status_timer=0; stopped_legacy=0
restart_legacy_after_error() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$stopped_legacy" -eq 1 ]; then
    [ "$was_proxy" -eq 0 ] || systemctl start "$PROXY_UNIT" >/dev/null 2>&1 || true
    [ "$was_payments" -eq 0 ] || systemctl start "$PAYMENTS_UNIT" >/dev/null 2>&1 || true
    [ "$was_backup_timer" -eq 0 ] || systemctl start backup.timer >/dev/null 2>&1 || true
    [ "$was_status_timer" -eq 0 ] || systemctl start status-check.timer >/dev/null 2>&1 || true
  fi
  exit "$status"
}

prepare() {
  ensure_identities
  split_or_create_envs
  ensure_directories
  if [ -f "$PREPARED_MARKER" ]; then
    for db in "$PROXY_STATE/balances.db" "$PAYMENTS_STATE/pending.db"; do
      [ -f "$db" ] || continue
      [ "$(sqlite3 -readonly "$db" 'PRAGMA quick_check;' | head -1)" = ok ] || die "prepared database is corrupt: $db"
    done
    echo "service-isolation: already prepared"
    return 0
  fi

  if [ -f "$LEGACY_STATE/balances.db" ] || [ -f "$LEGACY_STATE/pending.db" ]; then
    systemctl is-active --quiet "$PROXY_UNIT" 2>/dev/null && was_proxy=1
    systemctl is-active --quiet "$PAYMENTS_UNIT" 2>/dev/null && was_payments=1
    systemctl is-active --quiet backup.timer 2>/dev/null && was_backup_timer=1
    systemctl is-active --quiet status-check.timer 2>/dev/null && was_status_timer=1
    systemctl stop backup.timer >/dev/null 2>&1 || true
    systemctl stop status-check.timer >/dev/null 2>&1 || true
    systemctl stop backup.service >/dev/null 2>&1 || true
    systemctl stop "$PAYMENTS_UNIT" >/dev/null 2>&1 || true
    systemctl stop "$PROXY_UNIT" >/dev/null 2>&1 || true
    stopped_legacy=1
    trap restart_legacy_after_error EXIT
    systemctl is-active --quiet "$PROXY_UNIT" 2>/dev/null && die "$PROXY_UNIT did not stop"
    systemctl is-active --quiet "$PAYMENTS_UNIT" 2>/dev/null && die "$PAYMENTS_UNIT did not stop"
    quiet_gate
    migrate_db "$LEGACY_STATE/balances.db" "$PROXY_STATE/balances.db" "$PROXY_USER" "$PROXY_READ_GROUP"
    migrate_db "$LEGACY_STATE/pending.db" "$PAYMENTS_STATE/pending.db" "$PAYMENTS_USER" "$PAYMENTS_READ_GROUP"
    migrate_backups
  fi

  write_marker "$PREPARED_MARKER" prepared=1
  trap - EXIT
  echo "service-isolation: prepared; install the new units and start proxy, then payments"
}

finalize() {
  [ -f "$PREPARED_MARKER" ] || die "not prepared"
  [ "$(systemctl show "$PROXY_UNIT" -p User --value 2>/dev/null)" = "$PROXY_USER" ] || die "$PROXY_UNIT is not running as $PROXY_USER"
  [ "$(systemctl show "$PAYMENTS_UNIT" -p User --value 2>/dev/null)" = "$PAYMENTS_USER" ] || die "$PAYMENTS_UNIT is not running as $PAYMENTS_USER"
  systemctl is-active --quiet "$PROXY_UNIT" || die "$PROXY_UNIT is not active"
  systemctl is-active --quiet "$PAYMENTS_UNIT" || die "$PAYMENTS_UNIT is not active"
  if [ -d "$LEGACY_STATE" ]; then
    chown -R "root:$ROOT_GROUP" "$LEGACY_STATE"
    find "$LEGACY_STATE" -type d -exec chmod 0700 {} +
    find "$LEGACY_STATE" -type f -exec chmod 0600 {} +
  fi
  if [ -f "$LEGACY_ENV" ]; then chown "root:$ROOT_GROUP" "$LEGACY_ENV"; chmod 0600 "$LEGACY_ENV"; fi
  write_marker "$FINALIZED_MARKER" finalized=1
  echo "service-isolation: finalized; legacy env/state retained root-only for bounded rollback"
}

if [ "$mode" = --prepare ]; then prepare; else finalize; fi
