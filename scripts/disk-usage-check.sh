#!/usr/bin/env bash
set -Eeuo pipefail

target=${DISK_USAGE_PATH:-/}
threshold=${DISK_USAGE_THRESHOLD:-80}

fail() {
  printf 'disk usage check: %s\n' "$1" >&2
  exit 1
}

[[ $threshold =~ ^[0-9]+$ ]] || fail 'invalid threshold'
threshold=$((10#$threshold))
((threshold >= 1 && threshold <= 100)) || fail 'invalid threshold'

usage=$(df -P -- "$target" | awk 'NR == 2 { sub(/%$/, "", $5); print $5 }')
[[ $usage =~ ^[0-9]+$ ]] || usage=
[[ -n $usage ]] || fail "could not read disk usage: $target"

if ((usage >= threshold)); then
  fail "$target is ${usage}% used (threshold ${threshold}%)"
fi

printf 'disk usage check: %s is %s%% used (threshold %s%%)\n' "$target" "$usage" "$threshold"
