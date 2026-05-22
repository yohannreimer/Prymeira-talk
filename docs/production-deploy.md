# Prymeira Talk Production Deploy

This deploy expects Docker Swarm, Traefik, and the external network `network_swarm_public`.

## DNS

Create this Cloudflare record:

- `CNAME talk -> manager01.prymeiradigital.com.br`
- Proxy status: DNS only

## Required Environment

Create a `.env.production` on the VPS from `.env.production.example` and fill the secret values:

```env
POSTGRES_DB=prymeira_talk
POSTGRES_USER=prymeira_talk
POSTGRES_PASSWORD=<strong database password>

CLERK_SECRET_KEY=<Clerk secret key>
VITE_CLERK_PUBLISHABLE_KEY=<Clerk publishable key>

EVOLUTION_API_KEY=<Evolution API key>
EVOLUTION_WEBHOOK_SECRET=<shared webhook secret>

TALK_API_IMAGE=ghcr.io/yohannreimer/prymeira-talk-api:latest
TALK_WEB_IMAGE=ghcr.io/yohannreimer/prymeira-talk-web:latest
```

Fixed production URLs in `docker-compose.prod.yml`:

- Talk: `https://talk.prymeiradigital.com.br`
- Account API: `https://hub.prymeiradigital.com.br/api`
- Evolution API: `https://wsapi.yrdnegocios.com.br`
- Public Evolution webhook: `https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace`

## Build And Deploy On VPS

```sh
git clone https://github.com/yohannreimer/Prymeira-talk.git
cd Prymeira-talk
cp .env.production.example .env.production
nano .env.production

docker compose --env-file .env.production -f docker-compose.prod.yml build
docker stack deploy --with-registry-auth -c docker-compose.prod.yml prymeira_talk
```

If you prefer not to use a registry, keep the build on the Swarm manager where the stack runs.

## Smoke Test

```sh
curl https://talk.prymeiradigital.com.br/api/health
```

Expected response:

```json
{"ok":true,"product":"talk"}
```

Then open `https://talk.prymeiradigital.com.br`, log in with Clerk, go to **Canais**, and click **Conectar canal**.

## Evolution Webhook

The app configures the instance webhook when QR starts. The webhook endpoint is:

```txt
https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace
```

The header configured by the app is:

```txt
x-prymeira-talk-secret: <EVOLUTION_WEBHOOK_SECRET>
```
