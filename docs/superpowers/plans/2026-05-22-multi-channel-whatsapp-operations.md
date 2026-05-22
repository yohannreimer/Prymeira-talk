# Multi-Channel WhatsApp Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prymeira Talk support multiple WhatsApp chips/channels per workspace, with QR reconnect, delete, channel filtering in Atendimento, and better contact display.

**Architecture:** Keep the existing Channel and Conversation models. Strengthen channel lifecycle operations in the API, keep Evolution provider keys technical and hidden, and add frontend helpers so the UI can create new channels, reconnect with QR, delete channels, and filter loaded conversations by channel without overbuilding client ownership yet.

**Tech Stack:** Fastify, Prisma, Zod, shared DTO schemas, React 19, Vite, Vitest.

---

## File Structure

- Modify `apps/api/src/modules/channels/channels.service.ts`
  - Generate stronger unique provider keys.
  - Add `deleteChannel`.
  - Keep `startQrSession` as the QR source for connect and reconnect.
- Modify `apps/api/src/modules/channels/channels.routes.ts`
  - Add `DELETE /channels/:channelId`.
  - Publish a channel deletion realtime event.
- Modify `apps/api/src/modules/channels/channels.service.test.ts`
  - Cover unique provider keys and delete route behavior.
- Modify `packages/shared/src/realtime.ts`
  - Add `channel.deleted` event schema.
- Modify `apps/api/src/modules/evolution/evolution.routes.ts`
  - Extract push names from incoming Evolution payloads.
  - Preserve saved contact names while filling empty names.
- Modify `apps/api/src/modules/evolution/evolution.routes.test.ts`
  - Cover push-name ingestion and preserving local contact names.
- Modify `apps/web/src/app/api.ts`
  - Add `apiDeleteChannel`.
  - Reuse `apiStartChannelQr` for reconnect UI behavior.
- Modify `apps/web/src/app/api.test.ts`
  - Cover delete channel API request shape with a stubbed `fetch`.
- Modify `apps/web/src/features/channels/ChannelsPage.tsx`
  - Add new-channel drawer/form.
  - Change primary action to create a new channel then start QR.
  - Change reconnect to start QR for the chosen existing channel.
  - Add delete action with confirmation.
  - Hide provider key from normal row display.
- Create `apps/web/src/features/inbox/conversation-display.ts`
  - Pure helpers for contact display, channel filter options, and filtered conversations.
- Create `apps/web/src/features/inbox/conversation-display.test.ts`
  - Cover phone fallback and channel filtering.
- Modify `apps/web/src/features/inbox/InboxPage.tsx`
  - Add channel filter chips.
  - Use helper for visible conversations and contact display.
  - Show `via <channelName>` on conversation cards.
- Modify `apps/web/src/styles.css`
  - Add compact styles for channel form, delete button, and inbox channel filters.

---

### Task 0: Settle Existing Evolution License Error Changes

**Files:**
- Existing modified files:
  - `apps/api/src/modules/channels/channels.service.test.ts`
  - `apps/api/src/modules/channels/channels.service.ts`
  - `apps/api/src/modules/evolution/evolution.client.ts`
  - `apps/web/src/app/api.test.ts`
  - `apps/web/src/app/api.ts`

- [ ] **Step 1: Inspect current dirty diff**

Run:

```bash
git status --short
git diff -- apps/api/src/modules/channels/channels.service.ts apps/api/src/modules/evolution/evolution.client.ts apps/web/src/app/api.ts
```

Expected: only the Evolution `LICENSE_REQUIRED` mapping and frontend structured error message changes are present.

- [ ] **Step 2: Verify existing dirty changes**

Run:

```bash
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web test
pnpm --filter @prymeira-talk/api build
pnpm --filter @prymeira-talk/web build
```

Expected:

```text
api: 16 test files pass, 152 tests pass
web: 5 test files pass, 17 tests pass
api build exits 0
web build exits 0
```

- [ ] **Step 3: Commit the Evolution license error handling separately**

Run:

```bash
git add apps/api/src/modules/channels/channels.service.test.ts \
  apps/api/src/modules/channels/channels.service.ts \
  apps/api/src/modules/evolution/evolution.client.ts \
  apps/web/src/app/api.test.ts \
  apps/web/src/app/api.ts
git commit -m "Handle Evolution license activation errors"
```

Expected: one commit containing only the license/error-message fix. Do not include multi-channel changes in this commit.

---

### Task 1: Add Backend Channel Delete And Stronger Provider Key Tests

**Files:**
- Modify: `apps/api/src/modules/channels/channels.service.test.ts`
- Modify: `apps/api/src/modules/channels/channels.service.ts`
- Modify: `apps/api/src/modules/channels/channels.routes.ts`
- Modify: `packages/shared/src/realtime.ts`

- [ ] **Step 1: Extend the mock Prisma channel interface in tests**

In `apps/api/src/modules/channels/channels.service.test.ts`, update the `MockPrisma` type and `createMockPrisma()`:

```ts
type MockPrisma = {
  channel: {
    findMany: any;
    findFirst: any;
    create: any;
    update: any;
    delete: any;
  };
  // keep the existing integrationConfig/contact/conversation/message mocks
};
```

Add the default mock:

```ts
delete:
  overrides.channel?.delete ??
  vi.fn().mockResolvedValue(baseChannel)
```

- [ ] **Step 2: Write failing service test for unique generated provider keys**

Add this test under `describe("channels service", ...)`:

```ts
it("generates a different provider key for each new real channel", async () => {
  const prisma = createMockPrisma();
  const createdProviderKeys: string[] = [];
  prisma.channel.create = vi.fn().mockImplementation(async (args) => {
    createdProviderKeys.push(args.data.providerKey);
    return {
      ...baseChannel,
      ...args.data,
      id: `00000000-0000-4000-8000-00000000000${createdProviderKeys.length}`,
      createdAt: new Date("2026-05-20T10:00:00.000Z"),
      updatedAt: new Date("2026-05-20T10:00:00.000Z")
    };
  });

  const service = createChannelsService(prisma, {
    evolution: {
      mode: "real",
      webhookSecret: "webhook-secret",
      publicWebhookUrl: () => "https://talk.prymeiradigital.com.br/webhooks/evolution/workspace_a",
      localWebhookUrl: () => "http://localhost:3002/webhooks/evolution/workspace_a",
      client: {
        createInstance: vi.fn(),
        connectInstance: vi.fn(),
        setWebhook: vi.fn(),
        sendText: vi.fn()
      }
    }
  });

  await service.createChannel({ workspaceId: "workspace_a", displayName: "Comercial" });
  await service.createChannel({ workspaceId: "workspace_a", displayName: "Suporte" });

  expect(createdProviderKeys).toHaveLength(2);
  expect(createdProviderKeys[0]).not.toBe(createdProviderKeys[1]);
  expect(createdProviderKeys[0]).toMatch(/^talk-workspace-a-/);
  expect(createdProviderKeys[1]).toMatch(/^talk-workspace-a-/);
});
```

- [ ] **Step 3: Write failing route test for deleting a channel**

Add this test under `describe("channels routes", ...)`:

```ts
it("deletes a workspace channel and publishes a channel deleted event", async () => {
  const prisma = createMockPrisma();
  const { app, publish } = await buildChannelsApp(prisma);

  try {
    const response = await app.inject({
      method: "DELETE",
      url: `/channels/${channelId}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, channelId });
    expect(prisma.channel.delete).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: channelId
        }
      }
    });
    expect(publish).toHaveBeenCalledWith({
      type: "channel.deleted",
      workspaceId: "workspace_a",
      payload: { channelId }
    });
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 4: Run tests and verify they fail**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/channels/channels.service.test.ts
```

Expected: failures for missing `deleteChannel`, missing `DELETE /channels/:channelId`, missing `channel.deleted` schema, or unchanged provider key format.

- [ ] **Step 5: Implement provider key generation and delete service**

In `apps/api/src/modules/channels/channels.service.ts`, extend `PrismaLike.channel`:

```ts
delete(args: {
  where: { workspaceId_id: { workspaceId: string; id: string } };
}): Promise<ChannelRecord>;
```

Replace `createInstanceName` with:

```ts
function slugPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
}

function createInstanceName(workspaceId: string) {
  const suffix =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);

  return `talk-${slugPart(workspaceId)}-${Date.now().toString(36)}-${suffix}`;
}
```

Add service method inside the returned object:

```ts
async deleteChannel(input: {
  workspaceId: string;
  channelId: string;
}): Promise<{ channelId: string }> {
  await prisma.channel.delete({
    where: {
      workspaceId_id: {
        workspaceId: input.workspaceId,
        id: input.channelId
      }
    }
  });

  return { channelId: input.channelId };
},
```

- [ ] **Step 6: Add shared realtime event schema**

In `packages/shared/src/realtime.ts`, add:

```ts
const channelDeletedEventSchema = z.object({
  type: z.literal("channel.deleted"),
  workspaceId: z.string().min(1),
  payload: z.object({
    channelId: z.string().min(1)
  })
});
```

Add `channelDeletedEventSchema` to the discriminated union next to `channelUpdatedEventSchema`.

- [ ] **Step 7: Add DELETE route**

In `apps/api/src/modules/channels/channels.routes.ts`, add after the disconnect route:

```ts
app.delete("/channels/:channelId", async (request, reply) => {
  const params = channelParamsSchema.safeParse(request.params);

  if (!params.success) {
    return reply.code(400).send({ error: "Invalid channel request." });
  }

  try {
    const result = await service.deleteChannel({
      workspaceId: request.talk.workspaceId,
      channelId: params.data.channelId
    });

    app.realtime.publish({
      type: "channel.deleted",
      workspaceId: request.talk.workspaceId,
      payload: { channelId: result.channelId }
    });

    return { ok: true, channelId: result.channelId };
  } catch (error) {
    return handleChannelsError(reply, error);
  }
});
```

- [ ] **Step 8: Verify channel backend tests pass**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/channels/channels.service.test.ts
pnpm --filter @prymeira-talk/shared test
```

Expected: channel tests pass and shared realtime schema tests pass.

- [ ] **Step 9: Commit backend channel lifecycle**

Run:

```bash
git add apps/api/src/modules/channels/channels.service.test.ts \
  apps/api/src/modules/channels/channels.service.ts \
  apps/api/src/modules/channels/channels.routes.ts \
  packages/shared/src/realtime.ts
git commit -m "Add multi-channel delete lifecycle"
```

---

### Task 2: Capture WhatsApp Push Names During Evolution Webhooks

**Files:**
- Modify: `apps/api/src/modules/evolution/evolution.routes.ts`
- Modify: `apps/api/src/modules/evolution/evolution.routes.test.ts`

- [ ] **Step 1: Write failing webhook tests**

In `apps/api/src/modules/evolution/evolution.routes.test.ts`, add one test where an inbound `MESSAGES_UPSERT` payload includes `data.pushName: "Ana WhatsApp"` and the existing contact has `name: null`.

Expected assertion:

```ts
expect(contactUpsertMock).toHaveBeenCalledWith(
  expect.objectContaining({
    create: expect.objectContaining({
      phone: "5547999990000",
      name: "Ana WhatsApp"
    }),
    update: {
      name: "Ana WhatsApp"
    }
  })
);
```

Add a second test where the local contact already has `name: "Ana Local"` and verify the update does not overwrite it:

```ts
expect(contactUpsertMock).toHaveBeenCalledWith(
  expect.objectContaining({
    create: expect.objectContaining({
      name: "Ana WhatsApp"
    }),
    update: {}
  })
);
```

If the current test harness does not expose `contactUpsertMock`, follow the existing mock style in the same file and assert against `app.prisma.contact.upsert`.

- [ ] **Step 2: Run Evolution route tests and verify failure**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/evolution/evolution.routes.test.ts
```

Expected: new tests fail because push name is ignored.

- [ ] **Step 3: Implement push-name extraction**

In `apps/api/src/modules/evolution/evolution.routes.ts`, add near `extractPhone`:

```ts
function extractPushName(data: unknown) {
  const candidates = [
    readStringPath(data, ["pushName"]),
    readStringPath(data, ["data", "pushName"]),
    readStringPath(data, ["key", "pushName"]),
    readStringPath(data, ["data", "key", "pushName"])
  ];

  return candidates.find((value) => value && value.trim().length > 0)?.trim() ?? null;
}
```

In the messages upsert block, after `const phone = ...`, add:

```ts
const pushName = extractPushName(payload);
```

Change contact upsert to:

```ts
const contact = await tx.contact.upsert({
  where: {
    workspaceId_phone: {
      workspaceId,
      phone
    }
  },
  create: {
    workspaceId,
    phone,
    ...(pushName ? { name: pushName } : {})
  },
  update: pushName
    ? {
        name: pushName
      }
    : {}
});
```

Prevent overwriting saved names by checking the existing contact before the upsert:

```ts
const existingContact = await tx.contact.findUnique({
  where: {
    workspaceId_phone: {
      workspaceId,
      phone
    }
  },
  select: { id: true, name: true }
});

const contact = await tx.contact.upsert({
  where: {
    workspaceId_phone: {
      workspaceId,
      phone
    }
  },
  create: {
    workspaceId,
    phone,
    ...(pushName ? { name: pushName } : {})
  },
  update: !existingContact?.name && pushName ? { name: pushName } : {}
});
```

Update the route test Prisma mock so `tx.contact.findUnique` exists and returns either `null`, `{ id: "contact-1", name: null }`, or `{ id: "contact-1", name: "Ana Local" }` depending on the test case.

- [ ] **Step 4: Verify Evolution webhook tests pass**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- src/modules/evolution/evolution.routes.test.ts
```

Expected: all Evolution route tests pass.

- [ ] **Step 5: Commit push-name ingestion**

Run:

```bash
git add apps/api/src/modules/evolution/evolution.routes.ts \
  apps/api/src/modules/evolution/evolution.routes.test.ts
git commit -m "Use WhatsApp push names for new contacts"
```

---

### Task 3: Add Web API Delete Channel Client

**Files:**
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/app/api.test.ts`

- [ ] **Step 1: Add a focused API test with stubbed fetch**

In `apps/web/src/app/api.test.ts`, add:

```ts
describe("apiDeleteChannel", () => {
  it("sends DELETE to the channel endpoint", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channelId: "channel-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.resetModules();

    const { apiDeleteChannel } = await import("./api");
    await expect(apiDeleteChannel(async () => null, "channel-1")).resolves.toEqual({
      ok: true,
      channelId: "channel-1"
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3002/channels/channel-1",
      expect.objectContaining({
        method: "DELETE"
      })
    );
  });
});
```

- [ ] **Step 2: Run the API test and verify failure**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/app/api.test.ts
```

Expected: fails because `apiDeleteChannel` does not exist.

- [ ] **Step 3: Implement `apiDeleteChannel`**

In `apps/web/src/app/api.ts`, add near the other channel API functions:

```ts
export interface DeleteChannelResultDto {
  ok: boolean;
  channelId: string;
}

export async function apiDeleteChannel(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<DeleteChannelResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "Failed to delete channel"));
  }

  const data = await response.json() as { ok?: unknown; channelId?: unknown };
  return {
    ok: data.ok === true,
    channelId: String(data.channelId ?? "")
  };
}
```

- [ ] **Step 4: Verify web API test passes**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/app/api.test.ts
```

Expected: API tests pass.

- [ ] **Step 5: Commit web API delete client**

Run:

```bash
git add apps/web/src/app/api.ts apps/web/src/app/api.test.ts
git commit -m "Add delete channel web API client"
```

---

### Task 4: Strengthen Canais UI For New Channel, QR Reconnect, And Delete

**Files:**
- Modify: `apps/web/src/features/channels/ChannelsPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Update imports**

In `ChannelsPage.tsx`, add `Trash2` and import `apiDeleteChannel`:

```ts
import { CheckCircle2, Link2, MessageCircle, PlugZap, QrCode, RefreshCw, Trash2, WifiOff } from "lucide-react";
```

```ts
import {
  apiCreateChannel,
  apiCreateTestInbound,
  apiDeleteChannel,
  apiDisconnectChannel,
  apiGetChannels,
  apiReconnectChannel,
  apiStartChannelQr
} from "../../app/api";
```

- [ ] **Step 2: Add create-channel state**

Inside `ChannelsPage`, add:

```ts
const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
const [newChannelName, setNewChannelName] = useState("");
```

- [ ] **Step 3: Replace `startQr` with new-channel flow**

Replace `ensureChannel` usage for the primary button with:

```ts
async function createChannelAndStartQr(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();

  const displayName = newChannelName.trim();
  if (!displayName) {
    setError("Informe um nome para o canal.");
    return;
  }

  setIsSaving(true);
  setError(null);
  setNotice(null);
  setQrDrawerOpen(true);

  try {
    const channel = await apiCreateChannel(getToken, { displayName });
    setChannels((current) => mergeChannel(current, channel));
    setSelectedChannelId(channel.id);

    const result = await apiStartChannelQr(getToken, channel.id);
    setQrResult(result);
    setChannels((current) => mergeChannel(current, result.channel));
    setCreateDrawerOpen(false);
    setNewChannelName("");
    setNotice("Sessao QR iniciada.");
  } catch (actionError) {
    setError(actionError instanceof Error ? actionError.message : "Nao foi possivel criar o canal.");
  } finally {
    setIsSaving(false);
  }
}
```

Remove `ensureChannel`. Update `testInbound` so it requires `selectedChannel`; when no channel is selected, set `error` to `"Selecione um canal para enviar mensagem de teste."` and return early.

- [ ] **Step 4: Change primary header button**

Replace the button handler:

```tsx
onClick={() => {
  setCreateDrawerOpen(true);
  setError(null);
  setNotice(null);
}}
```

Change label from `Conectar canal` to `Novo canal`.

- [ ] **Step 5: Make reconnect open QR**

Replace `reconnectChannel(channel)` implementation with:

```ts
async function reconnectChannel(channel: ChannelDto) {
  setIsSaving(true);
  setError(null);
  setNotice(null);
  setSelectedChannelId(channel.id);
  setQrDrawerOpen(true);

  try {
    const result = await apiStartChannelQr(getToken, channel.id);
    setQrResult(result);
    setChannels((current) => mergeChannel(current, result.channel));
    setNotice("QR de reconexao iniciado.");
  } catch (err) {
    setError(err instanceof Error ? err.message : "Erro ao reconectar.");
  } finally {
    setIsSaving(false);
  }
}
```

After this change, `apiReconnectChannel` is no longer used by this component and its import can be removed from `ChannelsPage.tsx`.

- [ ] **Step 6: Add delete action**

Add:

```ts
async function deleteChannel(channel: ChannelDto) {
  const confirmed = window.confirm(`Apagar o canal "${channelTitle(channel)}"? Esta acao remove as conversas ligadas a este canal.`);
  if (!confirmed) return;

  setIsSaving(true);
  setError(null);
  setNotice(null);

  try {
    await apiDeleteChannel(getToken, channel.id);
    setChannels((current) => current.filter((item) => item.id !== channel.id));
    setSelectedChannelId((current) => (current === channel.id ? null : current));
    setQrResult((current) => (current?.channel.id === channel.id ? null : current));
    setNotice("Canal apagado.");
  } catch (err) {
    setError(err instanceof Error ? err.message : "Erro ao apagar canal.");
  } finally {
    setIsSaving(false);
  }
}
```

- [ ] **Step 7: Hide provider key from normal row**

Change:

```tsx
<span className="channel-row-phone">
  {channel.phoneNumber ?? channel.providerKey}
</span>
```

to:

```tsx
<span className="channel-row-phone">
  {channel.phoneNumber ?? "Numero ainda nao identificado"}
</span>
```

- [ ] **Step 8: Add delete button**

Inside `.channel-row-actions`, add:

```tsx
<button
  className="secondary-button danger-button"
  disabled={isSaving}
  onClick={() => { void deleteChannel(channel); }}
  type="button"
>
  <Trash2 size={14} aria-hidden="true" />
  Apagar
</button>
```

- [ ] **Step 9: Add create drawer markup**

Above the QR drawer block, add:

```tsx
{createDrawerOpen ? (
  <>
    <div
      className="contact-drawer-overlay"
      onClick={() => setCreateDrawerOpen(false)}
      aria-hidden="true"
    />
    <aside className="contact-drawer is-open" aria-label="Novo canal WhatsApp">
      <header className="contact-drawer-header">
        <span className="context-card-title">Novo canal</span>
        <button
          className="drawer-close"
          onClick={() => setCreateDrawerOpen(false)}
          type="button"
          aria-label="Fechar"
        >
          ✕
        </button>
      </header>
      <form className="contact-drawer-body" onSubmit={createChannelAndStartQr}>
        <div className="context-card">
          <label className="field-label" htmlFor="channel-name">Nome do canal</label>
          <input
            className="text-input"
            id="channel-name"
            maxLength={160}
            onChange={(event) => setNewChannelName(event.target.value)}
            placeholder="Comercial, Suporte, Cliente Ana..."
            value={newChannelName}
          />
        </div>
        <button className="primary-button" disabled={isSaving || !newChannelName.trim()} type="submit">
          <QrCode size={16} aria-hidden="true" />
          Gerar QR
        </button>
      </form>
    </aside>
  </>
) : null}
```

- [ ] **Step 10: Style new controls**

In `apps/web/src/styles.css`, add:

```css
.danger-button {
  color: #9d2d24;
  border-color: rgba(157, 45, 36, 0.24);
}

.danger-button:hover:not(:disabled) {
  background: rgba(157, 45, 36, 0.08);
}

.field-label {
  display: grid;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 700;
}

.text-input {
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0 12px;
  color: var(--color-text);
  background: #fff;
  font: inherit;
}
```

- [ ] **Step 11: Verify web build**

Run:

```bash
pnpm --filter @prymeira-talk/web build
```

Expected: TypeScript and Vite build pass.

- [ ] **Step 12: Commit Canais UI**

Run:

```bash
git add apps/web/src/features/channels/ChannelsPage.tsx apps/web/src/styles.css
git commit -m "Strengthen WhatsApp channel management UI"
```

---

### Task 5: Add Atendimento Channel Filter And Contact Phone Fallback

**Files:**
- Create: `apps/web/src/features/inbox/conversation-display.ts`
- Create: `apps/web/src/features/inbox/conversation-display.test.ts`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Create failing helper tests**

Create `apps/web/src/features/inbox/conversation-display.test.ts`:

```ts
import type { ConversationDto } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import { contactDisplayName, filterConversationsByChannel, getChannelFilterOptions } from "./conversation-display";

const baseConversation: ConversationDto = {
  id: "conversation-1",
  workspaceId: "workspace-1",
  channelId: "channel-1",
  contactId: "contact-1",
  contactName: null,
  contactPhone: "5547999990000",
  channelName: "Comercial",
  departmentName: null,
  assignedUserName: null,
  status: "open",
  assignedUserId: null,
  departmentId: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  unreadCount: 0,
  priority: "normal"
};

describe("contactDisplayName", () => {
  it("uses saved contact name first", () => {
    expect(contactDisplayName({ ...baseConversation, contactName: "Ana" })).toBe("Ana");
  });

  it("falls back to phone before id", () => {
    expect(contactDisplayName(baseConversation)).toBe("5547999990000");
  });
});

describe("channel filters", () => {
  it("builds unique channel options from conversations", () => {
    expect(getChannelFilterOptions([
      baseConversation,
      { ...baseConversation, id: "conversation-2" },
      { ...baseConversation, id: "conversation-3", channelId: "channel-2", channelName: "Suporte" }
    ])).toEqual([
      { id: "all", label: "Todos" },
      { id: "channel-1", label: "Comercial" },
      { id: "channel-2", label: "Suporte" }
    ]);
  });

  it("filters conversations by selected channel", () => {
    const conversations = [
      baseConversation,
      { ...baseConversation, id: "conversation-2", channelId: "channel-2", channelName: "Suporte" }
    ];

    expect(filterConversationsByChannel(conversations, "all")).toHaveLength(2);
    expect(filterConversationsByChannel(conversations, "channel-2")).toEqual([conversations[1]]);
  });
});
```

- [ ] **Step 2: Run helper tests and verify failure**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/inbox/conversation-display.test.ts
```

Expected: fails because helper file does not exist.

- [ ] **Step 3: Implement helpers**

Create `apps/web/src/features/inbox/conversation-display.ts`:

```ts
import type { ConversationDto } from "@prymeira-talk/shared";

export interface ChannelFilterOption {
  id: "all" | string;
  label: string;
}

export function contactDisplayName(conversation: ConversationDto) {
  return conversation.contactName ?? conversation.contactPhone ?? `Contato ${conversation.contactId.slice(0, 8)}`;
}

export function getChannelFilterOptions(conversations: ConversationDto[]): ChannelFilterOption[] {
  const byId = new Map<string, string>();

  for (const conversation of conversations) {
    byId.set(
      conversation.channelId,
      conversation.channelName ?? `Canal ${conversation.channelId.slice(0, 8)}`
    );
  }

  return [
    { id: "all", label: "Todos" },
    ...Array.from(byId.entries()).map(([id, label]) => ({ id, label }))
  ];
}

export function filterConversationsByChannel(
  conversations: ConversationDto[],
  selectedChannelId: "all" | string
) {
  if (selectedChannelId === "all") {
    return conversations;
  }

  return conversations.filter((conversation) => conversation.channelId === selectedChannelId);
}
```

- [ ] **Step 4: Verify helper tests pass**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/inbox/conversation-display.test.ts
```

Expected: helper tests pass.

- [ ] **Step 5: Update InboxPage imports and remove local contactDisplayName**

In `apps/web/src/features/inbox/InboxPage.tsx`, import:

```ts
import {
  contactDisplayName,
  filterConversationsByChannel,
  getChannelFilterOptions
} from "./conversation-display";
```

Remove the local `function contactDisplayName(conversation: ConversationDto)`.

- [ ] **Step 6: Add filter state and derived visible conversations**

Inside `InboxPage`, add:

```ts
const [selectedChannelFilter, setSelectedChannelFilter] = useState<"all" | string>("all");
```

Near `selectedConversation`, add:

```ts
const channelFilterOptions = useMemo(
  () => getChannelFilterOptions(conversations),
  [conversations]
);
const visibleConversations = useMemo(
  () => filterConversationsByChannel(conversations, selectedChannelFilter),
  [conversations, selectedChannelFilter]
);
```

Add an effect to reset invalid filters:

```ts
useEffect(() => {
  if (
    selectedChannelFilter !== "all" &&
    !conversations.some((conversation) => conversation.channelId === selectedChannelFilter)
  ) {
    setSelectedChannelFilter("all");
  }
}, [conversations, selectedChannelFilter]);
```

- [ ] **Step 7: Render filter chips**

Below `.queue-summary`, add:

```tsx
<div className="channel-filter-row" aria-label="Filtrar por canal">
  {channelFilterOptions.map((option) => (
    <button
      className={`channel-filter-chip ${selectedChannelFilter === option.id ? "is-active" : ""}`}
      key={option.id}
      onClick={() => setSelectedChannelFilter(option.id)}
      type="button"
    >
      {option.label}
    </button>
  ))}
</div>
```

- [ ] **Step 8: Use visible conversations and show channel origin**

Change:

```tsx
{conversations.map((conversation) => (
```

to:

```tsx
{visibleConversations.map((conversation) => (
```

Change empty state condition:

```tsx
{!isLoading && visibleConversations.length === 0 ? (
  <p className="list-note">Nenhuma conversa encontrada para este canal.</p>
) : null}
```

Inside `.conversation-preview`, add channel origin:

```tsx
<span className="conversation-channel-origin">
  via {conversation.channelName ?? "Canal sem nome"}
</span>
<span>{conversation.lastMessagePreview ?? "Conversa iniciada."}</span>
```

If the existing CSS expects `.conversation-preview` to contain text only, wrap both spans and style them in Step 9.

- [ ] **Step 9: Style filters and channel origin**

In `apps/web/src/styles.css`, add:

```css
.channel-filter-row {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 0 4px 2px;
}

.channel-filter-chip {
  flex: 0 0 auto;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: #fff;
  color: var(--color-text-muted);
  min-height: 32px;
  padding: 0 12px;
  font-weight: 700;
  cursor: pointer;
}

.channel-filter-chip.is-active {
  background: var(--color-brand-600);
  border-color: var(--color-brand-600);
  color: #fff;
}

.conversation-preview {
  display: grid;
  gap: 2px;
}

.conversation-channel-origin {
  color: var(--color-brand-600);
  font-size: 11px;
  font-weight: 800;
}
```

- [ ] **Step 10: Verify inbox tests and build**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- src/features/inbox/conversation-display.test.ts
pnpm --filter @prymeira-talk/web build
```

Expected: tests and build pass.

- [ ] **Step 11: Commit Atendimento filtering**

Run:

```bash
git add apps/web/src/features/inbox/conversation-display.ts \
  apps/web/src/features/inbox/conversation-display.test.ts \
  apps/web/src/features/inbox/InboxPage.tsx \
  apps/web/src/styles.css
git commit -m "Add inbox filtering by WhatsApp channel"
```

---

### Task 6: Full Verification And Local Browser Check

**Files:**
- No required source edits unless verification finds defects.

- [ ] **Step 1: Run all tests**

Run:

```bash
pnpm --filter @prymeira-talk/shared test
pnpm --filter @prymeira-talk/api test
pnpm --filter @prymeira-talk/web test
```

Expected: all test suites pass.

- [ ] **Step 2: Run production builds**

Run:

```bash
pnpm --filter @prymeira-talk/api build
pnpm --filter @prymeira-talk/web build
```

Expected: both builds exit 0. Vite may warn about a chunk larger than 500 kB; that warning does not fail the build.

- [ ] **Step 3: Start local app for browser verification**

If web is not already running, run:

```bash
pnpm --filter @prymeira-talk/web dev
```

Expected:

```text
Local: http://localhost:5176/
```

- [ ] **Step 4: Manual checks in browser**

Open `http://localhost:5176/` and verify:

- Canais primary button says `Novo canal`.
- New channel drawer requires a name.
- Creating a channel opens QR drawer.
- Reconnect opens QR drawer for the selected existing row.
- Delete asks for confirmation and removes the row after success.
- Atendimento shows channel filter chips.
- Conversation cards show `via <channel>`.
- Conversation names show phone when no contact name exists.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: working tree clean except for intentionally uncommitted files, and recent commits correspond to the tasks above.

---

## Self-Review

- Spec coverage: The plan covers multiple named channels, new channel creation, QR reconnect, delete, hidden provider keys, inbox channel filtering, phone fallback, and push-name ingestion.
- Placeholder scan: No task uses TBD, TODO, or vague “handle later” language.
- Type consistency: Channel DTO continues to use existing `displayName`, `providerKey`, `phoneNumber`, and `status`. Conversation filtering uses existing `channelId`, `channelName`, `contactName`, and `contactPhone`.
