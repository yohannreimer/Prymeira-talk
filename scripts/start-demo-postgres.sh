#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
demo_state_dir="$project_dir/.local/demo-postgres"
demo_data_dir="$demo_state_dir/data"
demo_log_path="$demo_state_dir/postgres.log"
demo_port=54329
demo_db_mode=${PRYMEIRA_DEMO_DB_MODE:-auto}

case "$demo_db_mode" in
  auto|local) ;;
  *)
    printf '%s\n' "PRYMEIRA_DEMO_DB_MODE deve ser 'auto' ou 'local'." >&2
    exit 1
    ;;
esac

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

pg_isready_bin=$(find_pg_command pg_isready || true)
if [ -n "$pg_isready_bin" ] && "$pg_isready_bin" -h 127.0.0.1 -p "$demo_port" >/dev/null 2>&1; then
  printf '%s\n' "PostgreSQL da demo já está pronto na porta $demo_port."
  exit 0
fi

if [ "$demo_db_mode" = "auto" ] && command -v docker >/dev/null 2>&1; then
  if docker compose -f "$project_dir/docker-compose.dev.yml" up -d >/dev/null 2>&1; then
    attempt=0
    while [ "$attempt" -lt 20 ]; do
      if [ -n "$pg_isready_bin" ] && "$pg_isready_bin" -h 127.0.0.1 -p "$demo_port" >/dev/null 2>&1; then
        printf '%s\n' "PostgreSQL da demo iniciado pelo Docker."
        exit 0
      fi
      attempt=$((attempt + 1))
      sleep 1
    done
  fi
  printf '%s\n' "Docker indisponível; iniciando o PostgreSQL local isolado."
fi

initdb_bin=$(find_pg_command initdb || true)
pg_ctl_bin=$(find_pg_command pg_ctl || true)
createuser_bin=$(find_pg_command createuser || true)
createdb_bin=$(find_pg_command createdb || true)
psql_bin=$(find_pg_command psql || true)

if [ -z "$initdb_bin" ] || [ -z "$pg_ctl_bin" ] || [ -z "$createuser_bin" ] || [ -z "$createdb_bin" ] || [ -z "$psql_bin" ]; then
  printf '%s\n' "Não foi possível iniciar o banco: Docker e PostgreSQL local não estão disponíveis." >&2
  exit 1
fi

mkdir -p "$demo_state_dir"
if [ ! -f "$demo_data_dir/PG_VERSION" ]; then
  "$initdb_bin" -D "$demo_data_dir" --auth=trust --locale=C >/dev/null
fi

if ! "$pg_ctl_bin" -D "$demo_data_dir" status >/dev/null 2>&1; then
  "$pg_ctl_bin" -D "$demo_data_dir" -l "$demo_log_path" -o "-p $demo_port -h 127.0.0.1" start >/dev/null
fi

if ! "$psql_bin" -h 127.0.0.1 -p "$demo_port" -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname = 'postgres'" | grep -q 1; then
  "$createuser_bin" -h 127.0.0.1 -p "$demo_port" -s postgres
fi

if ! "$psql_bin" -h 127.0.0.1 -p "$demo_port" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = 'prymeira_talk'" | grep -q 1; then
  "$createdb_bin" -h 127.0.0.1 -p "$demo_port" -O postgres prymeira_talk
fi

printf '%s\n' "PostgreSQL local da demo pronto na porta $demo_port."
