# Meta Evolution Auto Webhook Design

## Goal

When an operator creates a `meta_cloud` channel for an official Meta number connected through Evolution API, Prymeira Talk should configure the Evolution instance webhook automatically.

## Behavior

The normal Evolution QR flow already configures webhooks when QR starts. Official Meta via Evolution channels do not use QR, so the webhook setup runs during channel creation instead.

When Settings has active `connectionMode: "evolution_official"`, the channel creation route resolves the workspace's Evolution API credentials and passes a webhook setup client to the channel service. The service creates the channel, then calls:

`POST /webhook/set/{instanceName}`

with the production Evolution webhook URL from `PUBLIC_TALK_URL`, the `EVOLUTION_WEBHOOK_SECRET` header, and the same event list used by normal Evolution channels.

## Failure Handling

If Evolution rejects the webhook setup, the channel remains created but is marked `failed`. The frontend tells the user that the channel was created but webhook setup failed, so they can fix Evolution manually without losing the channel record.

## Production Requirements

Production must set:

- `PUBLIC_TALK_URL`
- `EVOLUTION_WEBHOOK_SECRET`

The workspace Meta via Evolution settings must also include:

- Evolution Base URL
- Evolution API key
- Evolution instance name

The channel provider key remains the specific instance name for that official number.
