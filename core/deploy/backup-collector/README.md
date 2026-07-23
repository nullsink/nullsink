# Pull-only backup collector

This bundle installs the independent-storage half of the backup boundary on a Debian Raspberry Pi. Its
job is intentionally narrow:

1. production creates a validated, `age`-encrypted database artifact and an aggregate-only JSON report;
2. a dedicated SSH account exposes only those finalized files through read-only `rrsync`;
3. the Pi initiates an hourly pull, validates the pair and report schema, retains it for 90 days, and
   records the last successful check;
4. the private `age` identity stays on a separate trusted machine and is used only for recovery drills or
   a real restore.

The Pi cannot decrypt a database backup. Production cannot initiate a connection to the Pi. The SSH export
account has no app environment, database access, port forwarding, PTY, or general shell.

## Why hourly pulls

Production creates a snapshot every four hours. Pulling hourly costs almost nothing because `rsync` sends
only new files, shortens the usual off-box lag, and gives several automatic retries before the six-hour
freshness limit. A four-hour pull would transfer the same bytes but could miss one run and leave nearly an
eight-hour recovery-point gap.

## Storage

`setup-pi.sh` uses `/srv/nullsink-backups`. The Pi's SD card is acceptable for initial setup, but an
externally powered SSD mounted there is the better durable endpoint: it avoids making the operating-system
card and the independent backup copy one physical failure, and it tolerates repeated writes better. This
bundle does not require Docker; the workload is one `rsync`, one standard-library Python validator, and one
systemd timer.

## Install in four gates

Use the collector files from the same reviewed release on both hosts.

### 1. Install the disabled collector on the Pi

```sh
cd /path/to/deploy/backup-collector
sudo ./setup-pi.sh
```

The script installs dependencies, creates the `nullsink-backup` service account and SSH key, writes a
placeholder config, and prints the new public key. It deliberately does **not** enable the timer.

### 2. Install that public key on production

Copy only the Pi's `id_ed25519.pub` to production, then run:

```sh
sudo /opt/nullsink/deploy/backup-collector/setup-export.sh /path/to/id_ed25519.pub
sudo systemctl start backup.service
sudo systemctl status backup.service --no-pager
```

`setup-export.sh` creates `nullsink-backup-export`, forces its key through
`rrsync -ro /var/lib/nullsink/backups`, and gives only `backup.service` the supplementary group needed to
publish completed files as `0640`. The databases and `/etc/nullsink.env` are not exported.

### 3. Pin the production SSH host key and configure the Pi

Do not silently trust a first-seen host key. On production, display the authoritative fingerprint:

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On the Pi, fetch the candidate key and compare its fingerprint to that production value:

```sh
ssh-keyscan -t ed25519 production.example > /tmp/nullsink-production.known_hosts
ssh-keygen -lf /tmp/nullsink-production.known_hosts
sudo install -o root -g root -m 0644 \
  /tmp/nullsink-production.known_hosts /etc/nullsink-backup/known_hosts
rm /tmp/nullsink-production.known_hosts
sudoedit /etc/nullsink-backup.env
```

Set `BACKUP_SOURCE=nullsink-backup-export@production.example:/`. Leave
`BACKUP_STORE=/srv/nullsink-backups`, `BACKUP_MAX_AGE_HOURS=6`, and `BACKUP_RETENTION_DAYS=90` unless there
is an explicit policy change. An optional dead-man-switch URL catches a dead Pi, timer, or network because
successful pulls stop pinging it.

### 4. Prove one pull before enabling the timer

```sh
sudo systemctl start nullsink-backup-pull.service
sudo systemctl status nullsink-backup-pull.service --no-pager
sudo journalctl -u nullsink-backup-pull.service -n 50 --no-pager
sudo cat /var/lib/nullsink-backup/last-success.json
sudo find /srv/nullsink-backups -maxdepth 1 -type f -printf '%f %s bytes\n' | sort | tail
sudo systemctl enable --now nullsink-backup-pull.timer
systemctl list-timers nullsink-backup-pull.timer --no-pager
```

Success requires a non-empty encrypted artifact, its exact timestamp-matched report, the strict version-1
aggregate schema, and a snapshot no more than six hours old. A missing report, stale snapshot, unexpected
schema field, SSH failure, or heartbeat failure makes the service fail and leaves the previous success
marker unchanged.

## Recovery proof

Periodically proving one retained artifact is different from merely checking that bytes exist. It catches
the practical failures that encryption-at-rest cannot: a lost/wrong identity, a truncated transfer, an
archive/schema incompatibility, or restore code that no longer accepts the retained format.

On the Pi, stage one ciphertext for the logged-in operator (replace the filename with an exact retained
artifact):

```sh
sudo install -o "$USER" -g "$USER" -m 0600 \
  /srv/nullsink-backups/backup-YYYYMMDDTHHMMSSZ.tar.age \
  "$HOME/backup-YYYYMMDDTHHMMSSZ.tar.age"
```

Copy it to the trusted machine, delete the staged Pi copy, and run the reviewed release's dry-run restore:

```sh
BACKUP_AGE_IDENTITY=/secure/nullsink-age.key \
  core/deploy/restore.sh backup-YYYYMMDDTHHMMSSZ.tar.age
```

The successful terminal line is `dry-run OK`. Do not pass `--apply` during a drill. The restore script
automatically deletes its decrypted temporary directory; retain or delete the ciphertext according to
policy. Run this after backup/restore/schema/key changes and at least monthly in normal operation.

## Useful status checks

```sh
systemctl is-enabled nullsink-backup-pull.timer
systemctl is-active nullsink-backup-pull.timer
systemctl list-timers nullsink-backup-pull.timer --no-pager
journalctl -u nullsink-backup-pull.service --since '24 hours ago' --no-pager
cat /var/lib/nullsink-backup/last-success.json
```

`last-success.json` contains timestamps, ages, sizes, and filenames only. It contains no token, payment, or
revenue values.
