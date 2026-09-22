#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
config="$(env -i PATH="$PATH" HOME="$HOME" CNPJ_POSTGRES_PASSWORD='raw@password:with-colon' docker compose \
  --env-file "$script_dir/.env.example" \
  -f "$script_dir/docker-compose.yml" \
  config --format json)"

printf '%s' "$config" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const services = JSON.parse(input).services;
    const pipeline = services["cnpj-pipeline"].environment;
    const postgres = services["cnpj-postgres"].environment;
    const expected = {
      PGHOST: "cnpj-postgres",
      PGPORT: "5432",
      PGDATABASE: "cnpj",
      PGUSER: "cnpj_pipeline",
      PGPASSWORD: "raw@password:with-colon",
      PGOPTIONS: "-c search_path=cnpj"
    };

    if ("DATABASE_URL" in pipeline) {
      throw new Error("cnpj-pipeline must not assemble DATABASE_URL from a password");
    }
    for (const [name, value] of Object.entries(expected)) {
      if (pipeline[name] !== value) {
        throw new Error(`${name} was ${JSON.stringify(pipeline[name])}, expected ${JSON.stringify(value)}`);
      }
    }
    if (postgres.POSTGRES_PASSWORD !== expected.PGPASSWORD) {
      throw new Error("pipeline and Postgres received different raw passwords");
    }
  });
'
