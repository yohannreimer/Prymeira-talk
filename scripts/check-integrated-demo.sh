#!/bin/sh
set -eu

talk_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
runtime_dir="$talk_root/.local/integrated-demo"
demo_port=54329

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

psql_bin=$(find_pg_command psql || true)
if [ -z "$psql_bin" ]; then
  printf '%s\n' "psql não encontrado." >&2
  exit 1
fi

talk_health=$(curl -fsS http://localhost:3002/health)
printf '%s' "$talk_health" | grep -q '"ok":true'
vincula_health=$(curl -fsS http://localhost:3003/api/health)
printf '%s' "$vincula_health" | grep -q '"ok":true'
printf '%s' "$vincula_health" | grep -q '"service":"vincula-crm"'

[ "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost:5176)" = "200" ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost:5174)" = "200" ]

data_directory=$(
  "$psql_bin" -h 127.0.0.1 -p "$demo_port" -U postgres -d postgres -Atqc "show data_directory"
)
case "$data_directory" in /Volumes/SanDiskSSD/*) ;; *) exit 1 ;; esac

database_count=$(
  "$psql_bin" -h 127.0.0.1 -p "$demo_port" -U postgres -d postgres -Atqc \
    "select count(*) from pg_database where datname in ('prymeira_talk', 'prymeira_vincula_demo')"
)
[ "$database_count" = "2" ]

for runtime_path in "$runtime_dir" "$runtime_dir/logs" "$runtime_dir/pids" "$runtime_dir/cache" "$runtime_dir/tmp"; do
  resolved_path=$(CDPATH= cd -- "$runtime_path" && pwd)
  case "$resolved_path" in /Volumes/SanDiskSSD/*) ;; *) exit 1 ;; esac
done

printf '%s\n' "Stack saudável; dois apps, duas interfaces e bancos persistidos no SSD."
