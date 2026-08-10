#!/bin/zsh
set -euo pipefail

readonly STATE_DIR="$HOME/Library/Application Support/FundArb/execution-relay"
readonly ENABLED_FILE="$STATE_DIR/enabled"
readonly EXPECTED_IP_FILE="$STATE_DIR/expected-egress-ip"
readonly NODE_BIN="$STATE_DIR/bin/node"
readonly APP_DIR="${0:A:h}"
readonly KEYCHAIN_SERVICE="com.fundarb.execution-relay.token"

[[ -f "$ENABLED_FILE" && -x "$NODE_BIN" && -f "$EXPECTED_IP_FILE" ]] || exit 78
expected_ip="$(tr -d '[:space:]' < "$EXPECTED_IP_FILE")"
current_ip="$(/usr/bin/curl -4 --fail --silent --show-error --max-time 10 https://api.ipify.org)" || exit 75
if [[ "$current_ip" != "$expected_ip" ]]; then
  /bin/mv -f "$ENABLED_FILE" "$STATE_DIR/blocked-ip-drift"
  /usr/bin/osascript -e 'display notification "出口 IP 已变化，FundArb 中继已停止；请先更新交易所 API 白名单。" with title "FundArb 安全熔断"' >/dev/null 2>&1 || true
  exit 78
fi

account_name="$(/usr/bin/id -un)"
relay_token="$(/usr/bin/security find-generic-password -a "$account_name" -s "$KEYCHAIN_SERVICE" -w)"
[[ ${#relay_token} -ge 32 ]] || exit 78
export PORT=8790
export FUNDARB_RELAY_TOKEN="$relay_token"
exec "$NODE_BIN" "$APP_DIR/server.mjs"
