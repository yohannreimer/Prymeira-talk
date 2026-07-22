#!/bin/sh
set -eu

talk_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
vincula_root=$(CDPATH= cd -- "$talk_root/../Vincula CRM" && pwd)
runtime_dir="$talk_root/.local/integrated-demo"
logs_dir="$runtime_dir/logs"
pids_dir="$runtime_dir/pids"
demo_port=54329
talk_database_url="postgresql://postgres@127.0.0.1:$demo_port/prymeira_talk"
vincula_database_url="postgresql://postgres@127.0.0.1:$demo_port/prymeira_vincula_demo"
vincula_token="prymeira-vincula-local-demo"
vincula_workspace_id="70000000-0000-4000-8000-000000000001"
temporary_vincula_pid=""

mkdir -p "$runtime_dir/tmp" "$logs_dir" "$pids_dir" "$runtime_dir/cache"
export TMPDIR="$runtime_dir/tmp"
export XDG_CACHE_HOME="$runtime_dir/cache"

case "$talk_root" in /Volumes/SanDiskSSD/*) ;; *) printf '%s\n' "Talk não está no SSD esperado." >&2; exit 1 ;; esac
case "$vincula_root" in /Volumes/SanDiskSSD/*) ;; *) printf '%s\n' "Vincula não está no SSD esperado." >&2; exit 1 ;; esac

find_pg_command() {
  command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    command -v "$command_name"
    return 0
  fi
  if [ -x "/opt/homebrew/bin/$command_name" ]; then
    printf '%s\n' "/opt/homebrew/bin/$command_name"
    return 0
  fi
  return 1
}

cleanup() {
  if [ -n "$temporary_vincula_pid" ]; then
    kill "$temporary_vincula_pid" >/dev/null 2>&1 || true
    wait "$temporary_vincula_pid" >/dev/null 2>&1 || true
    rm -f "$pids_dir/vincula-api-reset.pid"
  fi
}
trap cleanup EXIT INT TERM

psql_bin=$(find_pg_command psql || true)
createdb_bin=$(find_pg_command createdb || true)
if [ -z "$psql_bin" ] || [ -z "$createdb_bin" ]; then
  printf '%s\n' "psql e createdb são necessários para preparar a demo integrada." >&2
  exit 1
fi

PRYMEIRA_DEMO_DB_MODE=local pnpm --dir "$talk_root" demo:db

data_directory=$(
  "$psql_bin" -h 127.0.0.1 -p "$demo_port" -U postgres -d postgres -Atqc "show data_directory"
)
case "$data_directory" in
  /Volumes/SanDiskSSD/*) ;;
  *) printf '%s\n' "O PostgreSQL não está armazenando dados no SSD: $data_directory" >&2; exit 1 ;;
esac

if ! "$psql_bin" -h 127.0.0.1 -p "$demo_port" -U postgres -d postgres -Atqc \
  "select 1 from pg_database where datname = 'prymeira_vincula_demo'" | grep -q 1; then
  "$createdb_bin" -h 127.0.0.1 -p "$demo_port" -U postgres -O postgres prymeira_vincula_demo
fi

DATABASE_URL="$talk_database_url" pnpm --dir "$talk_root" prisma:generate
DATABASE_URL="$talk_database_url" pnpm --dir "$talk_root" --filter @prymeira-talk/api prisma db push
DATABASE_URL="$talk_database_url" PRYMEIRA_LOCAL_WORKSPACE_ID=demo_workspace \
  pnpm --dir "$talk_root" --filter @prymeira-talk/api seed:demo

if ! curl -fsS http://localhost:3003/api/health 2>/dev/null | grep -q '"service":"vincula-crm"'; then
  (
    cd "$vincula_root"
    env \
      PORT=3003 \
      DATABASE_URL="$vincula_database_url" \
      CORS_ORIGINS=http://localhost:5174,http://127.0.0.1:5174 \
      VINCULA_LOCAL_DEMO_ENABLED=true \
      VINCULA_LOCAL_DEMO_TOKEN="$vincula_token" \
      VINCULA_LOCAL_DEMO_WORKSPACE_ID="$vincula_workspace_id" \
      node server/index.js
  ) >"$logs_dir/vincula-api-reset.log" 2>&1 &
  temporary_vincula_pid=$!
  printf '%s\n' "$temporary_vincula_pid" >"$pids_dir/vincula-api-reset.pid"

  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if curl -fsS http://localhost:3003/api/health 2>/dev/null | grep -q '"service":"vincula-crm"'; then
      break
    fi
    if ! kill -0 "$temporary_vincula_pid" 2>/dev/null; then
      printf '%s\n' "A API temporária do Vincula encerrou. Consulte $logs_dir/vincula-api-reset.log" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
fi

if ! curl -fsS http://localhost:3003/api/health | grep -q '"service":"vincula-crm"'; then
  printf '%s\n' "A API do Vincula não ficou pronta em 30 segundos." >&2
  exit 1
fi

reset_result=$(curl -fsS -X POST \
  -H "Authorization: Bearer $vincula_token" \
  http://localhost:3003/api/demo/reset)
if ! printf '%s' "$reset_result" | grep -q '"ok":true'; then
  printf '%s\n' "O reset do Vincula não retornou sucesso." >&2
  exit 1
fi

printf '%s\n' "Demo integrada restaurada: Talk com 10 conversas; Vincula com 9 contatos e 6 negócios."
