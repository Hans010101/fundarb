#!/bin/zsh
set -euo pipefail

readonly RELAY_DIR="${0:A:h:h}"
readonly MAC_DIR="$RELAY_DIR/mac"
readonly STATE_DIR="$HOME/Library/Application Support/FundArb/execution-relay"
readonly BIN_DIR="$STATE_DIR/bin"
readonly APP_DIR="$STATE_DIR/app"
readonly AGENTS_DIR="$HOME/Library/LaunchAgents"
readonly KEYCHAIN_SERVICE="com.fundarb.execution-relay.token"
readonly DOMAIN_TARGET="gui/$(/usr/bin/id -u)"
readonly REGISTRY_URL="https://fundarb-relay-registry.hans-pan007.workers.dev/register"

node_bin="$(command -v node)"
cloudflared_bin="$(command -v cloudflared)"
[[ -x "$node_bin" && -x "$cloudflared_bin" ]] || { print -u2 'Node.js 与 cloudflared 均为必需'; exit 1; }
current_ip="$(/usr/bin/curl -4 --fail --silent --show-error --max-time 10 https://api.ipify.org)"
[[ "$current_ip" == <->.<->.<->.<-> ]] || exit 1

/bin/mkdir -p "$APP_DIR" "$BIN_DIR" "$AGENTS_DIR"
/bin/chmod 700 "$STATE_DIR" "$APP_DIR" "$BIN_DIR"
/bin/ln -sfn "$node_bin" "$BIN_DIR/node"
/bin/ln -sfn "$cloudflared_bin" "$BIN_DIR/cloudflared"
/usr/bin/install -m 700 "$MAC_DIR/run-relay.zsh" "$APP_DIR/run-relay.zsh"
/usr/bin/install -m 700 "$MAC_DIR/run-quick-tunnel.zsh" "$APP_DIR/run-quick-tunnel.zsh"
/usr/bin/install -m 700 "$MAC_DIR/check-egress-ip.zsh" "$APP_DIR/check-egress-ip.zsh"
/usr/bin/install -m 600 "$RELAY_DIR/server.mjs" "$APP_DIR/server.mjs"
/usr/bin/printf '%s\n' "$current_ip" > "$STATE_DIR/expected-egress-ip"
/usr/bin/printf '%s\n' "$REGISTRY_URL" > "$STATE_DIR/registry-url"
/usr/bin/touch "$STATE_DIR/enabled"
/bin/rm -f "$STATE_DIR/blocked-ip-drift"
/bin/chmod 600 "$STATE_DIR/expected-egress-ip" "$STATE_DIR/registry-url" "$STATE_DIR/enabled"

escape_sed() { print -r -- "$1" | /usr/bin/sed 's/[&|]/\\&/g'; }
state_dir_escaped="$(escape_sed "$STATE_DIR")"
for label in com.fundarb.execution-relay com.fundarb.execution-tunnel com.fundarb.execution-ip-guard; do
  target="$AGENTS_DIR/$label.plist"
  /usr/bin/sed -e "s|__STATE_DIR__|$state_dir_escaped|g" "$MAC_DIR/$label.plist.template" > "$target"
  /usr/bin/plutil -lint "$target" >/dev/null
  /bin/launchctl bootout "$DOMAIN_TARGET/$label" >/dev/null 2>&1 || true
done
/bin/sleep 1
for label in com.fundarb.execution-relay com.fundarb.execution-tunnel com.fundarb.execution-ip-guard; do
  target="$AGENTS_DIR/$label.plist"
  for attempt in {1..5}; do
    /bin/launchctl bootstrap "$DOMAIN_TARGET" "$target" >/dev/null 2>&1 && break
    [[ "$attempt" -lt 5 ]] || { print -u2 "无法启动 $label"; exit 1; }
    /bin/sleep 2
  done
done
/bin/sleep 3
/usr/bin/curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8790/health
/usr/bin/printf '\nFundArb 中继已安装；交易所 API 白名单出口 IPv4：%s\n' "$current_ip"
