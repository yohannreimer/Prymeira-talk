#!/bin/sh
set -eu

talk_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
mkdir -p "$talk_root/.local"
test_root=$(mktemp -d "$talk_root/.local/reset-integrated-demo-test.XXXXXX")
mock_bin="$test_root/bin"
log_file="$test_root/calls.log"
mkdir -p "$mock_bin"

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT INT TERM

cat >"$mock_bin/pnpm" <<'EOF'
#!/bin/sh
printf 'pnpm %s\n' "$*" >>"$RESET_TEST_LOG"
case "$*" in
  *"seed:demo"*) [ "${RESET_TEST_FAIL_TALK:-}" != "1" ] ;;
esac
EOF

cat >"$mock_bin/psql" <<'EOF'
#!/bin/sh
case "$*" in
  *"show data_directory"*) printf '%s\n' "/Volumes/SanDiskSSD/mock-postgres" ;;
  *"select 1 from pg_database"*) printf '%s\n' "1" ;;
esac
EOF

cat >"$mock_bin/createdb" <<'EOF'
#!/bin/sh
printf 'createdb %s\n' "$*" >>"$RESET_TEST_LOG"
EOF

cat >"$mock_bin/curl" <<'EOF'
#!/bin/sh
case "$*" in
  *"/api/health"*) printf '%s\n' '{"service":"vincula-crm"}' ;;
  *"/api/demo/reset"*)
    printf '%s\n' "${RESET_TEST_PAYLOAD}"
    printf '%s\n' "vincula-reset" >>"$RESET_TEST_LOG"
    ;;
esac
EOF

chmod +x "$mock_bin/pnpm" "$mock_bin/psql" "$mock_bin/createdb" "$mock_bin/curl"

run_reset() {
  RESET_TEST_LOG="$log_file" \
  RESET_TEST_PAYLOAD="$1" \
  RESET_TEST_FAIL_TALK="${2:-}" \
  PATH="$mock_bin:$PATH" \
    sh "$talk_root/scripts/reset-integrated-demo.sh"
}

invalid_payload='{"ok":true,"workspaceId":"wrong-workspace","sales":5,"companies":9,"contacts":9,"deals":6,"notes":6}'
if run_reset "$invalid_payload" >"$test_root/invalid.out" 2>"$test_root/invalid.err"; then
  printf '%s\n' "expected invalid Vincula payload to fail" >&2
  exit 1
fi
if grep -q 'seed:demo' "$log_file"; then
  printf '%s\n' "Talk seed ran after a failed Vincula reset" >&2
  exit 1
fi

: >"$log_file"
valid_payload='{"ok":true,"workspaceId":"70000000-0000-4000-8000-000000000001","sales":5,"companies":9,"contacts":9,"deals":6,"notes":6}'
run_reset "$valid_payload" >"$test_root/valid.out" 2>"$test_root/valid.err"

reset_line=$(grep -n '^vincula-reset$' "$log_file" | cut -d: -f1)
seed_line=$(grep -n 'seed:demo' "$log_file" | cut -d: -f1)
if [ -z "$reset_line" ] || [ -z "$seed_line" ] || [ "$reset_line" -ge "$seed_line" ]; then
  printf '%s\n' "Vincula reset did not complete before the Talk seed" >&2
  exit 1
fi

if run_reset "$valid_payload" 1 >"$test_root/partial.out" 2>"$test_root/partial.err"; then
  printf '%s\n' "expected a failed Talk seed to fail the integrated reset" >&2
  exit 1
fi
if ! grep -q 'Reset parcial: Vincula foi restaurado, mas o Talk falhou' "$test_root/partial.err"; then
  printf '%s\n' "partial reset failure was not reported honestly" >&2
  exit 1
fi

printf '%s\n' "reset-integrated-demo ordering tests passed"
