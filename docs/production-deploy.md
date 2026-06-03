# Prymeira Talk Production Deploy

This deploy expects Portainer using Docker Swarm, Traefik, and the external network `network_swarm_public`.

## DNS

Create this Cloudflare record:

- `CNAME talk -> manager01.prymeiradigital.com.br`
- Proxy status: DNS only

## Required Environment

Create a `.env.production` on the VPS from `.env.production.example` and fill the secret values:

```env
POSTGRES_DB=prymeira_talk
POSTGRES_USER=postgres
PRYMEIRA_TALK_POSTGRES_PASSWORD=<strong database password>

CLERK_SECRET_KEY=<Clerk secret key>
VITE_CLERK_PUBLISHABLE_KEY=<Clerk publishable key>

EVOLUTION_API_KEY=<Evolution API key>
EVOLUTION_WEBHOOK_SECRET=<shared webhook secret>

GHCR_OWNER=yohannreimer
IMAGE_TAG=latest
```

Fixed production URLs in `docker-compose.prod.yml`:

- Talk: `https://talk.prymeiradigital.com.br`
- Account API: `https://hub.prymeiradigital.com.br/api`
- Evolution API: `https://wsapi.yrdnegocios.com.br`
- Public Evolution webhook: `https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace`
- Product key in Prymeira Account: `talk`

## Automatic Image Publish

The repository publishes Docker images automatically with GitHub Actions on every push to the deployment branch. The workflow creates:

```txt
ghcr.io/yohannreimer/prymeira-talk-api:latest
ghcr.io/yohannreimer/prymeira-talk-web:latest
```

Wait until the `Publish Docker images` action finishes successfully before updating the Portainer stack. The frontend image reads `VITE_CLERK_PUBLISHABLE_KEY` from the Portainer stack environment at container startup.

## Deploy With Portainer

Create a Portainer stack from `docker-compose.prod.yml` and set these stack environment variables:

```env
POSTGRES_DB=prymeira_talk
POSTGRES_USER=postgres
PRYMEIRA_TALK_POSTGRES_PASSWORD=<strong database password>
CLERK_SECRET_KEY=<Clerk secret key>
VITE_CLERK_PUBLISHABLE_KEY=<Clerk publishable key>
EVOLUTION_API_KEY=<Evolution API key>
EVOLUTION_WEBHOOK_SECRET=<shared webhook secret>
GHCR_OWNER=yohannreimer
IMAGE_TAG=latest
```

CLI equivalent:

```sh
cp .env.production.example .env.production
nano .env.production

docker stack deploy --with-registry-auth -c docker-compose.prod.yml prymeira_talk
```

The stack follows the same pattern as the other Prymeira apps: only `prymeira_talk_web` is exposed on Traefik, and Nginx forwards `/api/*`, `/webhooks/evolution/*`, and public automation uploads at `/uploads/automations/*` to `prymeira_talk_api` through the internal overlay network.

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
