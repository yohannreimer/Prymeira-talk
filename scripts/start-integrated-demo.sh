#!/bin/sh
set -eu

talk_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
vincula_root=$(CDPATH= cd -- "$talk_root/../Vincula CRM" && pwd)
runtime_dir="$talk_root/.local/integrated-demo"
logs_dir="$runtime_dir/logs"
pids_dir="$runtime_dir/pids"
vincula_database_url="postgresql://postgres@127.0.0.1:54329/prymeira_vincula_demo"
vincula_token="prymeira-vincula-local-demo"
vincula_workspace_id="70000000-0000-4000-8000-000000000001"
owned_pids=""

case "$talk_root" in /Volumes/SanDiskSSD/*) ;; *) printf '%s\n' "Talk não está no SSD esperado." >&2; exit 1 ;; esac
case "$vincula_root" in /Volumes/SanDiskSSD/*) ;; *) printf '%s\n' "Vincula não está no SSD esperado." >&2; exit 1 ;; esac
if [ ! -d "$runtime_dir" ]; then
  printf '%s\n' "Execute 'pnpm demo:reset:all' antes de iniciar a stack." >&2
  exit 1
fi

mkdir -p "$runtime_dir/tmp" "$logs_dir" "$pids_dir" "$runtime_dir/cache"
export TMPDIR="$runtime_dir/tmp"
export XDG_CACHE_HOME="$runtime_dir/cache"

terminate_tree() {
  local tree_pid child_pids child_pid
  tree_pid="$1"
  child_pids=$(pgrep -P "$tree_pid" 2>/dev/null || true)
  for child_pid in $child_pids; do
    terminate_tree "$child_pid"
  done
  kill "$tree_pid" >/dev/null 2>&1 || true
}

cleanup() {
  for owned_pid in $owned_pids; do
    terminate_tree "$owned_pid"
  done
  for owned_pid in $owned_pids; do
    wait "$owned_pid" >/dev/null 2>&1 || true
  done
  rm -f "$pids_dir/vincula-api.pid" "$pids_dir/vincula-web.pid" "$pids_dir/talk-stack.pid"
}
trap cleanup EXIT INT TERM

if curl -fsS http://localhost:3003/api/health >/dev/null 2>&1 || \
  curl -fsS http://localhost:3002/health >/dev/null 2>&1; then
  printf '%s\n' "Uma API da demonstração já está em execução. Encerre-a antes de iniciar esta stack." >&2
  exit 1
fi

(
  cd "$vincula_root"
  env \
    PORT=3003 \
    DATABASE_URL="$vincula_database_url" \
    VINCULA_LOCAL_DEMO_ENABLED=true \
    VINCULA_LOCAL_DEMO_TOKEN="$vincula_token" \
    VINCULA_LOCAL_DEMO_WORKSPACE_ID="$vincula_workspace_id" \
    node server/index.js
) >"$logs_dir/vincula-api.log" 2>&1 &
vincula_api_pid=$!
owned_pids="$owned_pids $vincula_api_pid"
printf '%s\n' "$vincula_api_pid" >"$pids_dir/vincula-api.pid"

(
  cd "$vincula_root"
  env \
    VITE_CRM_API_URL=http://localhost:3003/api \
    VITE_VINCULA_LOCAL_DEMO_TOKEN="$vincula_token" \
    npm run demo:local
) >"$logs_dir/vincula-web.log" 2>&1 &
vincula_web_pid=$!
owned_pids="$owned_pids $vincula_web_pid"
printf '%s\n' "$vincula_web_pid" >"$pids_dir/vincula-web.pid"

(
  cd "$talk_root"
  env \
    DATABASE_URL=postgresql://postgres@127.0.0.1:54329/prymeira_talk \
    VINCULA_CRM_API_URL=http://localhost:3003/api \
    VINCULA_CRM_API_TOKEN="$vincula_token" \
    VINCULA_CRM_WEB_URL=http://localhost:5174 \
    VINCULA_CRM_STRICT_REAL=true \
    VINCULA_CRM_RESET_URL=http://localhost:3003/api/demo/reset \
    VINCULA_CRM_RESET_TOKEN="$vincula_token" \
    pnpm demo:prymeira
) >"$logs_dir/talk-stack.log" 2>&1 &
talk_stack_pid=$!
owned_pids="$owned_pids $talk_stack_pid"
printf '%s\n' "$talk_stack_pid" >"$pids_dir/talk-stack.pid"

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -fsS http://localhost:3002/health 2>/dev/null | grep -q '"ok":true' && \
    curl -fsS http://localhost:3003/api/health 2>/dev/null | grep -q '"service":"vincula-crm"' && \
    [ "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost:5176 2>/dev/null)" = "200" ] && \
    [ "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost:5174 2>/dev/null)" = "200" ]; then
    printf '%s\n' "Demo integrada pronta: Talk http://localhost:5176 | Vincula http://localhost:5174"
    break
  fi
  for owned_pid in $owned_pids; do
    if ! kill -0 "$owned_pid" 2>/dev/null; then
      printf '%s\n' "Um serviço encerrou durante a inicialização. Consulte $logs_dir" >&2
      exit 1
    fi
  done
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$attempt" -ge 30 ]; then
  printf '%s\n' "A stack não ficou pronta em 30 segundos. Consulte $logs_dir" >&2
  exit 1
fi

while :; do
  for owned_pid in $owned_pids; do
    if ! kill -0 "$owned_pid" 2>/dev/null; then
      printf '%s\n' "Um serviço da demo encerrou. Consulte $logs_dir" >&2
      exit 1
    fi
  done
  sleep 2
done
