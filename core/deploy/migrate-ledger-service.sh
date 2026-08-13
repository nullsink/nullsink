#!/usr/bin/env bash
# One-time cutover from a proxy-owned balances.db to the dedicated ledger service. Preparation stops public
# admission, drains the old proxy, snapshots the ledger, and leaves the old topology recoverable. Activation
# happens only after all three new units are healthy. Finalization removes the frozen pre-cutover copy after an
# encrypted backup and offline restore drill have proved the new topology.
set -euo pipefail

mode="${1:---prepare}"
case "$mode" in
  --prepare|--validate|--activate|--rollback|--finalize) ;;
  *) echo "usage: $0 [--prepare|--validate|--activate|--rollback|--finalize]" >&2; exit 2 ;;
esac

ETC_DIR="${NULLSINK_ETC_DIR:-/etc}"
STATE_ROOT="${NULLSINK_STATE_ROOT:-/var/lib}"
SYSTEMD_DIR="${NULLSINK_SYSTEMD_DIR:-/etc/systemd/system}"
BIN_DIR="${NULLSINK_BIN_DIR:-/usr/local/lib/nullsink}"
ROOT_GROUP="${NULLSINK_ROOT_GROUP:-root}"

OPERATOR_USER="${NULLSINK_OPERATOR_USER:-nullsink}"
PROXY_USER="${NULLSINK_PROXY_USER:-nullsink-proxy}"
BACKUP_USER="${NULLSINK_BACKUP_USER:-nullsink-backup}"
LEDGER_USER="${NULLSINK_LEDGER_USER:-nullsink-ledger}"
PROXY_READ_GROUP="${NULLSINK_PROXY_READ_GROUP:-nullsink-proxy-read}"
LEDGER_READ_GROUP="${NULLSINK_LEDGER_READ_GROUP:-nullsink-ledger-read}"
LEDGER_PROXY_GROUP="${NULLSINK_LEDGER_PROXY_GROUP:-nullsink-ledger-proxy}"

OLD_STATE="${NULLSINK_OLD_LEDGER_STATE:-$STATE_ROOT/nullsink-proxy}"
LEDGER_STATE="${NULLSINK_LEDGER_STATE:-$STATE_ROOT/nullsink-ledger}"
PENDING_STATE="${NULLSINK_PENDING_STATE:-$STATE_ROOT/nullsink-payments}"
ROLLBACK_DIR="${NULLSINK_LEDGER_ROLLBACK_DIR:-$STATE_ROOT/nullsink-ledger-migration}"
PREPARED_MARKER="${NULLSINK_LEDGER_PREPARED_MARKER:-$ETC_DIR/nullsink-ledger-extraction.prepared}"
ACTIVATED_MARKER="${NULLSINK_LEDGER_ACTIVATED_MARKER:-$ETC_DIR/nullsink-ledger-extraction.activated}"
FINALIZED_MARKER="${NULLSINK_LEDGER_FINALIZED_MARKER:-$ETC_DIR/nullsink-ledger-extraction.finalized}"

LEDGER_UNIT="${LEDGER_UNIT:-nullsink-ledger}"
PROXY_UNIT="${PROXY_UNIT:-nullsink-proxy}"
PAYMENTS_UNIT="${PAYMENTS_UNIT:-nullsink-payments}"
METERING_SOCK="${NULLSINK_LEDGER_SOCK:-/run/nullsink-ledger/proxy.sock}"
CREDIT_SOCK="${NULLSINK_CREDIT_SOCK:-/run/nullsink-credit/credit.sock}"

die() { echo "ledger-extraction: $*" >&2; exit 1; }
simple_abs() { [[ "$1" != / && "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]; }
for path in "$ETC_DIR" "$STATE_ROOT" "$SYSTEMD_DIR" "$BIN_DIR" "$OLD_STATE" "$LEDGER_STATE" \
  "$PENDING_STATE" "$ROLLBACK_DIR" "$PREPARED_MARKER" "$ACTIVATED_MARKER" "$FINALIZED_MARKER"; do
  simple_abs "$path" || die "path must be simple, absolute, and non-root: $path"
done
for path in "$METERING_SOCK" "$CREDIT_SOCK"; do
  simple_abs "$path" || die "socket path must be simple, absolute, and non-root: $path"
done
[ "$(id -u)" -eq 0 ] || die "run as root"
command -v sqlite3 >/dev/null || die "sqlite3 is required"

ensure_group() { getent group "$1" >/dev/null 2>&1 || groupadd --system "$1"; }
ensure_user() {
  local user="$1" group="$2"
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid "$group" "$user"
  fi
  usermod -g "$group" "$user"
}

ensure_identities() {
  ensure_group "$LEDGER_READ_GROUP"
  ensure_group "$LEDGER_PROXY_GROUP"
  ensure_user "$LEDGER_USER" "$LEDGER_READ_GROUP"
  usermod -a -G "$LEDGER_PROXY_GROUP" "$PROXY_USER"
  usermod -a -G "$LEDGER_READ_GROUP" "$OPERATOR_USER"
  usermod -a -G "$LEDGER_READ_GROUP" "$BACKUP_USER"
  install -d -o "$LEDGER_USER" -g "$LEDGER_READ_GROUP" -m 0750 "$LEDGER_STATE"
}

write_marker() {
  local path="$1" content="$2"
  install -o root -g "$ROOT_GROUP" -m 0600 /dev/null "$path"
  printf '%s\n' "$content" > "$path"
}

marker_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { value = substr($0, length($1) + 2) } END { print value }' "$PREPARED_MARKER"
}

is_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
start_if_recorded() {
  local key="$1" unit="$2"
  if [ "$(marker_value "$key")" = 1 ]; then systemctl start "$unit"; fi
}

table_count() {
  local db="$1" table="$2" query="$3"
  if [ -f "$db" ] && [ "$(sqlite3 -readonly "$db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table';")" = 1 ]; then
    sqlite3 -readonly "$db" "$query"
  else
    echo 0
  fi
}

financial_gate() {
  local balances="$OLD_STATE/balances.db" pending="$PENDING_STATE/pending.db"
  local holds open_orders unacked legacy_ack_payloads partial
  [ -f "$pending" ] || die "pending database is absent; old topology remains stopped"
  [ "$(sqlite3 -readonly "$pending" 'PRAGMA quick_check;' | head -1)" = ok ] || die "pending database failed quick_check; old topology remains stopped"
  holds="$(table_count "$balances" holds 'SELECT COUNT(*) FROM holds;')"
  open_orders="$(table_count "$pending" pending_orders 'SELECT COUNT(*) FROM pending_orders;')"
  unacked="$(table_count "$pending" credit_outbox 'SELECT COUNT(*) FROM credit_outbox WHERE acked_at IS NULL;')"
  legacy_ack_payloads="$(table_count "$pending" credit_outbox "SELECT COUNT(*) FROM credit_outbox WHERE acked_at IS NOT NULL AND hash <> '';")"
  partial="$(table_count "$pending" credit_outbox "SELECT COUNT(*) FROM credit_outbox WHERE (hash = '' AND micros <> 0) OR (hash <> '' AND micros = 0);")"
  printf 'ledger-extraction: stopped-state gate holds=%s open_orders=%s unacked=%s legacy_ack_payloads=%s partial_scrub=%s\n' \
    "$holds" "$open_orders" "$unacked" "$legacy_ack_payloads" "$partial"
  [ "$partial" -eq 0 ] || die "credit outbox has partially scrubbed rows; old topology remains stopped"
  [ "$open_orders" -eq 0 ] || die "open payment orders must settle or expire before extraction; old topology remains stopped"
  [ "$unacked" -eq 0 ] || die "undelivered credits must drain before extraction; old topology remains stopped"
  [ "$legacy_ack_payloads" -eq 0 ] || die "legacy acknowledged credit payloads must be scrubbed before extraction; old topology remains stopped"
  if [ "$holds" -gt 0 ]; then
    echo "ledger-extraction: $holds stopped-session hold(s) will be recovered atomically by proxy startSession"
  fi
}

db_fingerprint() { sqlite3 -readonly "$1" '.dump' | sha256sum | cut -d' ' -f1; }
snapshot_ledger() {
  local source="$OLD_STATE/balances.db" target="$LEDGER_STATE/balances.db" stage source_fp
  [ -f "$source" ] || return 0
  stage="$LEDGER_STATE/.balances.db.migrating"
  rm -f -- "$stage" "$stage-wal" "$stage-shm"
  sqlite3 -readonly -cmd '.timeout 10000' "$source" ".backup '$stage'"
  [ "$(sqlite3 -readonly "$stage" 'PRAGMA quick_check;' | head -1)" = ok ] || die "staged balances.db failed quick_check"
  source_fp="$(db_fingerprint "$source")"
  [ "$(db_fingerprint "$stage")" = "$source_fp" ] || die "staged balances.db fingerprint mismatch"
  install -o "$LEDGER_USER" -g "$LEDGER_READ_GROUP" -m 0640 "$stage" "$target.new"
  mv -f -- "$target.new" "$target"
  rm -f -- "$stage" "$stage-wal" "$stage-shm"
  [ "$(db_fingerprint "$target")" = "$source_fp" ] || die "activated balances.db fingerprint mismatch"
  printf '%s\n' "$source_fp" > "$ROLLBACK_DIR/balances.dump.sha256"
  echo "ledger-extraction: balances.db copied (integrity and logical fingerprint preserved)"
}

save_rollback_contract() {
  local unit target
  install -d -o root -g "$ROOT_GROUP" -m 0700 "$ROLLBACK_DIR"
  for unit in nullsink-proxy.service nullsink-payments.service backup.service status-check.service; do
    [ -f "$SYSTEMD_DIR/$unit" ] || die "rollback source unit is absent: $unit"
    install -o root -g "$ROOT_GROUP" -m 0600 "$SYSTEMD_DIR/$unit" "$ROLLBACK_DIR/$unit"
  done
  for unit in proxy payments; do
    target="$(readlink "$BIN_DIR/current-$unit" 2>/dev/null || true)"
    [[ "$target" =~ ^nullsink-(proxy|payments)-v[0-9A-Za-z.+-]+$ ]] || die "rollback $unit symlink target is absent or unsafe"
    [ -x "$BIN_DIR/$target" ] || die "rollback $unit binary is absent: $target"
    printf '%s\n' "$target" > "$ROLLBACK_DIR/current-$unit.target"
  done
}

validate_marker_contract() {
  local state source_fp key target
  [ -f "$PREPARED_MARKER" ] || die "not prepared"
  [ "$(marker_value prepared)" = 1 ] || die "prepared marker is malformed"
  for key in caddy_was_active backup_timer_was_active status_timer_was_active; do
    [[ "$(marker_value "$key")" =~ ^[01]$ ]] || die "prepared marker has invalid $key"
  done
  state="$(marker_value state)"
  source_fp="$(marker_value source_fingerprint)"
  case "$state" in
    fresh)
      [ "$source_fp" = none ] || die "fresh prepared marker has an invalid source fingerprint"
      [ ! -f "$OLD_STATE/balances.db" ] || die "fresh prepared marker conflicts with an existing source ledger"
      ;;
    existing)
      [[ "$source_fp" =~ ^[0-9a-f]{64}$ ]] || die "existing prepared marker has an invalid source fingerprint"
      [ -f "$OLD_STATE/balances.db" ] || die "frozen source ledger is absent"
      [ "$(sqlite3 -readonly "$OLD_STATE/balances.db" 'PRAGMA quick_check;' | head -1)" = ok ] || die "frozen source ledger failed quick_check"
      [ "$(db_fingerprint "$OLD_STATE/balances.db")" = "$source_fp" ] || die "frozen source ledger fingerprint changed"
      [ -f "$ROLLBACK_DIR/balances.dump.sha256" ] || die "rollback ledger fingerprint is absent"
      [ "$(cat "$ROLLBACK_DIR/balances.dump.sha256")" = "$source_fp" ] || die "rollback ledger fingerprint does not match the marker"
      for key in nullsink-proxy.service nullsink-payments.service backup.service status-check.service \
        current-proxy.target current-payments.target; do
        [ -f "$ROLLBACK_DIR/$key" ] || die "rollback contract is incomplete: $key"
      done
      for key in proxy payments; do
        target="$(cat "$ROLLBACK_DIR/current-$key.target")"
        [[ "$target" =~ ^nullsink-(proxy|payments)-v[0-9A-Za-z.+-]+$ ]] || die "saved rollback $key target is unsafe"
        [ -x "$BIN_DIR/$target" ] || die "saved rollback $key binary is absent: $target"
      done
      ;;
    *) die "prepared marker has an invalid state" ;;
  esac
}

validate_prepared_snapshot() {
  local state source_fp
  validate_marker_contract
  state="$(marker_value state)"
  source_fp="$(marker_value source_fingerprint)"
  if [ "$state" = existing ]; then
    [ -f "$LEDGER_STATE/balances.db" ] || die "migrated balances.db is absent"
    [ "$(sqlite3 -readonly "$LEDGER_STATE/balances.db" 'PRAGMA quick_check;' | head -1)" = ok ] || die "migrated balances.db failed quick_check"
    [ "$(db_fingerprint "$LEDGER_STATE/balances.db")" = "$source_fp" ] || die "migrated balances.db fingerprint does not match the frozen source"
  elif [ -f "$LEDGER_STATE/balances.db" ]; then
    [ "$(sqlite3 -readonly "$LEDGER_STATE/balances.db" 'PRAGMA quick_check;' | head -1)" = ok ] || die "fresh balances.db failed quick_check"
  fi
}

validate_prepared_cutover() {
  local unit state
  validate_prepared_snapshot
  for unit in caddy "$PROXY_UNIT" "$PAYMENTS_UNIT" "$LEDGER_UNIT"; do
    ! is_active "$unit" || die "prepared cutover requires $unit to remain stopped; roll back and prepare again"
  done
  state="$(marker_value state)"
  if [ "$state" = existing ] || [ -f "$PENDING_STATE/pending.db" ]; then financial_gate; fi
}

validate_state() {
  if [ -f "$ACTIVATED_MARKER" ]; then
    [ -f "$PREPARED_MARKER" ] || die "activation marker exists without preparation"
    [ -f "$LEDGER_STATE/balances.db" ] || die "active ledger is absent"
    [ "$(sqlite3 -readonly "$LEDGER_STATE/balances.db" 'PRAGMA quick_check;' | head -1)" = ok ] || die "active ledger failed quick_check"
    echo "ledger-extraction: active state is complete"
    return 0
  fi
  validate_prepared_cutover
  echo "ledger-extraction: prepared state is complete"
}

restore_old_ownership() {
  [ -d "$OLD_STATE" ] || return 0
  chown "$PROXY_USER:$PROXY_READ_GROUP" "$OLD_STATE"
  chmod 0750 "$OLD_STATE"
  find "$OLD_STATE" -maxdepth 1 -type f -exec chown "$PROXY_USER:$PROXY_READ_GROUP" {} +
  find "$OLD_STATE" -maxdepth 1 -type f -exec chmod 0640 {} +
}

restore_recorded_symlink() {
  local service="$1" file target
  file="$ROLLBACK_DIR/current-$service.target"
  [ -f "$file" ] || return 0
  target="$(cat "$file")"
  [[ "$target" =~ ^nullsink-(proxy|payments)-v[0-9A-Za-z.+-]+$ ]] || die "unsafe saved $service symlink target"
  ln -sfn "$target" "$BIN_DIR/current-$service"
}

PREPARE_RECOVERY_ARMED=0
PREPARE_CADDY_ACTIVE=0
PREPARE_BACKUP_ACTIVE=0
PREPARE_STATUS_ACTIVE=0
recover_failed_prepare() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$PREPARE_RECOVERY_ARMED" -eq 1 ]; then
    rm -f -- "$PREPARED_MARKER"
    restore_old_ownership || true
    rm -f -- "$LEDGER_STATE/balances.db" "$LEDGER_STATE/balances.db-wal" "$LEDGER_STATE/balances.db-shm"
    systemctl start "$PROXY_UNIT" "$PAYMENTS_UNIT" || true
    [ "$PREPARE_CADDY_ACTIVE" -eq 0 ] || systemctl start caddy || true
    [ "$PREPARE_BACKUP_ACTIVE" -eq 0 ] || systemctl start backup.timer || true
    [ "$PREPARE_STATUS_ACTIVE" -eq 0 ] || systemctl start status-check.timer || true
    rm -rf -- "$ROLLBACK_DIR"
    echo "ledger-extraction: preparation failed; the unchanged old topology was restored" >&2
  fi
  exit "$status"
}

prepare() {
  ensure_identities
  if [ -f "$PREPARED_MARKER" ]; then
    if [ -f "$ACTIVATED_MARKER" ]; then
      validate_state >/dev/null
      echo "ledger-extraction: already activated"
      return 0
    fi
    validate_prepared_cutover
    echo "ledger-extraction: already prepared"
    return 0
  fi

  if [ ! -f "$OLD_STATE/balances.db" ]; then
    write_marker "$PREPARED_MARKER" $'prepared=1\nstate=fresh\nsource_fingerprint=none\ncaddy_was_active=0\nbackup_timer_was_active=0\nstatus_timer_was_active=0'
    echo "ledger-extraction: prepared fresh ledger state"
    return 0
  fi

  is_active "$PROXY_UNIT" || die "$PROXY_UNIT must be active before extraction"
  is_active "$PAYMENTS_UNIT" || die "$PAYMENTS_UNIT must be active before extraction"
  is_active caddy && PREPARE_CADDY_ACTIVE=1
  is_active backup.timer && PREPARE_BACKUP_ACTIVE=1
  is_active status-check.timer && PREPARE_STATUS_ACTIVE=1
  save_rollback_contract
  PREPARE_RECOVERY_ARMED=1
  trap recover_failed_prepare EXIT

  # Caddy closes admission immediately but preserves established streams while their upstream drains. Install
  # the shared timeout contract before stopping it: the edge must outlive the proxy's full systemd stop window.
  install -d -o root -g "$ROOT_GROUP" -m 0755 "$SYSTEMD_DIR/caddy.service.d"
  install -o root -g "$ROOT_GROUP" -m 0644 "$(dirname "$0")/caddy-drain.conf" \
    "$SYSTEMD_DIR/caddy.service.d/nullsink-drain.conf"
  systemctl daemon-reload
  [ "$PREPARE_CADDY_ACTIVE" -eq 0 ] || systemctl stop --no-block caddy
  systemctl stop backup.timer status-check.timer 2>/dev/null || true
  systemctl stop backup.service status-check.service 2>/dev/null || true
  # Signal the financial services without waiting for Caddy's graceful stream drain. Proxy shutdown has up to
  # 60 seconds to settle in-flight billing; once it exits, Caddy's upstream streams close naturally.
  systemctl stop "$PAYMENTS_UNIT" "$PROXY_UNIT"
  [ "$PREPARE_CADDY_ACTIVE" -eq 0 ] || systemctl stop caddy
  is_active caddy && die "caddy did not stop"
  is_active "$PROXY_UNIT" && die "$PROXY_UNIT did not stop"
  is_active "$PAYMENTS_UNIT" && die "$PAYMENTS_UNIT did not stop"

  financial_gate
  snapshot_ledger
  chown -R "root:$ROOT_GROUP" "$OLD_STATE"
  find "$OLD_STATE" -type d -exec chmod 0700 {} +
  find "$OLD_STATE" -type f -exec chmod 0600 {} +
  write_marker "$PREPARED_MARKER" "prepared=1
state=existing
source_fingerprint=$(cat "$ROLLBACK_DIR/balances.dump.sha256")
caddy_was_active=$PREPARE_CADDY_ACTIVE
backup_timer_was_active=$PREPARE_BACKUP_ACTIVE
status_timer_was_active=$PREPARE_STATUS_ACTIVE"
  PREPARE_RECOVERY_ARMED=0
  trap - EXIT
  echo "ledger-extraction: prepared; old topology is frozen and public admission remains stopped"
}

activate() {
  [ -f "$PREPARED_MARKER" ] || die "not prepared"
  [ ! -f "$ACTIVATED_MARKER" ] || { echo "ledger-extraction: already activated"; return 0; }
  validate_marker_contract
  [ -f "$LEDGER_STATE/balances.db" ] || die "live ledger is absent"
  [ "$(sqlite3 -readonly "$LEDGER_STATE/balances.db" 'PRAGMA quick_check;' | head -1)" = ok ] || die "live ledger failed quick_check"
  [ "$(systemctl show "$LEDGER_UNIT" -p User --value 2>/dev/null)" = "$LEDGER_USER" ] || die "$LEDGER_UNIT has the wrong principal"
  for unit in "$LEDGER_UNIT" "$PROXY_UNIT" "$PAYMENTS_UNIT"; do is_active "$unit" || die "$unit is not active"; done
  [ -S "$METERING_SOCK" ] || die "metering socket is absent"
  [ -S "$CREDIT_SOCK" ] || die "credit socket is absent"
  # Crossing this marker forbids automatic rollback: Caddy may admit traffic as soon as its start job succeeds.
  # Write it first, then fail loudly if the recorded edge cannot start; the new internal topology remains
  # financially safe and the operator gets an explicit availability failure instead of a hidden outage.
  write_marker "$ACTIVATED_MARKER" activated=1
  start_if_recorded caddy_was_active caddy
  echo "ledger-extraction: activated; public admission restored"
}

rollback() {
  [ -f "$PREPARED_MARKER" ] || die "not prepared"
  [ ! -f "$ACTIVATED_MARKER" ] || die "traffic was activated; pre-extraction rollback is forbidden"
  validate_marker_contract
  systemctl stop "$PAYMENTS_UNIT" "$PROXY_UNIT" "$LEDGER_UNIT" 2>/dev/null || true
  systemctl disable "$LEDGER_UNIT" 2>/dev/null || true
  restore_recorded_symlink proxy
  restore_recorded_symlink payments
  for unit in nullsink-proxy.service nullsink-payments.service backup.service status-check.service; do
    [ -f "$ROLLBACK_DIR/$unit" ] && install -o root -g "$ROOT_GROUP" -m 0644 "$ROLLBACK_DIR/$unit" "$SYSTEMD_DIR/$unit"
  done
  rm -f -- "$SYSTEMD_DIR/nullsink-ledger.service"
  rm -f -- "$BIN_DIR/current-ledger"
  rm -rf -- "$LEDGER_STATE"
  systemctl daemon-reload
  restore_old_ownership
  systemctl start "$PROXY_UNIT" "$PAYMENTS_UNIT"
  start_if_recorded caddy_was_active caddy
  start_if_recorded backup_timer_was_active backup.timer
  start_if_recorded status_timer_was_active status-check.timer
  rm -f -- "$PREPARED_MARKER"
  echo "ledger-extraction: rolled back before traffic; old two-service topology restored"
}

finalize() {
  [ -f "$ACTIVATED_MARKER" ] || die "not activated"
  for unit in "$LEDGER_UNIT" "$PROXY_UNIT" "$PAYMENTS_UNIT"; do is_active "$unit" || die "$unit is not active"; done
  [ -f "$LEDGER_STATE/balances.db" ] || die "live ledger is absent"
  [ "$(sqlite3 -readonly "$LEDGER_STATE/balances.db" 'PRAGMA quick_check;' | head -1)" = ok ] || die "live ledger failed quick_check"
  rm -rf -- "$OLD_STATE" "$ROLLBACK_DIR"
  write_marker "$FINALIZED_MARKER" finalized=1
  echo "ledger-extraction: finalized; frozen proxy-owned ledger and rollback bundle removed"
}

case "$mode" in
  --prepare) prepare ;;
  --validate) validate_state ;;
  --activate) activate ;;
  --rollback) rollback ;;
  --finalize) finalize ;;
esac
