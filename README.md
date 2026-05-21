# Prymeira Talk

Prymeira Talk is a multi-company WhatsApp operations SaaS for the Prymeira ecosystem.

## Local Development

1. Install dependencies:

```sh
pnpm install
```

2. Create `.env` from `.env.example`.

3. Start local Postgres:

```sh
docker compose -f docker-compose.dev.yml up -d
```

4. Generate Prisma client and run migrations:

```sh
pnpm prisma:generate
pnpm prisma:migrate
```

5. Start apps:

```sh
pnpm dev
```

Local URLs:

- API: `http://localhost:3002`
- Web: `http://localhost:5176`

Auth rule: Clerk authenticates, Prymeira Account authorizes `product_key=talk`, Prymeira Talk enforces workspace data boundaries in the API.

## Foundation Verification

The current foundation slice has been verified locally with:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web typecheck
pnpm --filter @prymeira-talk/web build
```

The web package accepts an empty Vitest suite during this first shell phase; UI tests should be added as interactive flows land.

For local database verification:

```sh
docker compose -f docker-compose.dev.yml up -d
pnpm prisma:generate
pnpm --filter @prymeira-talk/api prisma migrate dev --name init
```

Production-grade tenant resolution depends on Prymeira Account returning a `workspace_id` for users entitled to `product_key=talk`. Prymeira Talk treats the API as the tenant boundary and filters workspace data server-side.

For local UI testing without a running Prymeira Account backend, keep Clerk enabled and set:

```sh
PRYMEIRA_LOCAL_AUTH_BYPASS=true
PRYMEIRA_LOCAL_WORKSPACE_ID=local_workspace
PRYMEIRA_LOCAL_ROLE=owner
```

This bypass still requires a Clerk bearer token and should stay disabled outside local development.
