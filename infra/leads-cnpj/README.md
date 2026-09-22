# CNPJ public-data stack

This is a PostgreSQL 16 stack solely for the public Receita Federal CNPJ data.
It is separate from Prymeira Talk's operational database and must not receive
workspaces, contacts, messages, or root-workspace credentials.

The pipeline submodule is detached at
`79a11af4b708d5562beca83f6efb32bb3fd5e8fb` (`v1.38.9`). Its upstream-license
limitation is recorded in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Local setup and monthly refresh

```bash
cd infra/leads-cnpj
cp .env.example .env
./update-cnpj-data.sh
```

The script invokes the upstream with no `--month`, its documented recurring
mode for the newest Receita competence. Compose passes libpq `PG*` variables,
including `PGOPTIONS=-c search_path=cnpj`, so pipeline tables live in `cnpj`
without embedding a raw password in a URI. It rejects
an uninitialized, dirty, branch-tracking, or wrong-SHA submodule before Docker
runs, clears the caller environment for every compose call, and prints the
loaded competence, timestamp, pipeline version, and SHA after success.

Downloaded raw files are retained in `CNPJ_RAW_DATA_DIR` (default `./data`) for
resumable downloads and are Git-ignored. Set it to an external disk when
appropriate. PostgreSQL is bound only to
`127.0.0.1:${CNPJ_POSTGRES_PORT:-5436}` and an internal Docker network; never
change this to `0.0.0.0`.

## Read-only API role

After the initial data load, run the following as the CNPJ stack owner (put the
real password in a secret manager, never Git):

```sql
CREATE ROLE prymeira_cnpj_reader LOGIN PASSWORD 'replace-with-a-secret';
GRANT CONNECT ON DATABASE cnpj TO prymeira_cnpj_reader;
GRANT USAGE ON SCHEMA cnpj TO prymeira_cnpj_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA cnpj TO prymeira_cnpj_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE cnpj_pipeline IN SCHEMA cnpj
  GRANT SELECT ON TABLES TO prymeira_cnpj_reader;
```

Do not grant the API `CREATE`, writes, ownership, or the pipeline account.

## API environment

Set these in the Talk API environment, never in this stack's `.env`.

Local development:

```dotenv
CNPJ_DATABASE_URL=postgresql://prymeira_cnpj_reader:local_reader_password@127.0.0.1:5436/cnpj?options=-c%20search_path%3Dcnpj&application_name=prymeira-talk
GOOGLE_MAPS_SCRAPER_URL=http://127.0.0.1:8080
LEAD_GOOGLE_MAX_CONCURRENT_JOBS=1
LEAD_GOOGLE_DEFAULT_DEPTH=5
LEAD_WHATSAPP_BATCH_SIZE=25
LEAD_JOB_POLL_MS=5000
```

Production, with the API attached to the private CNPJ Docker network:

```dotenv
CNPJ_DATABASE_URL=postgresql://prymeira_cnpj_reader:production_reader_password@cnpj-postgres:5432/cnpj?sslmode=disable&options=-c%20search_path%3Dcnpj&application_name=prymeira-talk
GOOGLE_MAPS_SCRAPER_URL=http://google-maps-scraper:8080
LEAD_GOOGLE_MAX_CONCURRENT_JOBS=1
LEAD_GOOGLE_DEFAULT_DEPTH=5
LEAD_WHATSAPP_BATCH_SIZE=25
LEAD_JOB_POLL_MS=5000
```

The source URLs are optional. Normal Talk startup does not require either
service; its corresponding Leads feature will report that source unavailable
when invoked.

## Google Maps sidecar

The dev sidecar is fixed at
`gosom/google-maps-scraper:v1.15.0@sha256:8f5dc7f8fe57832faf1e93c5224d7451f0193154cf8d128e1f40b0773770ebd1`
and deliberately binds only to loopback:

```bash
docker compose -f docker-compose.dev.yml up -d google-maps-scraper
curl http://127.0.0.1:8080/api/v1/jobs
```

It has no built-in authentication. Do not publish it through a public port;
upgrade its fixed image only after intentional dependency review. In production,
start the same private-network sidecar with
`docker compose --profile google-maps-scraper -f infra/leads-cnpj/docker-compose.yml up -d`;
the API can then use `http://google-maps-scraper:8080` only after joining
`prymeira-leads-cnpj-private`.
