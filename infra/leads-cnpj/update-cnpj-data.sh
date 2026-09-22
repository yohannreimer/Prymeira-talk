#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_PIPELINE_SHA="79a11af4b708d5562beca83f6efb32bb3fd5e8fb"
readonly PIPELINE_SUBMODULE="infra/leads-cnpj/cnpj-data-pipeline"
readonly SUBMODULE_NAME="infra_leads_cnpj_data_pipeline"

fail() {
  printf 'update-cnpj-data: %s\n' "$*" >&2
  exit 1
}

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
pipeline_dir="$script_dir/cnpj-data-pipeline"
compose_file="$script_dir/docker-compose.yml"
env_file="$script_dir/.env"
similarity_indexes_file="$script_dir/similarity-indexes.sql"

test -f "$env_file" || fail "missing $env_file; copy .env.example and configure only CNPJ stack settings"
test -d "$pipeline_dir" || fail "submodule is not initialized; run git submodule update --init --recursive"
test -f "$similarity_indexes_file" || fail "missing $similarity_indexes_file"

gitlink_sha="$(git -C "$repo_root" ls-files --stage -- "$PIPELINE_SUBMODULE" | awk '$1 == "160000" { print $2 }')"
test "$gitlink_sha" = "$EXPECTED_PIPELINE_SHA" || fail "submodule gitlink is not pinned to $EXPECTED_PIPELINE_SHA"

submodule_status="$(git -C "$repo_root" submodule status -- "$PIPELINE_SUBMODULE")"
case "$submodule_status" in
  " $EXPECTED_PIPELINE_SHA "*) ;;
  *) fail "submodule is uninitialized, dirty, or does not resolve to $EXPECTED_PIPELINE_SHA" ;;
esac

test "$(git -C "$pipeline_dir" rev-parse HEAD)" = "$EXPECTED_PIPELINE_SHA" || fail "submodule HEAD is not pinned"
test -z "$(git -C "$pipeline_dir" symbolic-ref -q --short HEAD || true)" || fail "submodule must be on a detached pinned commit"
test -z "$(git -C "$pipeline_dir" status --porcelain --untracked-files=all)" || fail "submodule has local changes"
if git -C "$repo_root" config -f .gitmodules --get "submodule.${SUBMODULE_NAME}.branch" >/dev/null; then
  fail "submodule must not track a branch"
fi

command -v docker >/dev/null 2>&1 || fail "docker is required"

run_compose() {
  # Never inherit root DATABASE_URL or any Prymeira workspace credential.
  env -i PATH="$PATH" HOME="$HOME" docker compose \
    --env-file "$env_file" -f "$compose_file" "$@"
}

run_compose up -d --wait cnpj-postgres
# Omitting --month is the upstream's documented recurring monthly mode.
run_compose run --rm cnpj-pipeline
run_compose exec -T cnpj-postgres sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$similarity_indexes_file"

dataset_state="$(run_compose exec -T cnpj-postgres sh -ec 'psql -At -F "|" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT max(directory), max(processed_at) FROM cnpj.processed_files"')"
dataset_month="${dataset_state%%|*}"
dataset_processed_at="${dataset_state#*|}"
test -n "$dataset_month" && test "$dataset_month" != "$dataset_state" || fail "pipeline succeeded without recording a dataset competence"

pipeline_version="$(sed -nE 's/^version = "([^"]+)"/\1/p' "$pipeline_dir/pyproject.toml" | head -n 1)"
test -n "$pipeline_version" || fail "could not determine the pinned pipeline version"

printf 'CNPJ dataset refresh: competence %s; processed at %s; pipeline v%s (%s)\n' \
  "$dataset_month" "$dataset_processed_at" "$pipeline_version" "$EXPECTED_PIPELINE_SHA"
