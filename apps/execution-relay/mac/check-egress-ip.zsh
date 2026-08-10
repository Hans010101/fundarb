#!/bin/zsh
set -euo pipefail

readonly STATE_DIR="$HOME/Library/Application Support/FundArb/execution-relay"
readonly ENABLED_FILE="$STATE_DIR/enabled"
readonly EXPECTED_IP_FILE="$STATE_DIR/expected-egress-ip"
[[ -f "$ENABLED_FILE" && -f "$EXPECTED_IP_FILE" ]] || exit 0
expected_ip="$(tr -d '[:space:]' < "$EXPECTED_IP_FILE")"
current_ip="$(/usr/bin/curl -4 --fail --silent --max-time 10 https://api.ipify.org)" || exit 0
[[ "$current_ip" == "$expected_ip" ]] && exit 0
/bin/mv -f "$ENABLED_FILE" "$STATE_DIR/blocked-ip-drift"
/bin/launchctl kill TERM "gui/$(/usr/bin/id -u)/com.fundarb.execution-relay" >/dev/null 2>&1 || true
/bin/launchctl kill TERM "gui/$(/usr/bin/id -u)/com.fundarb.execution-tunnel" >/dev/null 2>&1 || true
/usr/bin/osascript -e 'display notification "出口 IP 已变化，FundArb 中继已停止。" with title "FundArb 安全熔断"' >/dev/null 2>&1 || true
