#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

backup_root=${BACKUP_ROOT:-/var/backups/postgresql/l4}
pg_bin=${PG_BIN:-/usr/lib/postgresql/16/bin}
pg_host=${PGHOST:-/var/run/postgresql}
pg_port=${PGPORT:-5432}
pg_user=${PGUSER:-postgres}
timestamp=${BACKUP_TIMESTAMP:-$(date '+%Y%m%dT%H%M%S%z')}
retention_count=30
databases=(l4discord kendou_ranking)
partial_dir=

fail() {
  printf 'postgres backup: %s\n' "$1" >&2
  exit 1
}

[[ $timestamp =~ ^[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]] || fail 'invalid timestamp'
[[ -d $backup_root && ! -L $backup_root ]] || fail "backup root is missing or unsafe: $backup_root"
[[ -d $pg_bin ]] || fail "PostgreSQL 16 tools are missing: $pg_bin"

backup_root=$(realpath -e -- "$backup_root")
[[ $backup_root != / ]] || fail 'backup root must not be /'

for command_name in pg_dumpall pg_dump pg_restore; do
  [[ -x "$pg_bin/$command_name" ]] || fail "missing executable: $pg_bin/$command_name"
done
command -v sha256sum >/dev/null || fail 'sha256sum is required'

remove_managed_directory() {
  local candidate=$1
  local expected_kind=$2
  local resolved name

  [[ -d $candidate && ! -L $candidate ]] || return 1
  resolved=$(realpath -e -- "$candidate") || return 1
  [[ $(dirname -- "$resolved") == "$backup_root" ]] || return 1
  name=$(basename -- "$resolved")

  case "$expected_kind" in
    backup)
      [[ $name =~ ^backup-[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]] || return 1
      ;;
    partial)
      [[ $name =~ ^\.partial-[0-9]{8}T[0-9]{6}[+-][0-9]{4}-[A-Za-z0-9]+$ ]] || return 1
      ;;
    *)
      return 1
      ;;
  esac

  rm -rf --one-file-system -- "$resolved"
}

cleanup_partial() {
  if [[ -n $partial_dir && -d $partial_dir ]]; then
    remove_managed_directory "$partial_dir" partial ||
      printf 'postgres backup: refused to remove partial directory: %s\n' "$partial_dir" >&2
  fi
}
trap cleanup_partial EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

final_dir="$backup_root/backup-$timestamp"
[[ ! -e $final_dir ]] || fail "snapshot already exists: $final_dir"
partial_dir=$(mktemp -d "$backup_root/.partial-$timestamp-XXXXXX")

"$pg_bin/pg_dumpall" \
  --host="$pg_host" \
  --port="$pg_port" \
  --username="$pg_user" \
  --globals-only >"$partial_dir/globals.sql"
[[ -s "$partial_dir/globals.sql" ]] || fail 'globals dump is empty'

for database in "${databases[@]}"; do
  dump_file="$partial_dir/$database.dump"
  "$pg_bin/pg_dump" \
    --host="$pg_host" \
    --port="$pg_port" \
    --username="$pg_user" \
    --dbname "$database" \
    --create \
    --format=custom \
    --file "$dump_file"
  [[ -s $dump_file ]] || fail "database dump is empty: $database"
  "$pg_bin/pg_restore" --list "$dump_file" >/dev/null
done

(
  cd "$partial_dir"
  sha256sum globals.sql l4discord.dump kendou_ranking.dump >SHA256SUMS
)

mv -- "$partial_dir" "$final_dir"
partial_dir=

mapfile -t snapshots < <(
  while IFS= read -r snapshot_name; do
    if [[ $snapshot_name =~ ^backup-[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]]; then
      printf '%s\n' "$snapshot_name"
    fi
  done < <(
    find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -printf '%f\n'
  ) | sort -r
)

retention_warning=false
for snapshot_name in "${snapshots[@]:$retention_count}"; do
  if ! remove_managed_directory "$backup_root/$snapshot_name" backup; then
    printf 'postgres backup: warning: could not remove old snapshot: %s\n' "$snapshot_name" >&2
    retention_warning=true
  fi
done

printf 'postgres backup: created %s\n' "$final_dir"
if [[ $retention_warning == true ]]; then
  printf 'postgres backup: warning: retention cleanup needs attention\n' >&2
fi
