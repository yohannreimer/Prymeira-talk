# Real Evolution Minimum Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn only Canais and Atendimento into a real Evolution/WhatsApp operation while keeping the rest of the product simulated/local.

**Architecture:** Add a small Evolution runtime layer to the API, then inject it into channel and conversation routes. Channels creates real Evolution instances with QR and webhook configuration; Conversations sends outbound text through Evolution in real mode; the existing Evolution webhook is extended to handle connection/status events.

**Tech Stack:** Fastify, Prisma, TypeScript, Zod, Vitest, existing React/Vite web app, Evolution API v2 at `https://wsapi.yrdnegocios.com.br`.

---

## File Structure

- Create `apps/api/src/modules/evolution/evolution.client.ts`: HTTP client for Evolution API calls and response normalization.
- Create `apps/api/src/modules/evolution/evolution.client.test.ts`: unit tests with injected fetch.
- Create `apps/api/src/modules/evolution/evolution-runtime.ts`: env-to-runtime config helper for real vs simulated mode.
- Modify `apps/api/src/env.ts`: add public/local Talk URLs and Evolution real-mode env fields.
- Modify `.env.example`: document env values for public URL, local URL, real mode, API base URL, API key, and webhook secret.
- Modify `apps/api/src/app.ts`: create Evolution runtime and pass it into channel and conversation routes.
- Modify `apps/api/src/modules/channels/channels.routes.ts`: accept Evolution runtime options and pass to service.
- Modify `apps/api/src/modules/channels/channels.service.ts`: create real Evolution instance/QR/webhook in real mode, keep simulated fallback.
- Modify `apps/api/src/modules/channels/channels.service.test.ts`: cover real create/QR behavior and simulated fallback.
- Modify `apps/api/src/modules/conversations/conversations.routes.ts`: accept Evolution runtime options and pass to service.
- Modify `apps/api/src/modules/conversations/conversations.service.ts`: send outbound text through Evolution in real mode.
- Modify `apps/api/src/modules/conversations/conversations.service.test.ts`: cover real outbound send and existing simulated send.
- Modify `apps/api/src/modules/evolution/evolution.schemas.ts`: parse uppercase and lowercase Evolution event names plus connection update payloads.
- Modify `apps/api/src/modules/evolution/evolution.routes.ts`: handle `CONNECTION_UPDATE`, `QRCODE_UPDATED`, and message status update events without breaking existing message ingestion.
- Modify `apps/api/src/modules/evolution/evolution.routes.test.ts`: cover connection update and uppercase event handling.
- Modify `apps/web/src/features/channels/ChannelsPage.tsx`: show real/simulated mode and webhook URLs in the Channels UI.
- Modify `apps/web/src/app/api.ts`: keep the existing optional QR/mode response fields typed for the Channels UI.
- Modify `apps/web/src/styles.css`: add compact channel technical info styles.
- Modify `README.md`: document DNS, Traefik route shape, secrets, and local webhook URL.

## Task 1: Environment And Runtime Config

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`
- Create: `apps/api/src/modules/evolution/evolution-runtime.ts`
- Test: `apps/api/src/modules/evolution/evolution.client.test.ts`

- [ ] **Step 1: Add failing runtime config tests**

Create `apps/api/src/modules/evolution/evolution.client.test.ts` with the first tests for runtime config:

```ts
import { describe, expect, it } from "vitest";
import { createEvolutionRuntime } from "./evolution-runtime.js";

describe("createEvolutionRuntime", () => {
  it("uses simulated mode when EVOLUTION_MODE is simulated", () => {
    const runtime = createEvolutionRuntime({
      mode: "simulated",
      publicTalkUrl: "https://talk.prymeiradigital.com.br",
      localTalkUrl: "http://localhost:3002",
      apiBaseUrl: undefined,
      apiKey: undefined,
      webhookSecret: "replace_me"
    });

    expect(runtime.mode).toBe("simulated");
    expect(runtime.publicWebhookUrl("local_workspace")).toBe(
      "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace"
    );
    expect(runtime.localWebhookUrl("local_workspace")).toBe(
      "http://localhost:3002/webhooks/evolution/local_workspace"
    );
    expect(runtime.client).toBeNull();
  });

  it("creates a real client only when real mode has base url and api key", () => {
    const runtime = createEvolutionRuntime({
      mode: "real",
      publicTalkUrl: "https://talk.prymeiradigital.com.br",
      localTalkUrl: "http://localhost:3002",
      apiBaseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      webhookSecret: "webhook-secret"
    });

    expect(runtime.mode).toBe("real");
    expect(runtime.client).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.client.test.ts
```

Expected: FAIL because `evolution-runtime.js` does not exist.

- [ ] **Step 3: Implement env schema**

In `apps/api/src/env.ts`, add this helper near the schema:

```ts
const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);
```

Then extend `envSchema`:

```ts
  PUBLIC_TALK_URL: z.string().url().default("https://talk.prymeiradigital.com.br"),
  LOCAL_TALK_URL: z.string().url().default("http://localhost:3002"),
  EVOLUTION_MODE: z.enum(["simulated", "real"]).default("simulated"),
  EVOLUTION_API_BASE_URL: optionalUrl,
  EVOLUTION_API_KEY: optionalNonEmptyString,
```

Keep `EVOLUTION_WEBHOOK_SECRET` required.

- [ ] **Step 4: Implement runtime helper**

Create `apps/api/src/modules/evolution/evolution-runtime.ts`:

```ts
import { createEvolutionClient, type EvolutionClient } from "./evolution.client.js";

export interface EvolutionRuntimeInput {
  mode: "simulated" | "real";
  publicTalkUrl: string;
  localTalkUrl: string;
  apiBaseUrl?: string;
  apiKey?: string;
  webhookSecret: string;
  fetch?: typeof fetch;
}

export interface EvolutionRuntime {
  mode: "simulated" | "real";
  webhookSecret: string;
  publicWebhookUrl(workspaceId: string): string;
  localWebhookUrl(workspaceId: string): string;
  client: EvolutionClient | null;
}

function webhookUrl(baseUrl: string, workspaceId: string) {
  return `${baseUrl.replace(/\/$/, "")}/webhooks/evolution/${workspaceId}`;
}

export function createEvolutionRuntime(input: EvolutionRuntimeInput): EvolutionRuntime {
  const realClient =
    input.mode === "real" && input.apiBaseUrl && input.apiKey
      ? createEvolutionClient({
          baseUrl: input.apiBaseUrl,
          apiKey: input.apiKey,
          fetch: input.fetch
        })
      : null;

  return {
    mode: realClient ? "real" : "simulated",
    webhookSecret: input.webhookSecret,
    publicWebhookUrl: (workspaceId) => webhookUrl(input.publicTalkUrl, workspaceId),
    localWebhookUrl: (workspaceId) => webhookUrl(input.localTalkUrl, workspaceId),
    client: realClient
  };
}
```

- [ ] **Step 5: Add `.env.example` values**

Update `.env.example` with:

```env
PUBLIC_TALK_URL=https://talk.prymeiradigital.com.br
LOCAL_TALK_URL=http://localhost:3002
EVOLUTION_MODE=simulated
EVOLUTION_API_BASE_URL=https://wsapi.yrdnegocios.com.br
EVOLUTION_API_KEY=
```

Do not add a real API key.

- [ ] **Step 6: Run test to verify runtime passes**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.client.test.ts
```

Expected: runtime tests pass or fail only because the client module does not exist yet. If the client module is missing, continue to Task 2.

## Task 2: Evolution HTTP Client

**Files:**
- Create: `apps/api/src/modules/evolution/evolution.client.ts`
- Modify: `apps/api/src/modules/evolution/evolution.client.test.ts`

- [ ] **Step 1: Add failing client request tests**

Append to `apps/api/src/modules/evolution/evolution.client.test.ts`:

```ts
import { createEvolutionClient } from "./evolution.client.js";

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Evolution client", () => {
  it("creates an instance with QR and webhook config", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        instance: { instanceName: "talk-local_workspace-abc" },
        qrcode: { code: "2@qr-code" }
      })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.createInstance({
      instanceName: "talk-local_workspace-abc",
      webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace",
      webhookSecret: "webhook-secret"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/instance/create",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: "secret-key" })
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        instanceName: "talk-local_workspace-abc",
        integration: "WHATSAPP-BAILEYS",
        qrcode: true
      })
    );
    expect(result.qrCode).toBe("2@qr-code");
  });

  it("sends a text message and returns the provider message id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({ key: { id: "provider_msg_1" } })
    );
    const client = createEvolutionClient({
      baseUrl: "https://wsapi.yrdnegocios.com.br",
      apiKey: "secret-key",
      fetch: fetchMock
    });

    const result = await client.sendText({
      instanceName: "talk-local_workspace-abc",
      number: "5547999990000",
      text: "Oi"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://wsapi.yrdnegocios.com.br/message/sendText/talk-local_workspace-abc",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.providerMessageId).toBe("provider_msg_1");
  });
});
```

Also add `vi` to the Vitest import if missing:

```ts
import { describe, expect, it, vi } from "vitest";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.client.test.ts
```

Expected: FAIL because `createEvolutionClient` is not implemented.

- [ ] **Step 3: Implement client**

Create `apps/api/src/modules/evolution/evolution.client.ts`:

```ts
export class EvolutionClientError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "EvolutionClientError";
  }
}

export interface EvolutionClient {
  createInstance(input: {
    instanceName: string;
    webhookUrl: string;
    webhookSecret: string;
  }): Promise<{ instanceName: string; qrCode: string | null; raw: unknown }>;
  setWebhook(input: {
    instanceName: string;
    webhookUrl: string;
    webhookSecret: string;
  }): Promise<void>;
  sendText(input: {
    instanceName: string;
    number: string;
    text: string;
  }): Promise<{ providerMessageId: string | null; raw: unknown }>;
}

interface CreateEvolutionClientInput {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

const webhookEvents = [
  "QRCODE_UPDATED",
  "CONNECTION_UPDATE",
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "SEND_MESSAGE"
];

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function readStringPath(data: unknown, path: string[]) {
  let current: unknown = data;

  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : null;
}

function extractQrCode(data: unknown) {
  return (
    readStringPath(data, ["qrcode", "code"]) ??
    readStringPath(data, ["qrcode", "base64"]) ??
    readStringPath(data, ["base64"]) ??
    readStringPath(data, ["code"]) ??
    null
  );
}

function extractProviderMessageId(data: unknown) {
  return (
    readStringPath(data, ["key", "id"]) ??
    readStringPath(data, ["message", "key", "id"]) ??
    readStringPath(data, ["messageId"]) ??
    readStringPath(data, ["id"]) ??
    null
  );
}

export function createEvolutionClient(input: CreateEvolutionClientInput): EvolutionClient {
  const fetchImpl = input.fetch ?? fetch;

  async function request(path: string, body: unknown) {
    const response = await fetchImpl(joinUrl(input.baseUrl, path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: input.apiKey
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new EvolutionClientError(response.status, "Evolution API request failed.");
    }

    return data;
  }

  return {
    async createInstance(instanceInput) {
      const data = await request("/instance/create", {
        instanceName: instanceInput.instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        webhook: {
          url: instanceInput.webhookUrl,
          byEvents: false,
          base64: true,
          headers: {
            "x-prymeira-talk-secret": instanceInput.webhookSecret,
            "Content-Type": "application/json"
          },
          events: webhookEvents
        }
      });

      return {
        instanceName: instanceInput.instanceName,
        qrCode: extractQrCode(data),
        raw: data
      };
    },

    async setWebhook(webhookInput) {
      await request(`/webhook/set/${encodeURIComponent(webhookInput.instanceName)}`, {
        enabled: true,
        url: webhookInput.webhookUrl,
        webhookByEvents: false,
        webhookBase64: true,
        events: webhookEvents,
        headers: {
          "x-prymeira-talk-secret": webhookInput.webhookSecret,
          "Content-Type": "application/json"
        }
      });
    },

    async sendText(messageInput) {
      const data = await request(`/message/sendText/${encodeURIComponent(messageInput.instanceName)}`, {
        number: messageInput.number,
        text: messageInput.text
      });

      return {
        providerMessageId: extractProviderMessageId(data),
        raw: data
      };
    }
  };
}
```

- [ ] **Step 4: Run client tests**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.client.test.ts
```

Expected: PASS.

## Task 3: Wire Runtime Into App And Routes

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/channels/channels.routes.ts`
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`

- [ ] **Step 1: Add runtime wiring**

In `apps/api/src/app.ts`, import:

```ts
import { createEvolutionRuntime } from "./modules/evolution/evolution-runtime.js";
```

Inside `createApp`, before route registration:

```ts
  const evolutionRuntime = createEvolutionRuntime({
    mode: env.EVOLUTION_MODE,
    publicTalkUrl: env.PUBLIC_TALK_URL,
    localTalkUrl: env.LOCAL_TALK_URL,
    apiBaseUrl: env.EVOLUTION_API_BASE_URL,
    apiKey: env.EVOLUTION_API_KEY,
    webhookSecret: env.EVOLUTION_WEBHOOK_SECRET
  });
```

Change route registration:

```ts
  await app.register(conversationsRoutes, { evolution: evolutionRuntime });
  await app.register(channelsRoutes, { evolution: evolutionRuntime });
```

- [ ] **Step 2: Update channels route options**

In `channels.routes.ts`, add:

```ts
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";

interface ChannelsRoutesOptions {
  evolution?: EvolutionRuntime;
}
```

Change plugin signature:

```ts
export const channelsRoutes: FastifyPluginAsync<ChannelsRoutesOptions> = async (app, options) => {
  const service = createChannelsService(app.prisma as unknown as PrismaLike, {
    evolution: options.evolution
  });
```

- [ ] **Step 3: Update conversations route options**

In `conversations.routes.ts`, add:

```ts
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";

interface ConversationsRoutesOptions {
  evolution?: EvolutionRuntime;
}
```

Change plugin signature:

```ts
export const conversationsRoutes: FastifyPluginAsync<ConversationsRoutesOptions> = async (app, options) => {
  const service = createConversationsService(app.prisma as unknown as PrismaLike, {
    evolution: options.evolution
  });
```

- [ ] **Step 4: Run API typecheck**

Run:

```bash
pnpm --filter @prymeira-talk/api typecheck
```

Expected: PASS or fail only because services do not accept options yet. Continue to Task 4 and Task 6.

## Task 4: Real Channel Instance And QR Flow

**Files:**
- Modify: `apps/api/src/modules/channels/channels.service.ts`
- Modify: `apps/api/src/modules/channels/channels.service.test.ts`

- [ ] **Step 1: Add failing real QR service test**

Append to `channels.service.test.ts`:

```ts
it("creates a real Evolution instance and returns its QR when real runtime is active", async () => {
  const createInstance = vi.fn().mockResolvedValue({
    instanceName: "talk-workspace_a-abc",
    qrCode: "2@real-qr",
    raw: {}
  });
  const setWebhook = vi.fn().mockResolvedValue(undefined);
  const prisma = createMockPrisma({
    channel: {
      ...createMockPrisma().channel,
      create: vi.fn().mockResolvedValue({
        ...baseChannel,
        providerKey: "talk-workspace_a-abc",
        status: "connecting"
      })
    }
  });
  const service = createChannelsService(prisma, {
    evolution: {
      mode: "real",
      webhookSecret: "webhook-secret",
      publicWebhookUrl: () => "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
      localWebhookUrl: () => "http://localhost:3002/webhooks/evolution/workspace_a",
      client: { createInstance, setWebhook, sendText: vi.fn() }
    }
  });

  const result = await service.createChannel({
    workspaceId: "workspace_a",
    displayName: "WhatsApp Comercial"
  });

  expect(createInstance).toHaveBeenCalledWith({
    instanceName: expect.stringMatching(/^talk-workspace_a-/),
    webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
    webhookSecret: "webhook-secret"
  });
  expect(setWebhook).toHaveBeenCalled();
  expect(result.status).toBe("connecting");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- channels.service.test.ts
```

Expected: FAIL because `createChannelsService` does not accept Evolution runtime options and real create is not implemented.

- [ ] **Step 3: Extend service constructor**

In `channels.service.ts`, import runtime type:

```ts
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
```

Change factory signature:

```ts
export function createChannelsService(
  prisma: PrismaLike,
  options: { evolution?: EvolutionRuntime } = {}
) {
```

Add helper:

```ts
function createInstanceName(workspaceId: string) {
  return `talk-${workspaceId}-${Date.now().toString(36)}`;
}
```

- [ ] **Step 4: Implement real create channel**

Inside `createChannel`, before the existing simulated provider key block:

```ts
      if (options.evolution?.mode === "real" && options.evolution.client) {
        const providerKey = normalizeOptional(input.providerKey) ?? createInstanceName(input.workspaceId);
        const webhookUrl = options.evolution.publicWebhookUrl(input.workspaceId);
        const instance = await options.evolution.client.createInstance({
          instanceName: providerKey,
          webhookUrl,
          webhookSecret: options.evolution.webhookSecret
        });
        await options.evolution.client.setWebhook({
          instanceName: providerKey,
          webhookUrl,
          webhookSecret: options.evolution.webhookSecret
        });
        const channel = await prisma.channel.create({
          data: {
            workspaceId: input.workspaceId,
            provider: "evolution",
            providerKey: instance.instanceName,
            displayName: input.displayName.trim(),
            phoneNumber: normalizeOptional(input.phoneNumber) ?? null,
            status: "connecting"
          }
        });

        return toChannelDto(channel);
      }
```

Keep existing simulated behavior after this block.

- [ ] **Step 5: Run channel tests**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- channels.service.test.ts
```

Expected: PASS for existing simulated tests and new real create test.

## Task 5: QR Session In Real Mode

**Files:**
- Modify: `apps/api/src/modules/channels/channels.service.ts`
- Modify: `apps/api/src/modules/channels/channels.service.test.ts`

- [ ] **Step 1: Add failing real start QR test**

Append:

```ts
it("returns real QR from Evolution for an existing real channel", async () => {
  const createInstance = vi.fn().mockResolvedValue({
    instanceName: "demo-evolution",
    qrCode: "2@real-qr",
    raw: {}
  });
  const prisma = createMockPrisma();
  const service = createChannelsService(prisma, {
    evolution: {
      mode: "real",
      webhookSecret: "webhook-secret",
      publicWebhookUrl: () => "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
      localWebhookUrl: () => "http://localhost:3002/webhooks/evolution/workspace_a",
      client: { createInstance, setWebhook: vi.fn(), sendText: vi.fn() }
    }
  });

  const result = await service.startQrSession({ workspaceId: "workspace_a", channelId });

  expect(createInstance).toHaveBeenCalledWith({
    instanceName: "demo-evolution",
    webhookUrl: "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
    webhookSecret: "webhook-secret"
  });
  expect(result.mode).toBe("real");
  expect(result.qrCode).toBe("2@real-qr");
});
```

- [ ] **Step 2: Implement real QR session**

In `startQrSession`, load the channel when real mode is active:

```ts
      if (options.evolution?.mode === "real" && options.evolution.client) {
        const existingChannel = await prisma.channel.findFirst({
          where: { workspaceId: input.workspaceId, id: input.channelId }
        });

        if (!existingChannel) {
          throw new ChannelsServiceError("CHANNEL_NOT_FOUND", "Channel not found.");
        }

        const webhookUrl = options.evolution.publicWebhookUrl(input.workspaceId);
        const instance = await options.evolution.client.createInstance({
          instanceName: existingChannel.providerKey,
          webhookUrl,
          webhookSecret: options.evolution.webhookSecret
        });
        const channel = await updateChannelStatus({ ...input, status: "connecting" });

        return {
          mode: "real",
          channel: toChannelDto(channel),
          qrCode: instance.qrCode ?? "",
          qr: {
            payload: instance.qrCode ?? "",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
          }
        };
      }
```

Keep simulated path unchanged.

- [ ] **Step 3: Run channel tests**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- channels.service.test.ts
```

Expected: PASS.

## Task 6: Real Outbound Send

**Files:**
- Modify: `apps/api/src/modules/conversations/conversations.service.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.test.ts`

- [ ] **Step 1: Add failing real outbound test**

Add a test in `conversations.service.test.ts` near the pending outbound tests:

```ts
it("sends outbound text through Evolution in real mode", async () => {
  const sendText = vi.fn().mockResolvedValue({ providerMessageId: "provider_msg_1", raw: {} });
  const prisma = createMockPrisma({
    findUnique: vi.fn<PrismaLike["conversation"]["findUnique"]>()
      .mockResolvedValueOnce({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        channel: { provider: "evolution", providerKey: "talk-workspace_a-abc" },
        contact: { phone: "5547999990000" }
      })
      .mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: "contact_1",
        status: "open",
        assignedUserId: null,
        departmentId: null,
        lastMessageAt: null,
        lastMessagePreview: "Oi real",
        unreadCount: 0,
        priority: "normal"
      }),
    create: vi.fn<PrismaLike["message"]["create"]>().mockResolvedValue({
      id: "msg_1",
      workspaceId: "workspace_a",
      conversationId: "conv_1",
      providerMessageId: "provider_msg_1",
      direction: "outbound",
      type: "text",
      body: "Oi real",
      mediaUrl: null,
      status: "sent",
      sentByUserId: "user_1",
      createdAt: new Date("2026-05-22T12:00:00.000Z")
    })
  });
  const service = createConversationsService(prisma, {
    evolution: {
      mode: "real",
      webhookSecret: "webhook-secret",
      publicWebhookUrl: () => "",
      localWebhookUrl: () => "",
      client: { createInstance: vi.fn(), setWebhook: vi.fn(), sendText }
    }
  });

  const result = await service.createPendingOutboundMessage({
    workspaceId: "workspace_a",
    conversationId: "conv_1",
    body: "Oi real",
    sentByUserId: "user_1"
  });

  expect(sendText).toHaveBeenCalledWith({
    instanceName: "talk-workspace_a-abc",
    number: "5547999990000",
    text: "Oi real"
  });
  expect(result.message.status).toBe("sent");
  expect(result.message.providerMessageId).toBe("provider_msg_1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- conversations.service.test.ts
```

Expected: FAIL because conversation service does not accept Evolution runtime options or send through Evolution.

- [ ] **Step 3: Extend service constructor and preflight select**

In `conversations.service.ts`, import runtime type:

```ts
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
```

Change factory signature:

```ts
export function createConversationsService(
  prisma: PrismaLike,
  options: { evolution?: EvolutionRuntime } = {}
) {
```

Extend the local `ConversationRecord` type so the preflight query has the data needed for real sending:

```ts
  channel?: {
    displayName?: string | null;
    phoneNumber?: string | null;
    provider?: string;
    providerKey?: string;
  } | null;
  contact?: {
    name?: string | null;
    phone?: string | null;
  } | null;
```

In `createPendingOutboundMessage`, change the preflight query from:

```ts
select: { id: true }
```

to:

```ts
select: {
  id: true,
  channel: { select: { provider: true, providerKey: true } },
  contact: { select: { phone: true } }
}
```

- [ ] **Step 4: Send through Evolution in real mode**

Before creating the message:

```ts
      let providerSend: { providerMessageId: string | null } | null = null;

      if (
        options.evolution?.mode === "real" &&
        options.evolution.client &&
        conversation.channel?.provider === "evolution"
      ) {
        const contactPhone = conversation.contact?.phone?.trim();
        if (!contactPhone) {
          throw new ConversationsServiceError(
            "VALIDATION_ERROR",
            "Contact phone is required to send through Evolution."
          );
        }

        if (!conversation.channel.providerKey) {
          throw new ConversationsServiceError(
            "VALIDATION_ERROR",
            "Evolution provider key is required to send through Evolution."
          );
        }

        providerSend = await options.evolution.client.sendText({
          instanceName: conversation.channel.providerKey,
          number: contactPhone,
          text: input.body
        });
      }
```

Set message fields:

```ts
          providerMessageId: providerSend?.providerMessageId ?? undefined,
          status: providerSend ? "sent" : "pending",
```

Keep simulated behavior `pending` when no real runtime exists.

- [ ] **Step 5: Run conversation tests**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- conversations.service.test.ts
```

Expected: PASS.

## Task 7: Webhook Connection Updates

**Files:**
- Modify: `apps/api/src/modules/evolution/evolution.schemas.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.test.ts`

- [ ] **Step 1: Add failing webhook test for connection update**

In `evolution.routes.test.ts`, add:

```ts
it("updates channel status from CONNECTION_UPDATE events", async () => {
  const channelUpdate = vi.fn().mockResolvedValue({
    id: "channel_1",
    workspaceId: "workspace_a",
    provider: "evolution",
    providerKey: "client-one",
    phoneNumber: null,
    displayName: "Client One",
    status: "connected",
    createdAt: new Date("2026-05-20T10:00:00.000Z"),
    updatedAt: new Date("2026-05-20T10:05:00.000Z")
  });
  const { app, publish } = await buildApp({
    channel: {
      findUnique: vi.fn().mockResolvedValue({ id: "channel_1" }),
      update: channelUpdate
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution/workspace_a",
      headers: { "x-prymeira-talk-secret": "top_secret" },
      payload: {
        event: "CONNECTION_UPDATE",
        instance: "client-one",
        data: { state: "open" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(channelUpdate).toHaveBeenCalledWith({
      where: {
        workspaceId_provider_providerKey: {
          workspaceId: "workspace_a",
          provider: "evolution",
          providerKey: "client-one"
        }
      },
      data: { status: "connected" }
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "channel.updated" }));
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.routes.test.ts
```

Expected: FAIL because connection update is ignored.

- [ ] **Step 3: Extend schemas**

In `evolution.schemas.ts`, add:

```ts
export const evolutionConnectionUpdateSchema = evolutionWebhookEnvelopeSchema.extend({
  data: z
    .object({
      state: z.string().optional(),
      status: z.string().optional()
    })
    .passthrough()
    .optional()
});
```

- [ ] **Step 4: Implement status mapping**

In `channels.service.ts`, export `toChannelDto`:

```ts
export function toChannelDto(channel: ChannelRecord): ChannelDto {
```

In `evolution.routes.ts`, import it:

```ts
import { toChannelDto } from "../channels/channels.service.js";
```

Then add helpers:

```ts
function normalizeEvolutionEvent(event: string) {
  return event.toLowerCase().replace(/_/g, ".");
}

function mapConnectionState(state: string | undefined) {
  if (state === "open" || state === "connected") return "connected";
  if (state === "connecting") return "connecting";
  if (state === "close" || state === "closed" || state === "disconnected") return "disconnected";
  return "failed";
}
```

Before the current `messages.upsert` branch:

```ts
    const normalizedEvent = normalizeEvolutionEvent(envelope.data.event);

    if (normalizedEvent === "connection.update") {
      const connection = evolutionConnectionUpdateSchema.safeParse(request.body);
      if (!connection.success) {
        return reply.code(400).send({ ok: false, error: "invalid_webhook_payload" });
      }

      const status = mapConnectionState(connection.data.data?.state ?? connection.data.data?.status);
      const channel = await app.prisma.channel.update({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: params.data.workspaceId,
            provider: "evolution",
            providerKey: connection.data.instance
          }
        },
        data: { status }
      });

      app.realtime.publish({
        type: "channel.updated",
        workspaceId: params.data.workspaceId,
        payload: toChannelDto(channel)
      });

      return { ok: true };
    }

    if (normalizedEvent !== "messages.upsert") {
      return { ok: true, ignored: true };
    }
```

- [ ] **Step 5: Run webhook tests**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.routes.test.ts
```

Expected: PASS.

## Task 8: Channels UI Real Mode Visibility

**Files:**
- Modify: `apps/web/src/features/channels/ChannelsPage.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/app/api.ts`

- [ ] **Step 1: Add technical info block**

In `ChannelsPage.tsx`, derive:

```tsx
const publicWebhookUrl = "https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace";
const localWebhookUrl = "http://localhost:3002/webhooks/evolution/local_workspace";
```

Add below notices:

```tsx
<div className="channel-technical-strip">
  <span className="status-badge status-badge--bot">
    Evolution {qrResult?.mode === "real" ? "Real" : "Simulado"}
  </span>
  <code>{publicWebhookUrl}</code>
  <code>{localWebhookUrl}</code>
</div>
```

- [ ] **Step 2: Add CSS**

In `styles.css`:

```css
.channel-technical-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0 16px;
  overflow-x: auto;
}

.channel-technical-strip code {
  flex: 0 0 auto;
  padding: 6px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
  font-size: 11px;
}
```

- [ ] **Step 3: Run web typecheck**

Run:

```bash
pnpm --filter @prymeira-talk/web typecheck
```

Expected: PASS.

## Task 9: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add real Evolution env docs**

Add a section:

````md
## Real Evolution Minimum Operation

For the minimum real WhatsApp slice, keep non-WhatsApp modules simulated and set:

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

Evolution instance webhook:

- Public: `https://talk.prymeiradigital.com.br/webhooks/evolution/local_workspace`
- Local test: `http://localhost:3002/webhooks/evolution/local_workspace`
````

Replace `<set in deployment secret>` with a phrase, not a real secret.

- [ ] **Step 2: Run markdown-safe grep**

Run:

```bash
rg -i 'ma''ria[0-9]+|se''nh[a-z]*' README.md .env.example docs/superpowers/specs docs/superpowers/plans
```

Expected: no output.

## Task 10: Full Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run API targeted tests**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.client.test.ts channels.service.test.ts conversations.service.test.ts evolution.routes.test.ts
```

Expected: all targeted API tests pass.

- [ ] **Step 2: Run full tests**

Run:

```bash
pnpm test
```

Expected: all workspace tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: all workspace typechecks pass.

- [ ] **Step 4: Run build**

Run:

```bash
pnpm build
```

Expected: all workspace builds pass.

- [ ] **Step 5: Manual real verification checklist**

With real env set and API/Web running:

1. Open `http://localhost:5176/?module=canais`.
2. Click `Conectar canal`.
3. Confirm a QR appears from Evolution.
4. Scan QR in WhatsApp.
5. Confirm channel updates to connected through `CONNECTION_UPDATE`.
6. Send a WhatsApp message to the connected number.
7. Confirm message appears in Atendimento.
8. Reply in Atendimento.
9. Confirm reply arrives in WhatsApp.
10. Confirm Automações, IA, CRM, Campanhas, and Relatórios remain simulated/local.

- [ ] **Step 6: Commit implementation**

Run:

```bash
git add .env.example README.md apps/api/src/env.ts apps/api/src/app.ts apps/api/src/modules/evolution/evolution-runtime.ts apps/api/src/modules/evolution/evolution.client.ts apps/api/src/modules/evolution/evolution.client.test.ts apps/api/src/modules/evolution/evolution.schemas.ts apps/api/src/modules/evolution/evolution.routes.ts apps/api/src/modules/evolution/evolution.routes.test.ts apps/api/src/modules/channels/channels.routes.ts apps/api/src/modules/channels/channels.service.ts apps/api/src/modules/channels/channels.service.test.ts apps/api/src/modules/conversations/conversations.routes.ts apps/api/src/modules/conversations/conversations.service.ts apps/api/src/modules/conversations/conversations.service.test.ts apps/web/src/features/channels/ChannelsPage.tsx apps/web/src/styles.css docs/superpowers/plans/2026-05-22-real-evolution-minimum-operation.md
git commit -m "feat: enable real evolution minimum operation"
```

Expected: commit succeeds and no real secrets are staged.
