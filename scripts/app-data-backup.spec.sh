#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
subject="$repo_root/scripts/app-data-backup.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
real_tar=$(command -v tar)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

make_mock_bin() {
  local bin_dir=$1
  mkdir -p "$bin_dir"

  cat >"$bin_dir/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${MOCK_DOCKER_LOG:?}"
case "$1" in
  ps) printf '%s' "${MOCK_CONTAINER_IDS-test-bot$'\n'}" ;;
  inspect) printf '%s\n' "${MOCK_RUNNING:-true}" ;;
  stop | start) printf '%s\n' "${@: -1}" ;;
  *) exit 64 ;;
esac
MOCK

  cat >"$bin_dir/tar" <<MOCK
#!/usr/bin/env bash
set -euo pipefail
if [[ \${FAIL_TAR:-} == 1 ]]; then
  exit 2
fi
exec "$real_tar" "\$@"
MOCK

  chmod +x "$bin_dir/docker" "$bin_dir/tar"
}

make_app_dir() {
  local app_dir=$1
  mkdir -p "$app_dir/data/production/message_log_attachments/1" \
    "$app_dir/data/message_log_attachments/1" \
    "$app_dir/data/production/server/json"
  printf 'DISCORD_TOKEN=test\n' >"$app_dir/.env"
  printf '{}\n' >"$app_dir/data/production/server/json/counts.json"
  printf 'binary\n' >"$app_dir/data/production/message_log_attachments/1/image.png"
  printf 'binary\n' >"$app_dir/data/message_log_attachments/1/legacy.png"
}

run_backup() {
  local case_root=$1
  shift
  env \
    PATH="$case_root/bin:$PATH" \
    APP_DIR="$case_root/app" \
    BACKUP_ROOT="$case_root/backups" \
    MOCK_DOCKER_LOG="$case_root/docker.log" \
    "$@" \
    bash "$subject" "${MODE_ARG[@]}"
}

setup_case() {
  local case_root="$test_root/$1"
  make_mock_bin "$case_root/bin"
  make_app_dir "$case_root/app"
  mkdir -p "$case_root/backups"
  : >"$case_root/docker.log"
  printf '%s\n' "$case_root"
}

archive_has() {
  "$real_tar" -tzf "$1" | grep -Fq "$2"
}

run_text_case() {
  local case_root
  case_root=$(setup_case text)
  MODE_ARG=()
  run_backup "$case_root" BACKUP_TIMESTAMP=20261020-040000 BACKUP_WEEKDAY=2 >/dev/null

  local archive="$case_root/backups/backup-text-20261020-040000.tar.gz"
  [[ -s $archive ]] || fail 'text backup was not published'
  archive_has "$archive" './.env' || archive_has "$archive" '.env' || fail '.env was not saved'
  archive_has "$archive" 'data/production/server/json/counts.json' || fail 'text data was not saved'
  if archive_has "$archive" 'message_log_attachments'; then
    fail 'attachments were saved in a text backup'
  fi
  grep -Fqx 'ps --all --quiet --filter label=com.docker.compose.project=l4discord --filter label=com.docker.compose.service=bot' \
    "$case_root/docker.log" || fail 'bot container was not looked up by Compose labels'
  grep -qx 'stop test-bot' "$case_root/docker.log" || fail 'running bot was not stopped'
  grep -qx 'start test-bot' "$case_root/docker.log" || fail 'bot was not restarted'
  [[ $(stat -c '%a' "$archive") == 600 ]] || [[ $OSTYPE == cygwin || $OSTYPE == msys ]] ||
    fail 'backup is readable by other users'
}

run_full_case() {
  local case_root
  case_root=$(setup_case full)
  MODE_ARG=()
  run_backup "$case_root" BACKUP_TIMESTAMP=20261025-040000 BACKUP_WEEKDAY=7 >/dev/null

  local archive="$case_root/backups/backup-full-20261025-040000.tar.gz"
  [[ -s $archive ]] || fail 'full backup was not published on Sunday'
  archive_has "$archive" 'data/production/message_log_attachments/1/image.png' ||
    fail 'attachments were not saved in a full backup'
  archive_has "$archive" 'data/message_log_attachments/1/legacy.png' ||
    fail 'legacy attachments were not saved in a full backup'
}

run_manual_mode_case() {
  local case_root
  case_root=$(setup_case manual)
  MODE_ARG=(full)
  run_backup "$case_root" BACKUP_TIMESTAMP=20261020-120000 BACKUP_WEEKDAY=2 >/dev/null
  [[ -s "$case_root/backups/backup-full-20261020-120000.tar.gz" ]] || fail 'manual full mode was ignored'

  MODE_ARG=(weekly)
  if run_backup "$case_root" BACKUP_TIMESTAMP=20261020-130000 BACKUP_WEEKDAY=2 2>/dev/null; then
    fail 'unknown mode was accepted'
  fi
}

run_stopped_bot_case() {
  local case_root
  case_root=$(setup_case stopped)
  MODE_ARG=()
  run_backup "$case_root" BACKUP_TIMESTAMP=20261020-040000 BACKUP_WEEKDAY=2 MOCK_RUNNING=false >/dev/null
  if grep -Eq '^(stop|start) ' "$case_root/docker.log"; then
    fail 'stopped bot was started by the backup'
  fi
}

run_container_lookup_case() {
  local case_root
  case_root=$(setup_case lookup)
  MODE_ARG=()
  run_backup "$case_root" BACKUP_TIMESTAMP=20261020-040000 BACKUP_WEEKDAY=2 \
    BOT_CONTAINER=explicit-bot MOCK_CONTAINER_IDS= >/dev/null
  grep -qx 'stop explicit-bot' "$case_root/docker.log" || fail 'BOT_CONTAINER was ignored'
  if grep -q '^ps ' "$case_root/docker.log"; then
    fail 'container was looked up although BOT_CONTAINER was set'
  fi

  if run_backup "$case_root" BACKUP_TIMESTAMP=20261020-050000 BACKUP_WEEKDAY=2 \
    MOCK_CONTAINER_IDS= 2>/dev/null; then
    fail 'backup succeeded without a bot container'
  fi
  if run_backup "$case_root" BACKUP_TIMESTAMP=20261020-060000 BACKUP_WEEKDAY=2 \
    MOCK_CONTAINER_IDS=$'bot-a\nbot-b\n' 2>/dev/null; then
    fail 'backup succeeded with multiple bot containers'
  fi
}

run_retention_case() {
  local case_root
  case_root=$(setup_case retention)
  local backups="$case_root/backups" day
  for day in $(seq -f '%02g' 1 9); do
    printf 'old\n' >"$backups/backup-text-202610${day}-040000.tar.gz"
  done
  for day in 04 11 18; do
    printf 'old\n' >"$backups/backup-full-202610${day}-040000.tar.gz"
  done
  printf 'keep\n' >"$backups/backup-20261001-040000.tar.gz"
  printf 'keep\n' >"$backups/backup-text-latest.tar.gz"

  MODE_ARG=()
  run_backup "$case_root" BACKUP_TIMESTAMP=20261025-040000 BACKUP_WEEKDAY=7 >/dev/null

  local text_count full_count
  text_count=$(find "$backups" -name 'backup-text-2026*' | wc -l)
  full_count=$(find "$backups" -name 'backup-full-2026*' | wc -l)
  [[ $text_count -eq 7 ]] || fail "expected 7 text backups, found $text_count"
  [[ $full_count -eq 2 ]] || fail "expected 2 full backups, found $full_count"
  [[ ! -e "$backups/backup-text-20261002-040000.tar.gz" ]] || fail 'old text backup was retained'
  [[ -e "$backups/backup-text-20261003-040000.tar.gz" ]] || fail 'recent text backup was deleted'
  [[ -e "$backups/backup-full-20261018-040000.tar.gz" ]] || fail 'previous full backup was deleted'
  [[ ! -e "$backups/backup-full-20261011-040000.tar.gz" ]] || fail 'old full backup was retained'
  [[ -e "$backups/backup-20261001-040000.tar.gz" ]] || fail 'unmanaged backup was deleted'
  [[ -e "$backups/backup-text-latest.tar.gz" ]] || fail 'invalid backup-like file was deleted'
}

run_lock_case() {
  local case_root
  case_root=$(setup_case lock)
  MODE_ARG=()
  if (
    exec 9>"$case_root/backups/.lock"
    flock 9
    run_backup "$case_root" BACKUP_TIMESTAMP=20261020-040000 BACKUP_WEEKDAY=2 2>/dev/null
  ); then
    fail 'backup ran while another backup held the lock'
  fi
  if grep -Eq '^(stop|start) ' "$case_root/docker.log"; then
    fail 'concurrent backup touched the bot container'
  fi
}

run_failure_case() {
  local case_root
  case_root=$(setup_case failure)
  printf 'old\n' >"$case_root/backups/backup-text-20261001-040000.tar.gz"
  MODE_ARG=()
  if run_backup "$case_root" BACKUP_TIMESTAMP=20261020-040000 BACKUP_WEEKDAY=2 FAIL_TAR=1 2>/dev/null; then
    fail 'backup unexpectedly succeeded'
  fi

  grep -qx 'start test-bot' "$case_root/docker.log" || fail 'bot was not restarted after a failure'
  [[ ! -e "$case_root/backups/backup-text-20261020-040000.tar.gz" ]] || fail 'failed backup was published'
  [[ -e "$case_root/backups/backup-text-20261001-040000.tar.gz" ]] || fail 'failed backup removed old backups'
  if find "$case_root/backups" -name '.partial-*' | grep -q .; then
    fail 'partial backup was not cleaned up'
  fi
}

run_text_case
run_full_case
run_manual_mode_case
run_stopped_bot_case
run_container_lookup_case
run_retention_case
run_lock_case
run_failure_case
printf 'app data backup tests passed\n'
