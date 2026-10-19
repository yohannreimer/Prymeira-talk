#!/bin/sh
set -eu

runtime_config_path="/usr/share/nginx/html/runtime-config.js"

js_escape() {
  printf "%s" "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

api_url="$(js_escape "${VITE_API_URL:-https://talk.prymeiradigital.com.br/api}")"
local_auth_bypass="$(js_escape "${VITE_LOCAL_AUTH_BYPASS:-false}")"
clerk_publishable_key="$(js_escape "${VITE_CLERK_PUBLISHABLE_KEY:-${CLERK_PUBLISHABLE_KEY:-}}")"
hub_url="$(js_escape "${VITE_PRYMEIRA_HUB_URL:-https://account.prymeira.com}")"

cat > "$runtime_config_path" <<EOF
window.__PRYMEIRA_TALK_CONFIG__ = {
  VITE_API_URL: "$api_url",
  VITE_LOCAL_AUTH_BYPASS: "$local_auth_bypass",
  VITE_CLERK_PUBLISHABLE_KEY: "$clerk_publishable_key",
  VITE_PRYMEIRA_HUB_URL: "$hub_url"
};
EOF
