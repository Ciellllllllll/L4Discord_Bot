#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

app_dir=${APP_DIR:-/opt/L4_DiscordBot}
backup_root=${BACKUP_ROOT:-/opt/backups/l4-discordbot}
container=${BOT_CONTAINER:-}
compose_project=${BOT_COMPOSE_PROJECT:-l4discord}
compose_service=${BOT_COMPOSE_SERVICE:-bot}
# 曜日がホストのタイムゾーン設定で変わらないよう、日付は運用上の基準時刻で決める。
backup_tz=${BACKUP_TZ:-Asia/Tokyo}
timestamp=${BACKUP_TIMESTAMP:-$(TZ=$backup_tz date '+%Y%m%d-%H%M%S')}
weekday=${BACKUP_WEEKDAY:-$(TZ=$backup_tz date '+%u')}
mode=${1:-auto}
full_weekday=7
text_retention_count=7
full_retention_count=2
partial_file=
restart_container=false

fail() {
  printf 'app data backup: %s\n' "$1" >&2
  exit 1
}

[[ $timestamp =~ ^[0-9]{8}-[0-9]{6}$ ]] || fail 'invalid timestamp'
[[ $weekday =~ ^[1-7]$ ]] || fail 'invalid weekday'
[[ -d $backup_root && ! -L $backup_root ]] || fail "backup root is missing or unsafe: $backup_root"
[[ -f $app_dir/.env && -d $app_dir/data ]] || fail "application files are missing: $app_dir"

backup_root=$(realpath -e -- "$backup_root")
[[ $backup_root != / ]] || fail 'backup root must not be /'

# timerと手動実行が重なってBotの停止と起動が入れ違わないよう、同時に1つだけ実行する。
exec 9>"$backup_root/.lock"
flock --nonblock 9 || fail 'another backup is running'

# 添付ファイルは容量が大きいため、全体の保存は週1回に限り、それ以外の日はテキストだけを保存する。
case "$mode" in
  auto)
    if [[ $weekday == "$full_weekday" ]]; then mode=full; else mode=text; fi
    ;;
  full | text) ;;
  *)
    fail "unknown mode: $mode"
    ;;
esac

# コンテナ名はホストごとに変わり得るため、Composeのプロジェクト名とサービス名から探す。
if [[ -z $container ]]; then
  mapfile -t container_ids < <(
    docker ps --all --quiet \
      --filter "label=com.docker.compose.project=$compose_project" \
      --filter "label=com.docker.compose.service=$compose_service"
  )
  ((${#container_ids[@]} == 1)) ||
    fail "expected one container for $compose_project/$compose_service, found ${#container_ids[@]}"
  container=${container_ids[0]}
fi

tar_args=()
if [[ $mode == text ]]; then
  tar_args+=(--exclude='*/message_log_attachments')
fi

finish() {
  if [[ -n $partial_file && -f $partial_file ]]; then
    rm -f -- "$partial_file"
  fi
  if [[ $restart_container == true ]]; then
    docker start "$container" >/dev/null ||
      printf 'app data backup: failed to restart container: %s\n' "$container" >&2
  fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

final_file="$backup_root/backup-$mode-$timestamp.tar.gz"
[[ ! -e $final_file ]] || fail "backup already exists: $final_file"
partial_file=$(mktemp "$backup_root/.partial-$mode-$timestamp-XXXXXX")

# 書き込み途中のファイルを保存しないよう、起動中のBotだけを止めて保存後に起動し直す。
if [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]]; then
  restart_container=true
  docker stop "$container" >/dev/null
fi

tar -czf "$partial_file" "${tar_args[@]}" -C "$app_dir" .env data
gzip -t -- "$partial_file"

if [[ $restart_container == true ]]; then
  docker start "$container" >/dev/null
  restart_container=false
fi

mv -- "$partial_file" "$final_file"
partial_file=

remove_old_backups() {
  local kind=$1
  local keep=$2
  local name
  local -a backups

  mapfile -t backups < <(
    find "$backup_root" -mindepth 1 -maxdepth 1 -type f -name "backup-$kind-*.tar.gz" -printf '%f\n' |
      grep -E "^backup-$kind-[0-9]{8}-[0-9]{6}\.tar\.gz$" |
      sort -r || true
  )
  for name in "${backups[@]:$keep}"; do
    rm -f -- "$backup_root/$name"
  done
}

remove_old_backups text "$text_retention_count"
remove_old_backups full "$full_retention_count"

printf 'app data backup: created %s\n' "$final_file"
