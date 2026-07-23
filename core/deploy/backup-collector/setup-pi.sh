#!/usr/bin/env bash
# Install the pull-only collector on a Debian/Raspberry Pi host. Run as root from this directory.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "setup-pi: run as root" >&2; exit 1; }

COLLECTOR_USER="nullsink-backup"
APP_DIR="/opt/nullsink-backup"
STATE_DIR="/var/lib/nullsink-backup"
STORE_DIR="/srv/nullsink-backups"
CONFIG_DIR="/etc/nullsink-backup"
ENV_FILE="/etc/nullsink-backup.env"
script_dir="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync openssh-client python3 curl

if ! id "$COLLECTOR_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$COLLECTOR_USER"
fi

install -d -o root -g root -m 0755 "$APP_DIR"
install -o root -g root -m 0755 "$script_dir/pull.sh" "$APP_DIR/pull.sh"
install -o root -g root -m 0755 "$script_dir/verify-store.py" "$APP_DIR/verify-store.py"
install -o root -g root -m 0644 \
  "$script_dir/nullsink-backup-pull.service" \
  /etc/systemd/system/nullsink-backup-pull.service
install -o root -g root -m 0644 \
  "$script_dir/nullsink-backup-pull.timer" \
  /etc/systemd/system/nullsink-backup-pull.timer

install -d -o "$COLLECTOR_USER" -g "$COLLECTOR_USER" -m 0700 "$STATE_DIR" "$STORE_DIR"
install -d -o root -g root -m 0755 "$CONFIG_DIR"
touch "$CONFIG_DIR/known_hosts"
chown root:root "$CONFIG_DIR/known_hosts"
chmod 0644 "$CONFIG_DIR/known_hosts"

if [ ! -f "$STATE_DIR/id_ed25519" ]; then
  runuser -u "$COLLECTOR_USER" -- \
    ssh-keygen -q -t ed25519 -N '' -C 'nullsink-backup-pull' -f "$STATE_DIR/id_ed25519"
fi
chown "$COLLECTOR_USER:$COLLECTOR_USER" "$STATE_DIR"/id_ed25519*
chmod 0600 "$STATE_DIR/id_ed25519"
chmod 0644 "$STATE_DIR/id_ed25519.pub"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# The production-side setup-export.sh restricts this account to read-only rsync rooted at the backup spool.
BACKUP_SOURCE=nullsink-backup-export@replace-with-production-host:/
BACKUP_STORE=/srv/nullsink-backups
# Production runs every four hours; this alerts after the normal run plus retry headroom is exhausted.
BACKUP_MAX_AGE_HOURS=6
BACKUP_RETENTION_DAYS=90
# Optional dead-man switch URL. A successful pull pings it; no artifact metadata is sent.
BACKUP_HEARTBEAT_URL=
EOF
  chmod 0600 "$ENV_FILE"
fi

systemctl daemon-reload

echo
echo "setup-pi: installed but did not enable the timer"
echo "setup-pi: collector public key (install this on production with setup-export.sh):"
cat "$STATE_DIR/id_ed25519.pub"
echo
echo "Next:"
echo "  1. replace the host in $ENV_FILE"
echo "  2. pin production's verified SSH host key in $CONFIG_DIR/known_hosts"
echo "  3. run: systemctl start nullsink-backup-pull.service"
echo "  4. inspect: cat $STATE_DIR/last-success.json"
echo "  5. enable: systemctl enable --now nullsink-backup-pull.timer"
