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
