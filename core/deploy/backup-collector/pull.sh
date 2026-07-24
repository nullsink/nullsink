#!/usr/bin/env bash
# Pull finalized encrypted recovery artifacts + aggregate reports from the restricted production export.
# The collector deliberately has no age identity and never receives plaintext database archives.
set -euo pipefail

die() { echo "backup-pull: $*" >&2; exit 1; }

BACKUP_SOURCE="${BACKUP_SOURCE:-}"
BACKUP_STORE="${BACKUP_STORE:-/srv/nullsink-backups}"
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/nullsink-backup}"
BACKUP_SSH_KEY="${BACKUP_SSH_KEY:-$BACKUP_STATE_DIR/id_ed25519}"
BACKUP_KNOWN_HOSTS="${BACKUP_KNOWN_HOSTS:-/etc/nullsink-backup/known_hosts}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-6}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-90}"
BACKUP_HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-}"
script_dir="$(cd "$(dirname "$0")" && pwd)"

[ -n "$BACKUP_SOURCE" ] || die "BACKUP_SOURCE is unset"
[[ "$BACKUP_SOURCE" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*:/$ ]] ||
  die "BACKUP_SOURCE must be a simple user@host:/ value"
[[ "$BACKUP_STORE" = /* && "$BACKUP_STORE" != / ]] || die "BACKUP_STORE must be an absolute non-root path"
[[ "$BACKUP_STATE_DIR" = /* && "$BACKUP_STATE_DIR" != / ]] || die "BACKUP_STATE_DIR must be an absolute non-root path"
for value in "$BACKUP_SSH_KEY" "$BACKUP_KNOWN_HOSTS" "$BACKUP_STORE" "$BACKUP_STATE_DIR"; do
  [[ "$value" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "paths may contain only letters, digits, dot, slash, underscore, and hyphen"
done
[[ -z "$BACKUP_HEARTBEAT_URL" || "$BACKUP_HEARTBEAT_URL" =~ ^https?:// ]] ||
  die "BACKUP_HEARTBEAT_URL must be an HTTP(S) URL"
[[ "$BACKUP_MAX_AGE_HOURS" =~ ^[0-9]+$ ]] && [ "$BACKUP_MAX_AGE_HOURS" -gt 0 ] ||
  die "BACKUP_MAX_AGE_HOURS must be a positive integer"
[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$BACKUP_RETENTION_DAYS" -gt 0 ] ||
  die "BACKUP_RETENTION_DAYS must be a positive integer"

command -v rsync >/dev/null || die "rsync not found"
command -v ssh >/dev/null || die "ssh not found"
command -v python3 >/dev/null || die "python3 not found"
[ -r "$BACKUP_SSH_KEY" ] || die "SSH key is not readable: $BACKUP_SSH_KEY"
[ -s "$BACKUP_KNOWN_HOSTS" ] || die "known_hosts is missing or empty: $BACKUP_KNOWN_HOSTS"

mkdir -p "$BACKUP_STORE" "$BACKUP_STATE_DIR"
chmod 700 "$BACKUP_STORE" "$BACKUP_STATE_DIR"

ssh_transport="ssh -i $BACKUP_SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$BACKUP_KNOWN_HOSTS"

# The server key is forced through rrsync -ro, and these filters further narrow the client to the two
# finalized filename families. No --delete: a short production retention window must not erase older Pi
# recovery points.
rsync \
  --recursive \
  --links \
  --times \
  --checksum \
  --partial \
  --prune-empty-dirs \
  --chmod=F600,D700 \
  --include='/backup-*.tar.age' \
  --include='/report-*.json' \
  --exclude='*' \
  -e "$ssh_transport" \
  "$BACKUP_SOURCE" "$BACKUP_STORE/"

python3 "$script_dir/verify-store.py" \
  --store "$BACKUP_STORE" \
  --state-dir "$BACKUP_STATE_DIR" \
  --max-age-hours "$BACKUP_MAX_AGE_HOURS" \
  --retention-days "$BACKUP_RETENTION_DAYS"

# Optional dead-man switch: the remote monitor alerts when successful pulls stop. No artifact metadata or
# business data leaves the Pi; the request itself is the entire signal.
if [ -n "$BACKUP_HEARTBEAT_URL" ]; then
  command -v curl >/dev/null || die "BACKUP_HEARTBEAT_URL is set but curl is not installed"
  curl -fsS --max-time 15 -o /dev/null "$BACKUP_HEARTBEAT_URL" ||
    die "heartbeat request failed"
fi

echo "backup-pull: completed"
