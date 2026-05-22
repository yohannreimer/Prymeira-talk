# Real Evolution Minimum Operation Design

## Context

Prymeira Talk currently has a useful local/simulated operating bench:

- Channels can create a simulated Evolution channel and QR payload.
- Atendimento persists conversations and messages.
- Evolution inbound webhook already ingests `messages.upsert` into contacts, conversations, messages, and realtime events.
- Outbound messages currently create local `pending` messages instead of sending through a real WhatsApp provider.

The next step is not to make the entire product real. The next step is a narrow real operation slice:

- real Evolution instance creation;
- real WhatsApp QR connection;
- real inbound messages;
- real outbound text messages;
- all other modules remain simulated/local.

The real Evolution API is healthy at `https://wsapi.yrdnegocios.com.br`. The public Talk host will be `https://talk.prymeiradigital.com.br`, with DNS `CNAME talk -> manager01.prymeiradigital.com.br`.

## Goals

1. Let an operator create a new Evolution/WhatsApp instance from the Talk Channels page.
2. Show a real QR code returned by Evolution so the phone can connect normally.
3. Configure the instance webhook to the Talk API automatically.
4. Receive real WhatsApp messages through the existing webhook path.
5. Send outbound text messages from Atendimento through Evolution.
6. Preserve simulated behavior for Automations, IA, CRM, Campaigns, Reports, and local/demo flows.

## Non-Goals

- No WhatsApp Business Cloud implementation.
- No media sending or receiving in this pass.
- No group-message support.
- No campaign real sending.
- No automation real execution.
- No CRM/AI real provider change.
- No full production deployment automation beyond documenting the required DNS/proxy/env shape.
- No secrets committed to git.

## Public URLs

Production/public:

- Web/API host: `https://talk.prymeiradigital.com.br`
- Evolution webhook: `https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace`

Local test:

- Web/API local API: `http://localhost:3002`
- Evolution webhook local test: `http://localhost:3002/webhooks/evolution/local_workspace`

The app should expose or document both webhook URLs, but a real Evolution instance should default to the public URL unless explicitly configured for local testing.

## DNS And Proxy Shape

Cloudflare DNS:

- Type: `CNAME`
- Name: `talk`
- Target: `manager01.prymeiradigital.com.br`
- Proxy: `DNS only`
- TTL: `Auto`

Traefik on `manager01` must route:

- `Host(`talk.prymeiradigital.com.br`)` to the Talk frontend/API deployment.
- Requests under `/webhooks/evolution/*`, `/conversations/*`, `/channels/*`, `/realtime`, and API paths must reach the Talk API.
- The browser app must be served from the same host or configured with `VITE_API_URL=https://talk.prymeiradigital.com.br`.

The implementation will not assume a specific deployment stack for Talk yet, but will add env/config names that fit this routing model.

## Environment

Add backend environment variables:

- `PUBLIC_TALK_URL=https://talk.prymeiradigital.com.br`
- `LOCAL_TALK_URL=http://localhost:3002`
- `EVOLUTION_API_BASE_URL=https://wsapi.yrdnegocios.com.br`
- `EVOLUTION_API_KEY` set from a deployment secret.
- `EVOLUTION_WEBHOOK_SECRET` set from a deployment secret.
- `EVOLUTION_MODE=simulated|real`

Rules:

- `EVOLUTION_API_KEY` must never be committed.
- `.env.example` documents placeholders only.
- If `EVOLUTION_MODE=real` and credentials are present, Canais/Atendimento use Evolution real.
- If real config is missing, existing simulated behavior remains available.

## Evolution Client

Create an API-side Evolution client module responsible for HTTP calls and response normalization.

Minimum methods:

- `createInstance(input)` calls `POST /instance/create`.
- `setWebhook(input)` calls `POST /webhook/set/{instance}` when needed.
- `connectInstance(input)` or equivalent starts/retrieves QR connection depending on Evolution response shape.
- `logoutInstance(input)` or equivalent disconnects an instance if supported by the configured Evolution API.
- `sendText(input)` calls `POST /message/sendText/{instance}`.

Required headers:

- `apikey: EVOLUTION_API_KEY`
- `Content-Type: application/json`

The client should keep parsing permissive enough for Evolution response variations, but strict enough to return clear errors when QR or message identifiers cannot be found.

## Instance Creation And QR Flow

When the operator clicks `Conectar canal` and real mode is active:

1. Talk creates a local channel row first or during the operation.
2. Talk generates a stable unique Evolution instance name:
   - `talk-local_workspace-<short timestamp>` for local workspace.
   - The generated name is stored in `channel.providerKey`.
3. Talk calls `POST /instance/create` with:
   - `instanceName`: generated provider key.
   - `integration`: `WHATSAPP-BAILEYS`.
   - `qrcode`: `true`.
   - webhook config:
     - URL: `PUBLIC_TALK_URL + /webhooks/evolution/{workspaceId}`.
     - events: `QRCODE_UPDATED`, `CONNECTION_UPDATE`, `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `SEND_MESSAGE`.
     - by-events disabled for this pass so all configured events keep hitting the existing single webhook URL.
     - webhook header `x-prymeira-talk-secret: EVOLUTION_WEBHOOK_SECRET` if Evolution supports custom headers in the create call.
4. If create response includes QR payload/base64, Talk returns it to the UI.
5. If create response does not persist webhook config, Talk calls `POST /webhook/set/{instance}` after creation.
6. Local channel status becomes `connecting`.
7. The UI displays the real QR.

If the instance already exists or Evolution returns a conflict, Talk should surface a clear error and avoid creating duplicate local channels unless a channel already maps to that provider key.

## Webhook Inbound Flow

Existing path remains:

`POST /webhooks/evolution/:workspaceId`

Existing secret header remains:

`x-prymeira-talk-secret: EVOLUTION_WEBHOOK_SECRET`

The webhook must handle these real events:

- `MESSAGES_UPSERT` or `messages.upsert` for inbound/outbound message persistence.
- `CONNECTION_UPDATE` for channel status changes.
- `QRCODE_UPDATED` if Evolution sends QR updates after initial creation.
- `MESSAGES_UPDATE` for status changes when practical in this pass.
- `SEND_MESSAGE` for provider send echoes if Evolution emits them.

Minimum required behavior:

- For inbound text messages, upsert contact by phone, upsert conversation, create message, update conversation preview/unread count, publish realtime events.
- For outbound provider echo from `fromMe=true`, store or dedupe by provider message id and update preview without incrementing unread.
- For connection update, update local channel status to `connected`, `connecting`, `disconnected`, or `failed` based on Evolution state mapping.
- Duplicate provider event/message ids return `{ ok: true, duplicate: true }`.

## Outbound Send Flow

When an operator sends a text message in Atendimento:

Simulated mode:

- Keep current behavior: create a local outbound message with `pending` status.

Real mode:

1. Talk finds the conversation with channel and contact.
2. Talk verifies the channel provider is Evolution and has `providerKey`.
3. Talk calls Evolution:
   - `POST /message/sendText/{instance}`
   - recipient number from contact phone.
   - text from the UI body.
4. Talk stores outbound message with:
   - direction `outbound`;
   - status `sent` or `pending` depending on provider response;
   - `providerMessageId` if Evolution returns one;
   - body text.
5. Talk updates conversation preview/time.
6. Talk publishes realtime `message.created` and `conversation.updated`.
7. Later `MESSAGES_UPDATE` or `SEND_MESSAGE` events can refine status.

If Evolution send fails:

- Store no successful outbound message unless the provider response is ambiguous.
- Return a 502-style API error with a safe message for the UI.
- UI shows a normal send error.

## UI Changes

Channels page:

- In real mode, `Conectar canal` creates an Evolution instance and shows the real QR.
- Show provider mode badge: `Real` or `Simulado`.
- Show public webhook URL and local test webhook URL in a compact technical section.
- Keep reconnect/disconnect actions.

Atendimento:

- No major layout change.
- Send button should surface Evolution send failures.
- Existing realtime message updates continue.

Settings/Ajustes:

- Current integration settings can remain simple.
- If practical, show Evolution mode and public webhook URL for operator confidence.

## Testing

Automated tests:

- Evolution client request construction with injected fetch.
- Channels service real-mode create instance path.
- Conversation outbound send real-mode path.
- Webhook connection update mapping.
- Existing webhook message ingestion remains covered.
- Simulated fallback remains covered.

Manual verification with real Evolution:

1. Set env for real mode and Evolution credentials.
2. Open Canais.
3. Click `Conectar canal`.
4. QR appears.
5. Scan QR with WhatsApp.
6. Channel becomes connected from webhook or reconnect check.
7. Send a WhatsApp message to the connected number.
8. Message appears in Atendimento.
9. Reply from Atendimento.
10. Reply arrives on WhatsApp.
11. Automations/IA/CRM/Campaigns remain simulated.

Full verification before completion:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

## Risks

- Evolution response shapes can vary by build. The client must normalize defensively and tests should use realistic fixtures.
- Public webhook requires DNS, TLS, and Traefik routing to be correct before real inbound can work.
- The user shared live-looking credentials in chat; these must not be committed and should be rotated before production use.
- `WEBHOOK_GLOBAL_ENABLED=false` means webhook setup should happen per instance.
- With `webhookByEvents=true`, Evolution can append event paths to the URL. This pass should use a single URL unless tests confirm event-specific URLs are needed.
