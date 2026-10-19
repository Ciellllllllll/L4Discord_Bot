#!/usr/bin/env bash
set -Eeuo pipefail

# ログの切り詰めで日本語の途中を切らないよう、使えるUTF-8ロケールで文字単位に扱う。
for candidate in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8; do
  if locale -a 2>/dev/null | grep -qx "$candidate"; then
    export LC_ALL=$candidate
    break
  fi
done

unit=${1:-}
webhook_url=${DISCORD_ALERT_WEBHOOK_URL:-}
log_lines=15
max_log_length=1500

fail() {
  printf 'failure notification: %s\n' "$1" >&2
  exit 1
}

[[ -n $unit ]] || fail 'unit name is required'
[[ $webhook_url =~ ^https://((canary|ptb)\.)?discord(app)?\.com/api/webhooks/ ]] ||
  fail 'DISCORD_ALERT_WEBHOOK_URL is missing or not a Discord webhook URL'

json_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\t'/\\t}
  value=${value//$'\r'/}
  value=${value//$'\n'/\\n}
  printf '%s' "$value"
}

logs=$(
  { journalctl --unit "$unit" --lines "$log_lines" --no-pager --output cat 2>&1 || true; } |
    tr -d '\000-\010\013-\037\177'
)
logs=${logs//\`\`\`/\'\'\'}
if ((${#logs} > max_log_length)); then
  logs="...${logs: -max_log_length}"
fi

host=$(uname -n)
content=$(printf '**%s** で `%s` が失敗しました。\n```\n%s\n```' "$host" "$unit" "${logs:-ログを取得できませんでした。}")
payload=$(printf '{"content":"%s","allowed_mentions":{"parse":[]}}' "$(json_escape "$content")")

curl --fail --silent --show-error --max-time 15 \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  "$webhook_url" <<<"$payload" >/dev/null

printf 'failure notification: sent for %s\n' "$unit"
