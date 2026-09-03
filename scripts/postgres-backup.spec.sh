#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
subject="$repo_root/scripts/postgres-backup.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

make_mock_bin() {
  local bin_dir=$1
  mkdir -p "$bin_dir"

  cat >"$bin_dir/pg_dumpall" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'pg_dumpall\t%s\n' "$*" >>"${MOCK_ARGS_LOG:?}"
printf '%s\n' 'CREATE ROLE l4bot;'
MOCK

  cat >"$bin_dir/pg_dump" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
output=
database=
create_requested=false
args=$*
while (($#)); do
  case "$1" in
    --create)
      create_requested=true
      shift
      ;;
    --file)
      output=$2
      shift 2
      ;;
    --dbname)
      database=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[[ -n "$output" && -n "$database" ]]
[[ $create_requested == true ]]
printf 'pg_dump\t%s\n' "$args" >>"${MOCK_ARGS_LOG:?}"
if [[ ${FAIL_DB:-} == "$database" ]]; then
  exit 23
fi
printf 'dump:%s\n' "$database" >"$output"
MOCK

  cat >"$bin_dir/pg_restore" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
file=${@: -1}
[[ -s "$file" ]]
printf 'archive:%s\n' "$file"
MOCK

  chmod +x "$bin_dir/pg_dumpall" "$bin_dir/pg_dump" "$bin_dir/pg_restore"
}

seed_snapshots() {
  local backup_root=$1
  mkdir -p "$backup_root"
  local day
  for day in $(seq -w 1 31); do
    mkdir "$backup_root/backup-202608${day}T060000+0900"
    printf 'keep\n' >"$backup_root/backup-202608${day}T060000+0900/marker"
  done
  for day in $(seq -w 1 30); do
    mkdir "$backup_root/backup-Z$day"
  done
  mkdir "$backup_root/do-not-delete"
}

count_valid_snapshots() {
  local backup_root=$1
  local count=0 name
  while IFS= read -r name; do
    if [[ $name =~ ^backup-[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]]; then
      ((count += 1))
    fi
  done < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')
  printf '%s\n' "$count"
}

run_success_case() {
  local case_root="$test_root/success"
  local backup_root="$case_root/backups"
  local mock_bin="$case_root/bin"
  make_mock_bin "$mock_bin"
  seed_snapshots "$backup_root"

  BACKUP_ROOT="$backup_root" \
  BACKUP_TIMESTAMP=20260901T060000+0900 \
  PG_BIN="$mock_bin" \
  PGHOST=127.0.0.1 \
  PGPORT=6543 \
  PGUSER=backupuser \
  MOCK_ARGS_LOG="$case_root/args.log" \
    bash "$subject"

  local snapshot="$backup_root/backup-20260901T060000+0900"
  [[ -s "$snapshot/globals.sql" ]] || fail 'globals.sql was not published'
  [[ -s "$snapshot/l4discord.dump" ]] || fail 'l4discord dump was not published'
  [[ -s "$snapshot/kendou_ranking.dump" ]] || fail 'kendou_ranking dump was not published'
  [[ -s "$snapshot/SHA256SUMS" ]] || fail 'checksum manifest was not published'
  grep -Fq $'pg_dumpall\t--host=127.0.0.1 --port=6543 --username=backupuser --globals-only' "$case_root/args.log" ||
    fail 'pg_dumpall connection settings were not forwarded'
  grep -Fq $'pg_dump\t--host=127.0.0.1 --port=6543 --username=backupuser --dbname l4discord --create --format=custom --file' "$case_root/args.log" ||
    fail 'pg_dump connection settings were not forwarded'
  [[ -d "$backup_root/do-not-delete" ]] || fail 'unrelated directory was deleted'
  [[ ! -e "$backup_root/backup-20260801T060000+0900" ]] || fail 'oldest snapshot was retained'
  [[ ! -e "$backup_root/backup-20260802T060000+0900" ]] || fail 'second oldest snapshot was retained'
  [[ -d "$backup_root/backup-Z01" ]] || fail 'invalid backup-like directory was deleted'

  local count
  count=$(count_valid_snapshots "$backup_root")
  [[ $count -eq 30 ]] || fail "expected 30 snapshots, found $count"
}

run_failure_case() {
  local case_root="$test_root/failure"
  local backup_root="$case_root/backups"
  local mock_bin="$case_root/bin"
  make_mock_bin "$mock_bin"
  seed_snapshots "$backup_root"

  if BACKUP_ROOT="$backup_root" \
    BACKUP_TIMESTAMP=20260901T060000+0900 \
    PG_BIN="$mock_bin" \
    PGHOST=127.0.0.1 \
    PGPORT=6543 \
    PGUSER=backupuser \
    MOCK_ARGS_LOG="$case_root/args.log" \
    FAIL_DB=kendou_ranking \
      bash "$subject"; then
    fail 'backup unexpectedly succeeded'
  fi

  local count
  count=$(count_valid_snapshots "$backup_root")
  [[ $count -eq 31 ]] || fail "failed backup changed retention count to $count"
  [[ ! -e "$backup_root/backup-20260901T060000+0900" ]] || fail 'failed snapshot was published'
  [[ -d "$backup_root/do-not-delete" ]] || fail 'failed backup deleted unrelated data'
  if find "$backup_root" -mindepth 1 -maxdepth 1 -name '.partial-*' | grep -q .; then
    fail 'partial backup was not cleaned up'
  fi
}

run_success_case
run_failure_case
printf 'postgres backup tests passed\n'
