#!/usr/bin/env bash
# Give one Pi SSH public key read-only rsync access to finalized backup artifacts/reports. Run on the app box:
#   sudo backup-collector/setup-export.sh /path/to/pi-id_ed25519.pub
set -euo pipefail

die() { echo "setup-export: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$#" -eq 1 ] || die "usage: setup-export.sh PI_PUBLIC_KEY_FILE"
[ -s "$1" ] || die "public key file is missing or empty: $1"

EXPORT_USER="nullsink-backup-export"
EXPORT_GROUP="nullsink-backup-export"
BACKUP_DIR="/var/lib/nullsink/backups"
AUTHORIZED_DIR="/var/lib/$EXPORT_USER/.ssh"
AUTHORIZED_KEYS="$AUTHORIZED_DIR/authorized_keys"

command -v useradd >/dev/null || die "useradd not found"
command -v ssh-keygen >/dev/null || die "ssh-keygen not found"
id nullsink >/dev/null 2>&1 || die "nullsink service user does not exist"
[ -f /etc/nullsink.env ] || die "/etc/nullsink.env does not exist"
recipient="$(
  awk -F= '$1 == "BACKUP_AGE_RECIPIENT" { print $2 }' /etc/nullsink.env |
    tail -n 1
)"
[ -n "$recipient" ] ||
  die "BACKUP_AGE_RECIPIENT must be set in /etc/nullsink.env before enabling the export"

read -r key_type key_blob _ < "$1"
[ "$key_type" = ssh-ed25519 ] || die "collector key must be ssh-ed25519"
[[ "$key_blob" =~ ^[A-Za-z0-9+/=]+$ ]] || die "collector public key is malformed"
key_file="$(mktemp)"
trap 'rm -f "$key_file"' EXIT
printf '%s %s\n' "$key_type" "$key_blob" > "$key_file"
ssh-keygen -l -f "$key_file" >/dev/null || die "collector public key is invalid"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync openssh-client
command -v rrsync >/dev/null || die "rrsync was not installed with rsync"
rrsync_path="$(command -v rrsync)"

getent group "$EXPORT_GROUP" >/dev/null || groupadd --system "$EXPORT_GROUP"
if ! id "$EXPORT_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "/var/lib/$EXPORT_USER" --create-home --shell /bin/sh \
    --gid "$EXPORT_GROUP" "$EXPORT_USER"
fi
passwd -l "$EXPORT_USER" >/dev/null

install -d -o "$EXPORT_USER" -g "$EXPORT_GROUP" -m 0700 "$AUTHORIZED_DIR"
printf 'restrict,command="%s -ro %s" %s %s\n' \
  "$rrsync_path" "$BACKUP_DIR" "$key_type" "$key_blob" > "$AUTHORIZED_KEYS"
chown "$EXPORT_USER:$EXPORT_GROUP" "$AUTHORIZED_KEYS"
chmod 0600 "$AUTHORIZED_KEYS"

# Only backup.service can publish into the export group. The SSH account receives no app environment, no
# database-group membership, and no shell command other than read-only rrsync rooted at BACKUP_DIR.
install -d -o root -g root -m 0755 /etc/systemd/system/backup.service.d
cat > /etc/systemd/system/backup.service.d/export.conf <<EOF
[Service]
SupplementaryGroups=$EXPORT_GROUP
Environment=BACKUP_EXPORT_GROUP=$EXPORT_GROUP
EOF

install -d -o nullsink -g nullsink -m 0755 "$BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'backup-*.tar.age' -o -name 'report-*.json' \) \
  -exec chgrp "$EXPORT_GROUP" {} + \
  -exec chmod 0640 {} +

systemctl daemon-reload

echo "setup-export: installed restricted read-only export for:"
ssh-keygen -l -f "$key_file"
echo "setup-export: run 'systemctl start backup.service' to prove the next encrypted pair is exportable"
