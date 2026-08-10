#!/bin/zsh
set -euo pipefail

readonly STATE_DIR="$HOME/Library/Application Support/FundArb/execution-relay"
readonly ENABLED_FILE="$STATE_DIR/enabled"
readonly EXPECTED_IP_FILE="$STATE_DIR/expected-egress-ip"
readonly REGISTRY_URL_FILE="$STATE_DIR/registry-url"
readonly CLOUDFLARED_BIN="$STATE_DIR/bin/cloudflared"
readonly KEYCHAIN_SERVICE="com.fundarb.execution-relay.token"
readonly TUNNEL_LOG="$STATE_DIR/quick-tunnel.log"

[[ -f "$ENABLED_FILE" && -f "$EXPECTED_IP_FILE" && -f "$REGISTRY_URL_FILE" && -x "$CLOUDFLARED_BIN" ]] || exit 78
expected_ip="$(tr -d '[:space:]' < "$EXPECTED_IP_FILE")"
registry_url="$(tr -d '[:space:]' < "$REGISTRY_URL_FILE")"
[[ "$registry_url" == https://*.workers.dev/register ]] || exit 78
account_name="$(/usr/bin/id -un)"
relay_token="$(/usr/bin/security find-generic-password -a "$account_name" -s "$KEYCHAIN_SERVICE" -w)"
[[ ${#relay_token} -ge 32 ]] || exit 78

for attempt in {1..30}; do
  /usr/bin/curl --fail --silent --max-time 3 http://127.0.0.1:8790/health >/dev/null && break
  [[ "$attempt" -lt 30 ]] || exit 75
  /bin/sleep 1
done

: > "$TUNNEL_LOG"
"$CLOUDFLARED_BIN" tunnel --url http://127.0.0.1:8790 --no-autoupdate --loglevel info --logfile "$TUNNEL_LOG" >/dev/null 2>&1 &
tunnel_pid=$!

disable_registration() {
  /usr/bin/curl -4 --fail --silent --max-time 10 -X DELETE \
    -H "Authorization: Bearer $relay_token" "$registry_url" >/dev/null 2>&1 || true
}
cleanup() {
  disable_registration
  /bin/kill "$tunnel_pid" >/dev/null 2>&1 || true
  wait "$tunnel_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

tunnel_url=""
for attempt in {1..60}; do
  tunnel_url="$(/usr/bin/sed -nE 's#.*(https://[a-z0-9-]+\.trycloudflare\.com).*#\1#p' "$TUNNEL_LOG" | /usr/bin/tail -n 1)"
  [[ "$tunnel_url" == https://*.trycloudflare.com ]] && break
  /bin/kill -0 "$tunnel_pid" >/dev/null 2>&1 || exit 75
  [[ "$attempt" -lt 60 ]] || exit 75
  /bin/sleep 1
done
/bin/sleep 5

register_tunnel() {
  request_body="$(/usr/bin/printf '{"url":"%s","egress_ipv4":"%s"}' "$tunnel_url" "$expected_ip")"
  /usr/bin/curl -4 --fail --silent --max-time 15 \
    -H "Authorization: Bearer $relay_token" -H 'Content-Type: application/json' \
    --data "$request_body" "$registry_url" >/dev/null
}

while /bin/kill -0 "$tunnel_pid" >/dev/null 2>&1 && [[ -f "$ENABLED_FILE" ]]; do
  register_tunnel || true
  /bin/sleep 60
done
wait "$tunnel_pid"
