#!/usr/bin/env bash
# Sourceable restore safety boundaries. Keeping these free of root/systemd lets the exact production helpers
# run in contract tests rather than leaving money-safety behavior hidden inside an untestable apply script.

restore_require_matched_pair() { # $1=extracted artifact dir, $2=live DB dir
  local extracted_dir="$1" live_dir="$2"
  if [ ! -f "$extracted_dir/pending.db" ] && [ -f "$live_dir/pending.db" ]; then
    echo "refusing a balances-only artifact while live pending.db exists — restore a matched DB pair" >&2
    return 1
  fi
}

# Parse `systemctl cat` output in fragment order and require one effective, non-triggered negative path
# condition. systemd list-valued Condition*= directives accumulate across the base unit + drop-ins, but an
# empty assignment to ANY Condition*= directive resets the entire condition list. A grep for the original
# base-unit line therefore gives a false assurance when a later drop-in clears it.
restore_has_effective_negative_path_condition() { # $1=absolute marker path; ordered unit text on stdin
  local marker="$1"
  awk -v expected="!$marker" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    BEGIN { section = ""; guarded = 0 }
    {
      line = $0
      sub(/\r$/, "", line)
      line = trim(line)
      if (line ~ /^\[[^]]+\]$/) {
        section = line
        next
      }
      if (section != "[Unit]" || line == "" || line ~ /^[#;]/) next
      equals = index(line, "=")
      if (equals == 0) next
      key = trim(substr(line, 1, equals - 1))
      value = trim(substr(line, equals + 1))
      if (key !~ /^Condition[A-Za-z0-9]+$/) next
      if (value == "") {
        guarded = 0
        next
      }
      # Reject trigger form (`|!...`): a separate true trigger could let the unit start while this marker
      # exists. An ordinary `!path` condition always participates in the required AND set.
      if (key == "ConditionPathExists" && value == expected) guarded = 1
    }
    END { exit(guarded ? 0 : 1) }
  '
}

restore_require_recovery_slots() { # $1=live DB dir, $2=1 only when durable restore guard already existed
  local db_dir="$1" resuming="$2" db slot
  [ "$resuming" = 1 ] && return 0
  for db in balances.db pending.db; do
    for slot in "$db_dir/$db.prerestore" "$db_dir/$db.prerestore-unreadable.tar"; do
      if [ -e "$slot" ]; then
        echo "refusing a new restore while $(basename "$slot") still exists — verify/remove the prior restore's safety material first" >&2
        return 1
      fi
    done
  done
}

# SQL used after a restore to re-arm only recoverable, legacy acknowledgements absent from the restored
# balance ledger. Current tombstones have no payload and must remain acked. The caller chooses how sqlite3 is
# invoked (restore.sh uses the service user; tests use an isolated temporary DB).
restore_legacy_rearm_sql() { # $1=balances.db path
  local balances="$1"
  printf '%s\n' \
    "ATTACH '$balances' AS bal;" \
    "UPDATE credit_outbox SET acked_at = NULL" \
    " WHERE acked_at IS NOT NULL" \
    "   AND hash <> ''" \
    "   AND NOT EXISTS (" \
    "     SELECT 1 FROM bal.applied_orders AS applied" \
    "      WHERE applied.order_id = credit_outbox.idempotency_key" \
    "   );" \
    "SELECT changes();"
}

restore_probe_table() { # $1=sqlite runner command/function, $2=DB path, $3=table name; prints 0 or 1
  local runner="$1" db="$2" table="$3" out
  if ! out="$("$runner" "$db" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$table';" 2>&1)"; then
    echo "!! restore schema probe FAILED for $(basename "$db")/$table: $out" >&2
    return 1
  fi
  case "$out" in
    0|1) printf '%s\n' "$out" ;;
    *)
      echo "!! restore schema probe returned an invalid result for $(basename "$db")/$table: ${out:-empty}" >&2
      return 1 ;;
  esac
}

restore_require_table() { # $1=sqlite runner, $2=DB path, $3=required table, $4=context
  local runner="$1" db="$2" table="$3" context="$4" present
  if ! present="$(restore_probe_table "$runner" "$db" "$table")" || [ "$present" != 1 ]; then
    echo "!! $context is not a nullsink ledger: required table '$table' is missing or unreadable" >&2
    return 1
  fi
}

restore_preserve_sqlite() { # $1=sqlite runner, $2=live DB, $3=standalone recovery DB
  local runner="$1" live="$2" previous="$3" tmp="$3.new" result
  rm -f "$tmp" || return 1
  # SQLite .backup includes committed WAL frames. Copying/moving only the main file can silently omit the
  # newest money state even after the writer process has stopped, because close does not promise a checkpoint.
  "$runner" "$live" ".backup '$tmp'" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  if ! result="$("$runner" "$tmp" 'PRAGMA integrity_check;' 2>&1)" || [ "$result" != ok ]; then
    echo "!! pre-restore recovery snapshot failed integrity_check for $(basename "$live")" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$previous" || return 1
  chmod 600 "$previous" || return 1
  sync -f "$(dirname "$previous")" || return 1
}

restore_archive_unreadable_db() { # $1=live DB, $2=owner-only raw archive used as the recovery sentinel
  local live="$1" archive="$2" dir base tmp candidate
  local -a files
  dir="$(dirname "$live")"
  base="$(basename "$live")"
  tmp="$archive.new"
  files=("$base")
  [ -f "$live" ] && [ ! -L "$live" ] || {
    echo "!! refusing to archive unsafe live ledger path: $live" >&2
    return 1
  }
  for candidate in "$live-wal" "$live-shm"; do
    if [ -e "$candidate" ]; then
      [ -f "$candidate" ] && [ ! -L "$candidate" ] || {
        echo "!! refusing to archive unsafe SQLite sidecar: $candidate" >&2
        return 1
      }
      files+=("$(basename "$candidate")")
    fi
  done
  rm -f "$tmp" || return 1
  # The app is quiesced before this path is reachable. Preserve the exact main/WAL/SHM bytes for forensic
  # recovery when SQLite cannot make a logical .backup; this is deliberately not described as a usable DB.
  ( umask 077; tar -C "$dir" -cf "$tmp" "${files[@]}" ) || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  sync -f "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$archive" || { rm -f "$tmp"; return 1; }
  chmod 600 "$archive" || return 1
  sync -f "$dir" || return 1
}

restore_guard_path() { # $1=DB dir
  printf '%s/.restore-in-progress\n' "$1"
}

restore_pair_identity() { # $1=verified extracted pair; print stable digest binding an interrupted restore
  local extracted="$1"
  local -a files=(balances.db)
  [ -f "$extracted/pending.db" ] && files+=(pending.db)
  (
    cd "$extracted" || exit 1
    sha256sum "${files[@]}" | sha256sum | awk '{ print $1 }'
  )
}

restore_guard_matches() { # $1=DB dir, $2=verified pair identity
  local marker expected actual
  marker="$(restore_guard_path "$1")"
  expected="restore-v2 $2"
  [ -f "$marker" ] && [ ! -L "$marker" ] || {
    echo "!! unsafe or missing restore guard: $marker" >&2
    return 1
  }
  IFS= read -r actual < "$marker" || true
  [ "$actual" = "$expected" ] || {
    echo "!! interrupted restore belongs to a different/unknown backup pair" >&2
    echo "!! rerun the exact same artifact; do not combine recovery slots from separate backups" >&2
    return 1
  }
}

restore_arm_guard() { # $1=DB dir, $2=pair identity; both app units refuse start while marker exists
  local db_dir="$1" identity="$2" marker tmp
  marker="$(restore_guard_path "$db_dir")"
  [ -d "$db_dir" ] && [ ! -L "$db_dir" ] || return 1
  tmp="$marker.new.$$"
  ( umask 077; printf 'restore-v2 %s\n' "$identity" > "$tmp" ) || return 1
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  sync -f "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$marker" || { rm -f "$tmp"; return 1; }
  sync -f "$db_dir" || return 1
}

restore_disarm_guard() { # $1=DB dir; call only after the restored pair + outbox reconciliation validate
  local db_dir="$1"
  rm -f "$(restore_guard_path "$db_dir")" || return 1
  sync -f "$db_dir" || return 1
}

restore_swap_db() { # $1=db dir, $2=filename, $3=preserve callback; expects .$2.restoring
  local db_dir="$1" db="$2" preserve="$3"
  local live="$db_dir/$db" staged="$db_dir/.$db.restoring" previous="$db_dir/$db.prerestore"
  local unreadable="$db_dir/$db.prerestore-unreadable.tar"

  if [ -e "$live" ]; then
    # Keep the FIRST original across retries. The callback must make a standalone SQLite backup (including
    # committed WAL frames), or—only through the explicit break-glass path—create the raw unreadable archive.
    # Either artifact is also a sentinel preventing a retry from preserving the newly restored DB as if it
    # were the original.
    if [ ! -e "$previous" ] && [ ! -e "$unreadable" ]; then
      "$preserve" "$live" "$previous" || return 1
      [ -e "$previous" ] || [ -e "$unreadable" ] || {
        echo "!! preservation callback returned success without recovery material for $db" >&2
        return 1
      }
    fi
  fi
  # staged lives beside live, so rename is atomic. If it fails, the old live file and standalone recovery
  # copy both remain. Sidecars are removed only after the new main DB is in place; the durable restore guard
  # keeps either service from opening this transition state after a reboot.
  mv -f "$staged" "$live" || return 1
  rm -f "$live-wal" "$live-shm" || return 1
  sync -f "$db_dir" || return 1
}
