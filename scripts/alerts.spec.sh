#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
disk_check="$repo_root/scripts/disk-usage-check.sh"
notify="$repo_root/scripts/notify-failure.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
mock_bin="$test_root/bin"
webhook=https://discord.com/api/webhooks/1/test-token

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$mock_bin"

cat >"$mock_bin/df" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == -P ]]
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/vda1 100 %s %s %s%% /\n' "${MOCK_USAGE:?}" "$((100 - MOCK_USAGE))" "$MOCK_USAGE"
MOCK

cat >"$mock_bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"${MOCK_JOURNAL_ARGS:?}"
printf '%s' "${MOCK_JOURNAL:-}"
MOCK

cat >"$mock_bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${@: -1}" >"${MOCK_CURL_URL:?}"
cat >"${MOCK_CURL_BODY:?}"
exit "${MOCK_CURL_STATUS:-0}"
MOCK

cat >"$mock_bin/uname" <<'MOCK'
#!/usr/bin/env bash
printf 'test-host\n'
MOCK

chmod +x "$mock_bin"/*

run_disk_check() {
  env PATH="$mock_bin:$PATH" "$@" bash "$disk_check"
}

run_notify() {
  env PATH="$mock_bin:$PATH" \
    MOCK_JOURNAL_ARGS="$test_root/journal.args" \
    MOCK_CURL_URL="$test_root/curl.url" \
    MOCK_CURL_BODY="$test_root/curl.body" \
    "$@" bash "$notify" l4-app-data-backup.service
}

run_disk_check_cases() {
  run_disk_check MOCK_USAGE=79 >/dev/null || fail 'usage below the threshold failed'
  if run_disk_check MOCK_USAGE=80 2>/dev/null; then
    fail 'usage at the threshold passed'
  fi
  run_disk_check MOCK_USAGE=90 DISK_USAGE_THRESHOLD=95 >/dev/null || fail 'custom threshold was ignored'
  if run_disk_check MOCK_USAGE=85 DISK_USAGE_THRESHOLD=080 2>/dev/null; then
    fail 'zero-padded threshold was not read as decimal'
  fi
  if run_disk_check MOCK_USAGE=10 DISK_USAGE_THRESHOLD=abc 2>/dev/null; then
    fail 'invalid threshold was accepted'
  fi
}

run_notify_success_case() {
  rm -f "$test_root"/curl.*
  run_notify DISCORD_ALERT_WEBHOOK_URL="$webhook" \
    MOCK_JOURNAL=$'tar: "data" failed\\path\n```\x1b[31mred\x1b[0m\n' >/dev/null

  [[ $(<"$test_root/curl.url") == "$webhook" ]] || fail 'webhook URL was not used'
  grep -Fq -- '--unit l4-app-data-backup.service' "$test_root/journal.args" || fail 'failed unit logs were not read'

  local body
  body=$(<"$test_root/curl.body")
  [[ $body == *'test-host'* ]] || fail 'host name was not included'
  [[ $body == *'l4-app-data-backup.service'* ]] || fail 'unit name was not included'
  [[ $body == *'tar: \"data\" failed\\path'* ]] || fail 'log text was not escaped as JSON'
  [[ $body == *'"allowed_mentions":{"parse":[]}'* ]] || fail 'mentions were not disabled'
  [[ $body != *$'\x1b'* ]] || fail 'control characters were sent'
  [[ $body != *$'\n'* ]] || fail 'raw newlines were sent'
  local fences=${body//[^\`]/}
  [[ ${#fences} -eq 8 ]] || fail 'log text could break out of the code block'
}

run_notify_truncation_case() {
  rm -f "$test_root"/curl.*
  local long_log
  long_log=$(printf 'あ%.0s' $(seq 1 3000))
  run_notify DISCORD_ALERT_WEBHOOK_URL="$webhook" MOCK_JOURNAL="$long_log" >/dev/null
  local body
  body=$(<"$test_root/curl.body")
  [[ $body == *'...'* ]] || fail 'long logs were not truncated'
  local count
  count=$(grep -o 'あ' <<<"$body" | wc -l)
  [[ $count -ge 1400 && $count -le 1500 ]] || fail "truncated log has $count characters"
}

run_notify_failure_cases() {
  if run_notify DISCORD_ALERT_WEBHOOK_URL= 2>/dev/null; then
    fail 'missing webhook URL was accepted'
  fi
  if run_notify DISCORD_ALERT_WEBHOOK_URL=https://example.com/hook 2>/dev/null; then
    fail 'non-Discord webhook URL was accepted'
  fi
  if run_notify DISCORD_ALERT_WEBHOOK_URL=https://evil.example/discord.com/api/webhooks/1/x 2>/dev/null; then
    fail 'webhook URL on another host was accepted'
  fi
  run_notify DISCORD_ALERT_WEBHOOK_URL=https://ptb.discord.com/api/webhooks/1/x >/dev/null ||
    fail 'PTB webhook URL was rejected'
  if run_notify DISCORD_ALERT_WEBHOOK_URL="$webhook" MOCK_CURL_STATUS=22 2>/dev/null; then
    fail 'webhook failure was ignored'
  fi
}

run_disk_check_cases
run_notify_success_case
run_notify_truncation_case
run_notify_failure_cases
printf 'alert script tests passed\n'
