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

For local UI testing without a running Prymeira Account backend, keep Clerk enabled and set the API bypass plus the web bypass:

```sh
PRYMEIRA_LOCAL_AUTH_BYPASS=true
PRYMEIRA_LOCAL_WORKSPACE_ID=local_workspace
PRYMEIRA_LOCAL_ROLE=owner
VITE_LOCAL_AUTH_BYPASS=true
```

The API bypass accepts any bearer token, including the local websocket token `local-dev-bypass`. Keep it disabled outside local development.

Evolution runs in controlled simulated mode by default. Real Evolution mode is enabled only at runtime with `EVOLUTION_MODE=real`, a valid `EVOLUTION_API_BASE_URL`, and `EVOLUTION_API_KEY`; local simulated mode can still create a demo Evolution channel, generate a deterministic QR payload, reconnect/disconnect the channel, and create a test inbound message for Atendimento without external provider credentials.

## Real Evolution Minimum Operation

Only WhatsApp channel setup and Atendimento messaging use real Evolution when real mode is active. Non-WhatsApp modules remain simulated for this minimum operation slice.

Set runtime env values through deployment secrets or local env:

```env
PUBLIC_TALK_URL=https://talk.prymeiradigital.com.br
LOCAL_TALK_URL=http://localhost:3002
EVOLUTION_MODE=real
EVOLUTION_API_BASE_URL=https://wsapi.yrdnegocios.com.br
EVOLUTION_API_KEY=<set in deployment secret>
EVOLUTION_WEBHOOK_SECRET=<set in deployment secret>
```

Cloudflare DNS:

- `CNAME talk -> manager01.prymeiradigital.com.br`
- Proxy status: DNS only

Configure the Evolution instance webhook URLs exactly as:

- Public: `https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace`
- Local: `http://localhost:3002/webhooks/evolution/local_workspace`

Do not commit the Evolution API key or webhook secret. Store both as deployment secrets.

Production Docker/Swarm deployment is documented in `docs/production-deploy.md`.

## Meta WhatsApp Cloud API

Prymeira Talk can run Evolution and official Meta WhatsApp Cloud API channels side by side. Owner and manager users activate Meta in Settings.

Required Meta values for phase 1:

- WABA ID
- Phone Number ID
- Access token
- Webhook verify token
- App Secret

If the official number is already connected inside Evolution API, activate Meta in Settings and choose `Via Evolution`. This mode requires:

- Evolution Base URL
- Evolution API key
- Evolution instance name

Webhook URL:

`https://<talk-domain>/webhooks/meta/<workspaceId>`

Cold outbound Meta sends must use approved templates. Free-text sends are allowed only inside the WhatsApp customer service window.

## Suite Verification Checklist

Run automated verification:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @prymeira-talk/api seed:demo
```

Then open `http://localhost:5176` with `VITE_LOCAL_AUTH_BYPASS=true` and verify:

- every sidebar item opens its module;
- Atendimento keeps the three-panel layout and receives realtime messages/contact context updates;
- Contacts can create/edit contacts and board stage moves update cards;
- Channels can run the simulated QR flow and test inbound action;
- Agentes can create a Secretaria IA, add FAQ knowledge, and appear in Automacoes;
- Automations can run a manual test, show run history, and select Secretaria IA in the "Executar agente" block;
- Atendimento shows AI status and can Assumir or Liberar IA for a conversation;
- Campaigns can resolve recipients and send simulated recipients;
- Reports reflect local conversations, campaigns, automations, channels, departments, and tags;
- CRM creates simulated sync history;
- Settings show integration config and audit log entries.

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

## Reusable Agent Models

The Agents page can validate, import, and export portable agent models. Imports are workspace-scoped and always create an inactive simulated agent for review; exports preserve templates while removing deployment-specific variable values. See [`docs/agent-packages.md`](docs/agent-packages.md) for the format, operating rules, and API routes.

The first compiled business package is the privacy-safe Villefer commercial qualifier V1, derived from four reconstructed WhatsApp histories. See [`docs/villefer-v1-training.md`](docs/villefer-v1-training.md) for its evidence boundary, review checklist, regeneration command, import flow, and laboratory scenarios.
