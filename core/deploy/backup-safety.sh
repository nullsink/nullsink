#!/usr/bin/env bash
# Sourceable backup invariants. backup.sh calls these exact helpers; tests replace sqlite3 with a recorder so
# snapshot order and the encrypted-only off-box boundary stay deterministic and independent of live services.

backup_require_table() { # $1=DB path, $2=required table, $3=context
  local db="$1" table="$2" context="$3" present
  [ -f "$db" ] || {
    echo "backup: refusing $context — $(basename "$db") is missing (SQLite would create an empty source)" >&2
    return 1
  }
  if ! present="$(sqlite3 "$db" \
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$table';" 2>/dev/null)" ||
     [ "$present" != 1 ]; then
    echo "backup: refusing $context — required table '$table' is missing or unreadable in $(basename "$db")" >&2
    return 1
  fi
}

backup_snapshot_databases() { # $1=live DB dir, $2=snapshot work dir; sets global `files`
  local db_dir="$1" work_dir="$2"
  files=()
  # Current installations always run the payments service, which creates pending.db. Treat its absence as
  # ledger loss, not as a supported rail-less mode: a balances-only "successful" backup would silently omit
  # open orders, the paid-credit outbox, and the sales journal.
  backup_require_table "$db_dir/pending.db" pending_orders "pending-ledger snapshot" || return 1
  sqlite3 -cmd '.timeout 10000' "$db_dir/pending.db" ".backup '$work_dir/pending.db'" || return 1
  backup_require_table "$work_dir/pending.db" pending_orders "pending-ledger snapshot output" || return 1
  files+=(pending.db)
  backup_require_table "$db_dir/balances.db" tokens "balance-ledger snapshot" || return 1
  sqlite3 -cmd '.timeout 10000' "$db_dir/balances.db" ".backup '$work_dir/balances.db'" || return 1
  backup_require_table "$work_dir/balances.db" tokens "balance-ledger snapshot output" || return 1
  files+=(balances.db)
}

backup_validate_candidate() { # $1=hidden candidate, $2=tar|age
  local candidate="$1" format="$2" first_line
  [ -f "$candidate" ] && [ ! -L "$candidate" ] && [ -s "$candidate" ] || {
    echo "backup: refusing to publish an empty or unsafe candidate" >&2
    return 1
  }
  case "$format" in
    tar)
      tar -tf "$candidate" >/dev/null 2>&1 || {
        echo "backup: refusing to publish an invalid tar artifact" >&2
        return 1
      } ;;
    age)
      # The private identity is deliberately not on the box, so the producer's successful exit plus the
      # age-v1 envelope marker is the strongest local validation available after encryption.
      IFS= read -r first_line < "$candidate" || true
      [ "$first_line" = age-encryption.org/v1 ] || {
        echo "backup: refusing to publish an invalid age artifact" >&2
        return 1
      } ;;
    *)
      echo "backup: unknown candidate format '$format'" >&2
      return 2 ;;
  esac
}

backup_publish_candidate() { # $1=hidden same-directory candidate, $2=final artifact, $3=tar|age
  local candidate="$1" final="$2" format="$3" candidate_dir final_dir
  candidate_dir="$(dirname "$candidate")"
  final_dir="$(dirname "$final")"
  [ "$candidate_dir" = "$final_dir" ] || {
    echo "backup: candidate and final artifact must be on the same filesystem directory" >&2
    return 1
  }
  [ -d "$final_dir" ] && [ ! -e "$final" ] && [ ! -L "$final" ] || {
    echo "backup: unsafe artifact destination: $final" >&2
    return 1
  }
  backup_validate_candidate "$candidate" "$format" || return 1
  chmod 600 "$candidate" || return 1

  # Production's GNU `sync -f PATH` flushes the filesystem containing PATH. Make the complete bytes durable
  # before the atomic rename exposes a retention/freshness-visible backup-* name, then flush again so the
  # rename itself survives power loss. A crash can leave only the dot-prefixed candidate, never a partial final.
  sync -f "$candidate" || return 1
  mv -- "$candidate" "$final" || return 1
  sync -f "$final_dir" || return 1
}

backup_push_artifact() { # $1=artifact path, $2=operator push command
  local artifact="$1" push_cmd="$2"
  [ -n "$push_cmd" ] || return 0
  case "$artifact" in
    *.tar.age) ;;
    *)
      echo "refusing to push an UNENCRYPTED artifact off-box — set BACKUP_AGE_RECIPIENT" >&2
      return 1 ;;
  esac
  echo "push: shipping $(basename "$artifact") off-box"
  ARTIFACT="$artifact" bash -c "$push_cmd"
}
