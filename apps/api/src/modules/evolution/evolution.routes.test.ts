import Fastify from "fastify";
import { conversationSchema, messageSchema, realtimeEventSchema } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { evolutionRoutes, extractMessageContent, isUniqueConstraintError, resolveWebhookPhone } from "./evolution.routes.js";
import type { EvolutionRoutesOptions } from "./evolution.routes.js";
import { evolutionWebhookEnvelopeSchema, evolutionWebhookSchema } from "./evolution.schemas.js";
import { createCipheriv, hkdfSync } from "node:crypto";

function encodedField(number: number, value: Buffer | number): Buffer {
  const varint = (input: number) => {
    const out: number[] = [];
    while (input > 127) { out.push((input & 127) | 128); input >>>= 7; }
    out.push(input);
    return Buffer.from(out);
  };
  return typeof value === "number"
    ? Buffer.concat([varint(number * 8), varint(value)])
    : Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}

function encryptedEditFixture() {
  const targetId = "provider_msg_1";
  const jid = "5511999999999@s.whatsapp.net";
  const secret = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 9);
  const key = encodedField(3, Buffer.from(targetId));
  const edited = encodedField(1, Buffer.from("Bom dia"));
  const protocol = Buffer.concat([encodedField(1, key), encodedField(2, 14), encodedField(14, edited)]);
  const plaintext = encodedField(12, protocol);
  const info = Buffer.from(targetId + jid + jid + "Message Edit");
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(32), info, 32)), iv);
  cipher.setAAD(Buffer.alloc(0));
  const payload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    data: {
      key: { id: "edit_1", remoteJid: jid, fromMe: false },
      message: { secretEncryptedMessage: {
        targetMessageKey: { id: targetId, fromMe: true },
        secretEncType: 2, encIv: iv.toString("base64"), encPayload: payload.toString("base64")
      } }
    },
    original: {
      key: { id: targetId, remoteJid: jid, fromMe: false },
      messageTimestamp: 1779300000,
      message: { conversation: "Bom muito", messageContextInfo: { messageSecret: secret.toString("base64") } }
    }
  };
}

const validWebhookBody = {
  event: "messages.upsert",
  instance: "client-one",
  data: {
    key: { id: "provider_msg_1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "Oi" },
    messageTimestamp: 1779300000
  }
};

const locationPayload = { degreesLatitude: -26.254, degreesLongitude: -48.875,
  name: 'Grupo Villefer', address: 'R. Landmann, 464, Joinville, SC', url: 'https://www.villefer.com.br' };
const locationDto = { latitude: -26.254, longitude: -48.875, name: 'Grupo Villefer',
  address: 'R. Landmann, 464, Joinville, SC', isLive: false };

describe('WhatsApp locations', () => {
  it('recognizes the business place, address and coordinates without using its website as a map', () => {
    const content = extractMessageContent({ locationMessage: locationPayload });
    expect(content).toMatchObject({ type: 'text', mediaUrl: null, location: locationDto });
    expect(content.body).toContain('Grupo Villefer');
    expect(content.body).toContain(locationPayload.address);
    expect(content.body).toContain('https://www.google.com/maps/search/?api=1&query=-26.254%2C-48.875');
    expect(content.body).not.toContain('villefer.com.br');
  });

  it('recognizes a wrapped location and coordinates at zero', () => {
    expect(extractMessageContent({ ephemeralMessage: { message: { locationMessage: {
      degreesLatitude: 0, degreesLongitude: 0
    } } } })).toMatchObject({ type: 'text', location: { latitude: 0, longitude: 0, name: null, address: null } });
  });

  it.each([{ liveLocationMessage: { ...locationPayload, caption: 'Entrega' } },
    { locationMessage: { ...locationPayload, isLive: true } }])('labels a live location as the received position', message => {
    const content = extractMessageContent(message);
    expect(content).toMatchObject({ type: 'text', location: { isLive: true } });
    expect(content.body).toContain('Última posição recebida');
  });

  it.each([undefined, null, '', ' ', 'oops', 91, NaN, Infinity])('does not invent coordinates for latitude %s', degreesLatitude => {
    expect(extractMessageContent({ locationMessage: { degreesLatitude, degreesLongitude: -48.875,
      address: 'R. Landmann, 464, Joinville' } })).toMatchObject({
      type: 'text', location: { latitude: null, longitude: null }
    });
  });

  it('keeps an empty location recognizable without inventing a map', () => {
    expect(extractMessageContent({ locationMessage: {} })).toMatchObject({
      type: 'text', body: 'Localização compartilhada', location: { latitude: null, longitude: null }
    });
  });
});

describe('WhatsApp contact cards', () => {
  it('reads a single shared contact and its vCard phone', () => {
    expect(extractMessageContent({ contactMessage: {
      displayName: 'Nelson Tecol',
      vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Nelson Tecol\nTEL;type=CELL;waid=556784432788:+55 67 8443-2788\nEND:VCARD'
    } })).toMatchObject({
      type: 'text', body: 'Contato compartilhado: Nelson Tecol (556784432788)',
      contactCards: [{ fullName: 'Nelson Tecol', phoneNumber: '556784432788' }]
    });
  });

  it('reads a group of shared contacts through a wrapped message', () => {
    expect(extractMessageContent({ ephemeralMessage: { message: { contactsArrayMessage: { contacts: [
      { displayName: 'Ana', vcard: 'BEGIN:VCARD\nTEL;type=CELL:+55 11 98765-4321\nEND:VCARD' },
      { displayName: 'Bruno', vcard: 'BEGIN:VCARD\nTEL;waid=5511999999999:+55 11 99999-9999\nEND:VCARD' }
    ] } } } })).toMatchObject({ type: 'text', contactCards: [
      { fullName: 'Ana', phoneNumber: '5511987654321' },
      { fullName: 'Bruno', phoneNumber: '5511999999999' }
    ] });
  });
});

describe('WhatsApp videos', () => {
  it('classifies a video message as an attachment with a video preview', () => {
    expect(extractMessageContent({ videoMessage: {
      mimetype: 'video/mp4', url: 'https://example.test/media/encrypted'
    } })).toMatchObject({ type: 'file', body: 'Vídeo recebido', preview: 'Vídeo recebido' });
  });
});

function createMockPrisma(overrides: {
  $transaction?: ReturnType<typeof vi.fn>;
  channel?: { findUnique?: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> };
  contact?: {
    findFirst?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    upsert?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
  };
  conversation?: {
    findUnique?: ReturnType<typeof vi.fn>;
    upsert?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
  };
  campaignRecipient?: { findFirst?: ReturnType<typeof vi.fn> };
  aiAgentSession?: { updateMany?: ReturnType<typeof vi.fn> };
  aiAgentPendingReply?: { updateMany?: ReturnType<typeof vi.fn> };
  message?: {
    findUnique?: ReturnType<typeof vi.fn>;
    count?: ReturnType<typeof vi.fn>;
    findFirst?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  };
  automationRule?: {
    findMany?: ReturnType<typeof vi.fn>;
  };
  automationRun?: {
    upsert?: ReturnType<typeof vi.fn>;
  };
  tag?: {
    upsert?: ReturnType<typeof vi.fn>;
    findFirst?: ReturnType<typeof vi.fn>;
  };
  conversationTag?: {
    create?: ReturnType<typeof vi.fn>;
    deleteMany?: ReturnType<typeof vi.fn>;
    findFirst?: ReturnType<typeof vi.fn>;
  };
  contactBoardStage?: {
    findFirst?: ReturnType<typeof vi.fn>;
  };
  contactBoardMembership?: {
    findFirst?: ReturnType<typeof vi.fn>;
    upsert?: ReturnType<typeof vi.fn>;
  };
  contactNote?: {
    create?: ReturnType<typeof vi.fn>;
  };
} = {}) {
  const prisma = {
    channel: {
      findUnique:
        overrides.channel?.findUnique ??
        vi.fn().mockResolvedValue({
          id: "channel_1",
          workspaceId: "workspace_a",
          provider: "evolution" as const,
          providerKey: "client-one",
          phoneNumber: null,
          displayName: "Client One",
          status: "connecting" as const,
          createdAt: new Date("2026-05-20T10:00:00.000Z"),
          updatedAt: new Date("2026-05-20T10:00:00.000Z")
        }),
      update:
        overrides.channel?.update ??
        vi.fn().mockResolvedValue({
          id: "channel_1",
          workspaceId: "workspace_a",
          provider: "evolution" as const,
          providerKey: "client-one",
          phoneNumber: null,
          displayName: "Client One",
          status: "connected" as const,
          createdAt: new Date("2026-05-20T10:00:00.000Z"),
          updatedAt: new Date("2026-05-20T12:00:00.000Z")
        })
    },
    contact: {
      findFirst:
        overrides.contact?.findFirst ??
        vi.fn().mockResolvedValue({
          id: "contact_1",
          workspaceId: "workspace_a",
          phone: "551199999999"
        }),
      create:
        overrides.contact?.create ??
        vi.fn().mockResolvedValue({
          id: "contact_1",
          workspaceId: "workspace_a",
          phone: "551199999999"
        }),
      upsert: overrides.contact?.upsert ?? vi.fn().mockResolvedValue({ id: "contact_1", phone: "551199999999" }),
      update: overrides.contact?.update ?? vi.fn().mockResolvedValue({ id: "contact_1", phone: "551199999999" }),
      updateMany: overrides.contact?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 })
    },
    conversation: {
      findUnique:
        overrides.conversation?.findUnique ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
          lastMessagePreview: "Oi",
          unreadCount: 1,
          priority: "normal",
          aiControlStatus: "agent_allowed",
          aiControlUpdatedAt: null,
          activeAgentSessionId: "session_1",
          channel: { displayName: "Client One", phoneNumber: null },
          contact: { name: null, phone: "551199999999" },
          department: null,
          assignedUser: null
        }),
      upsert:
        overrides.conversation?.upsert ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          lastMessageAt: null
        }),
      update:
        overrides.conversation?.update ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          lastMessageAt: null
        }),
      updateMany:
        overrides.conversation?.updateMany ??
        vi.fn().mockResolvedValue({
          count: 1
        })
    },
    campaignRecipient: { findFirst: overrides.campaignRecipient?.findFirst ?? vi.fn().mockResolvedValue(null) },
    message: {
      findUnique:
        overrides.message?.findUnique ??
        vi.fn().mockResolvedValue({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          providerEventId: "messages.upsert:client-one:provider_msg_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "delivered",
          sentByUserId: null,
          createdAt: new Date("2026-05-20T12:00:00.000Z"),
          updatedAt: new Date("2026-05-20T12:00:00.000Z"),
          conversation: {
            id: "conv_1",
            workspaceId: "workspace_a",
            channelId: "channel_1",
            contactId: "contact_1",
            status: "open",
            assignedUserId: null,
            departmentId: null,
            lastMessageAt: new Date("2026-05-20T12:00:00.000Z"),
            lastMessagePreview: "Oi",
            unreadCount: 1,
            priority: "normal",
            createdAt: new Date("2026-05-20T11:59:00.000Z"),
            updatedAt: new Date("2026-05-20T12:00:00.000Z"),
            channel: {
              id: "channel_1",
              provider: "evolution",
              providerKey: "client-one",
              displayName: "Client One"
            },
            contact: {
              id: "contact_1",
              phone: "551199999999",
              name: null
            },
            tags: []
          }
        }),
      count: overrides.message?.count ?? vi.fn().mockResolvedValue(1),
      findFirst: overrides.message?.findFirst ?? vi.fn().mockResolvedValue(null),
      create:
        overrides.message?.create ??
        vi.fn().mockResolvedValue({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "delivered",
          sentByUserId: null,
          createdAt: new Date("2026-05-20T12:00:00.000Z")
        }),
      update:
        overrides.message?.update ??
        vi.fn().mockResolvedValue({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          direction: "outbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "delivered",
          sentByUserId: null,
          createdAt: new Date("2026-05-20T12:00:00.000Z")
        })
    },
    automationRule: {
      findMany: overrides.automationRule?.findMany ?? vi.fn().mockResolvedValue([])
    },
    automationRun: {
      upsert:
        overrides.automationRun?.upsert ??
        vi.fn().mockImplementation(async (args) => ({
          id: "run_1",
          workspaceId: args.create.workspaceId,
          ruleId: args.create.ruleId,
          eventKey: args.create.eventKey,
          status: args.create.status,
          input: args.create.input,
          result: args.create.result,
          createdAt: new Date("2026-05-20T12:00:01.000Z"),
          updatedAt: new Date("2026-05-20T12:00:01.000Z")
        }))
    },
    tag: {
      upsert: overrides.tag?.upsert ?? vi.fn().mockResolvedValue({ id: "tag_1", name: "Lead" }),
      findFirst: overrides.tag?.findFirst ?? vi.fn().mockResolvedValue(null)
    },
    conversationTag: {
      create: overrides.conversationTag?.create ?? vi.fn().mockResolvedValue({}),
      deleteMany: overrides.conversationTag?.deleteMany ?? vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: overrides.conversationTag?.findFirst ?? vi.fn().mockResolvedValue(null)
    },
    contactBoardStage: {
      findFirst: overrides.contactBoardStage?.findFirst ?? vi.fn().mockResolvedValue(null)
    },
    contactBoardMembership: {
      findFirst: overrides.contactBoardMembership?.findFirst ?? vi.fn().mockResolvedValue(null),
      upsert: overrides.contactBoardMembership?.upsert ?? vi.fn().mockResolvedValue({})
    },
    contactNote: {
      create: overrides.contactNote?.create ?? vi.fn().mockResolvedValue({})
    },
    aiAgentSession: { updateMany: overrides.aiAgentSession?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 }) },
    aiAgentPendingReply: { updateMany: overrides.aiAgentPendingReply?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 }) }
  };

  return {
    ...prisma,
    $transaction:
      overrides.$transaction ??
      vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma))
  };
}

async function buildEvolutionApp(
  prisma = createMockPrisma(),
  evolution?: EvolutionRoutesOptions["evolution"],
  routeOverrides: Partial<EvolutionRoutesOptions> = {}
) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  await app.register(evolutionRoutes, {
    webhookSecret: "top_secret",
    evolution,
    ...routeOverrides
  });

  return { app, prisma, publish };
}

describe("Evolution webhook schema", () => {
  it("parses a lightweight webhook envelope before message-specific data", () => {
    const parsed = evolutionWebhookEnvelopeSchema.parse({
      event: "connection.update",
      instance: "client-one",
      data: { state: "open" }
    });

    expect(parsed.event).toBe("connection.update");
  });

  it("normalizes an inbound text message event", () => {
    const parsed = evolutionWebhookSchema.parse(validWebhookBody);

    expect(parsed.data.key.id).toBe("provider_msg_1");
  });

  it("uses a phone alternate for LID messages without treating the LID as a phone", () => {
    const parsed = evolutionWebhookSchema.parse({ ...validWebhookBody, data: {
      ...validWebhookBody.data, key: { ...validWebhookBody.data.key,
        remoteJid: '123456789012345@lid', remoteJidAlt: '5511999999999@s.whatsapp.net' }
    } });
    expect(resolveWebhookPhone(parsed.data.key.remoteJid, parsed.data.key.remoteJidAlt)).toBe('551199999999');
    expect(resolveWebhookPhone('123456789012345@lid')).toBe('123456789012345@lid');
    expect(resolveWebhookPhone('123456789012345@g.us')).toBeNull();
  });
});

describe("Evolution webhook routes", () => {
  it("detects Prisma provider message id unique constraint errors", () => {
    expect(
      isUniqueConstraintError({
        code: "P2002",
        meta: { target: ["workspace_id", "provider_message_id"] }
      })
    ).toBe(true);

    expect(
      isUniqueConstraintError({
        code: "P2002",
        meta: { target: ["workspace_id", "provider_event_id"] }
      })
    ).toBe(true);

    expect(isUniqueConstraintError({ code: "P2002", meta: { target: ["email"] } })).toBe(false);
  });

  it("ingests an unmapped LID under its exact identity without treating it as a phone", async () => {
    const prisma = createMockPrisma({ contact: { findFirst: vi.fn().mockResolvedValue(null) } });
    const { app } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' },
        payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, remoteJid: '123456789012345@lid' } } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
      expect(prisma.contact.create).toHaveBeenCalledWith({ data: { workspaceId: 'workspace_a', phone: '123456789012345@lid' } });
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ aiControlStatus: 'human_controlled' }) }));
    } finally {
      await app.close();
    }
  });

  it('upgrades an LID-only contact when Evolution supplies its phone alternate', async () => {
    const lid = { id: 'contact_lid', workspaceId: 'workspace_a', phone: '123456789012345@lid' };
    const findFirst = vi.fn().mockResolvedValueOnce(lid).mockResolvedValueOnce(null);
    const update = vi.fn().mockResolvedValue({ ...lid, phone: '551199999999' });
    const prisma = createMockPrisma({ contact: { findFirst, update } });
    const { app } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, remoteJid: lid.phone, remoteJidAlt: '5511999999999@s.whatsapp.net' } } } });
      expect(response.statusCode).toBe(200);
      expect(update).toHaveBeenCalledWith({ where: { workspaceId_id: { workspaceId: 'workspace_a', id: lid.id } }, data: { phone: '551199999999', customFields: { evolutionLid: lid.phone } } });
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { workspaceId_channelId_contactId: { workspaceId: 'workspace_a', channelId: 'channel_1', contactId: lid.id } }
      }));
    } finally { await app.close(); }
  });

  it('routes an LID-only message to a previously linked phone contact', async () => {
    const lid = { id: 'contact_lid', workspaceId: 'workspace_a', phone: '123456789012345@lid' };
    const linked = { id: 'contact_phone', workspaceId: 'workspace_a', phone: '551199999999', customFields: { evolutionLid: lid.phone } };
    const findFirst = vi.fn().mockResolvedValueOnce(lid).mockResolvedValueOnce(lid).mockResolvedValueOnce(linked);
    const prisma = createMockPrisma({ contact: { findFirst } });
    const { app } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, remoteJid: lid.phone } } } });
      expect(response.statusCode).toBe(200);
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { workspaceId_channelId_contactId: { workspaceId: 'workspace_a', channelId: 'channel_1', contactId: linked.id } }
      }));
    } finally { await app.close(); }
  });

  it.each([false, true])('stores location metadata from the WhatsApp webhook (fromMe=%s)', async fromMe => {
    const prisma = createMockPrisma();
    const { app } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, fromMe }, message: { locationMessage: locationPayload } } } });
      expect(response.statusCode).toBe(200);
      expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        direction: fromMe ? 'outbound' : 'inbound', type: 'text', body: expect.stringContaining('Grupo Villefer'),
        metadata: expect.objectContaining({ location: locationDto })
      }) }));
    } finally { await app.close(); }
  });

  it('keeps the video MIME type when storing an inbound message', async () => {
    const prisma = createMockPrisma();
    const { app } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          message: { videoMessage: { mimetype: 'video/mp4', url: 'https://example.test/video.enc' } } } } });
      expect(response.statusCode).toBe(200);
      expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        type: 'file', body: 'Vídeo recebido', metadata: expect.objectContaining({ attachment: expect.objectContaining({ mimeType: 'video/mp4' }) })
      }) }));
    } finally { await app.close(); }
  });

  it('asks for older context when a new inbound Evolution message arrives', async () => {
    const historyBackfill = vi.fn().mockResolvedValue(undefined);
    const { app } = await buildEvolutionApp(createMockPrisma(), undefined, { historyBackfill });
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: validWebhookBody });
      expect(response.statusCode).toBe(200);
      expect(historyBackfill).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'workspace_a', channelId: 'channel_1', conversationId: 'conv_1',
        providerKey: 'client-one', remoteJid: validWebhookBody.data.key.remoteJid
      }));
    } finally {
      await app.close();
    }
  });

  it('publishes a new message without waiting for historical backfill', async () => {
    let release!: () => void;
    const historyBackfill = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const { app, publish } = await buildEvolutionApp(createMockPrisma(), undefined, { historyBackfill });
    try {
      const response = await Promise.race([
        app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
          headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: validWebhookBody }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Webhook waited for history')), 500))
      ]);
      expect(response.statusCode).toBe(200);
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.created' }));
    } finally { release?.(); await app.close(); }
  });

  it("returns 401 for invalid secrets without touching Prisma", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "wrong_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, error: "invalid_webhook_secret" });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.contact.findFirst).not.toHaveBeenCalled();
      expect(prisma.contact.create).not.toHaveBeenCalled();
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 401 for duplicate secret headers without touching Prisma", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": ["top_secret", "wrong_secret"] },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, error: "invalid_webhook_secret" });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("updates a channel and publishes realtime for uppercase connection updates", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();

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
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.channel.update).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "workspace_a",
            provider: "evolution",
            providerKey: "client-one"
          }
        },
        data: { status: "connected" }
      });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith({
        type: "channel.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "channel_1",
          workspaceId: "workspace_a",
          providerKey: "client-one",
          status: "connected"
        })
      });
    } finally {
      await app.close();
    }
  });
  it('scopes physical Evolution QR events and status to the primary connection', async () => {
    const { app, prisma, publish } = await buildEvolutionApp();
    const primary = { id: 'primary-connection', workspaceId: 'workspace_a', channelId: 'channel_1', provider: 'evolution', sessionName: 'client-one', status: 'connecting', health: 'unknown', verifiedPhoneNumber: null, eligible: false };
    const upsert = vi.fn(async () => primary);
    (prisma as any).channelConnection = { upsert, findMany: vi.fn(async () => [primary, { ...primary, id: 'secondary-connection', provider: 'waha', status: 'connected', health: 'degraded' }]) };
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a', headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: { event: 'QRCODE_UPDATED', instance: 'client-one', data: { qrcode: { code: 'primary-qr' } } } });
      expect(response.statusCode).toBe(200);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId_channelId_provider: { workspaceId: 'workspace_a', channelId: 'channel_1', provider: 'evolution' } }, update: expect.objectContaining({ status: 'connecting' }) }));
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'channel.qr_updated', payload: expect.objectContaining({ connectionId: 'primary-connection', provider: 'evolution' }) }));
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'channel.updated', payload: expect.objectContaining({ connectedCount: 1, connectionTotal: 2, connections: expect.arrayContaining([expect.objectContaining({ id: 'primary-connection', status: 'connecting' })]) }) }));
    } finally { await app.close(); }
  });

  it("updates a channel for lowercase connection updates before parsing message-shaped data", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "connection.update",
          instance: "client-one",
          data: { state: "open" }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.channel.update).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "workspace_a",
            provider: "evolution",
            providerKey: "client-one"
          }
        },
        data: { status: "connected" }
      });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "channel.updated",
          workspaceId: "workspace_a"
        })
      );
    } finally {
      await app.close();
    }
  });

  it("returns channel_not_found for orphaned connection updates", async () => {
    const prisma = createMockPrisma({
      channel: {
        update: vi.fn().mockRejectedValue({ code: "P2025" })
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "CONNECTION_UPDATE",
          instance: "orphaned-instance",
          data: { state: "open" }
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: "channel_not_found" });
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("updates message status from Evolution message update events", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "MESSAGES_UPDATE",
          instance: "client-one",
          data: {
            key: { id: "provider_msg_1" },
            status: "delivered"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: {
          workspaceId_providerMessageId: {
            workspaceId: "workspace_a",
            providerMessageId: "provider_msg_1"
          }
        },
        data: { status: "delivered" }
      });
      expect(publish).toHaveBeenCalledWith({
        type: "message.status_changed",
        workspaceId: "workspace_a",
        payload: {
          messageId: "msg_1",
          status: "delivered"
        }
      });
    } finally {
      await app.close();
    }
  });

  it("applies an edited upsert to the original message without creating another bubble", async () => {
    const prisma = createMockPrisma({
      message: {
        update: vi.fn().mockImplementation(async ({ data }) => ({
          id: "msg_1", workspaceId: "workspace_a", conversationId: "conv_1",
          providerMessageId: "provider_msg_1", direction: "inbound", mediaUrl: null,
          status: "delivered", sentByUserId: null, createdAt: new Date("2026-05-20T12:00:00.000Z"),
          ...data
        }))
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({
        method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { ...validWebhookBody, data: {
          ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, id: "edit_event_1" },
          message: { protocolMessage: {
            type: 14,
            key: { id: "provider_msg_1" },
            editedMessage: { conversation: "Bom dia" }
          } }
        } }
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { workspaceId_providerMessageId: { workspaceId: "workspace_a", providerMessageId: "provider_msg_1" } },
        data: expect.objectContaining({ body: "Bom dia", type: "text" })
      }));
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "message.updated" }));
    } finally {
      await app.close();
    }
  });

  it("applies a messages.update edited wrapper and keeps ordinary status updates separate", async () => {
    const prisma = createMockPrisma({
      message: {
        update: vi.fn().mockImplementation(async ({ data }) => ({
          id: "msg_1", workspaceId: "workspace_a", conversationId: "conv_1",
          providerMessageId: "provider_msg_1", direction: "inbound", mediaUrl: null,
          status: "delivered", sentByUserId: null, createdAt: new Date("2026-05-20T12:00:00.000Z"),
          ...data
        }))
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({
        method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "MESSAGES_UPDATE", instance: "client-one",
          data: {
            key: { id: "provider_msg_1" },
            update: { message: { editedMessage: { message: { conversation: "Bom dia" } } } }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ body: "Bom dia" })
      }));
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "message.updated" }));
      expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: "message.status_changed" }));
    } finally {
      await app.close();
    }
  });

  it("ignores edit notices without readable replacement text", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();
    try {
      const response = await app.inject({
        method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { ...validWebhookBody, data: {
          ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, id: "edit_event_2" },
          message: { protocolMessage: {
            type: "MESSAGE_EDIT", key: { id: "provider_msg_1" },
            editedMessage: { secretEncryptedMessage: {} }
          } }
        } }
      });
      expect(response.json()).toEqual({ ok: true, ignored: true });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("decrypts a WhatsApp secretEncryptedMessage and edits the existing bubble", async () => {
    const fixture = encryptedEditFixture();
    const prisma = createMockPrisma({
      message: {
        update: vi.fn().mockImplementation(async ({ data }) => ({
          id: "msg_1", workspaceId: "workspace_a", conversationId: "conv_1",
          providerMessageId: "provider_msg_1", direction: "inbound", mediaUrl: null,
          status: "delivered", sentByUserId: null, createdAt: new Date("2026-05-20T12:00:00.000Z"),
          ...data
        }))
      }
    });
    const findMessage = vi.fn().mockResolvedValue(fixture.original);
    const { app, publish } = await buildEvolutionApp(prisma, undefined, { messageHistory: { findMessage } });
    try {
      const response = await app.inject({
        method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { event: "MESSAGES_UPSERT", instance: "client-one", data: fixture.data }
      });
      expect(response.json()).toEqual({ ok: true });
      expect(findMessage).toHaveBeenCalledWith({ instanceName: "client-one", id: "provider_msg_1" });
      expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ body: "Bom dia", type: "text" })
      }));
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "message.updated" }));
    } finally { await app.close(); }
  });

  it("does not create a phantom bubble when an encrypted edit fails authentication", async () => {
    const fixture = encryptedEditFixture();
    fixture.original.message.messageContextInfo.messageSecret = Buffer.alloc(32, 3).toString("base64");
    const findMessage = vi.fn().mockResolvedValue(fixture.original);
    const { app, prisma, publish } = await buildEvolutionApp(undefined, undefined, { messageHistory: { findMessage } });
    try {
      const response = await app.inject({
        method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { event: "MESSAGES_UPSERT", instance: "client-one", data: fixture.data }
      });
      expect(response.json()).toEqual({ ok: true, ignored: true });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("ignores a standalone encrypted control envelope with no readable content", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();
    try {
      const response = await app.inject({
        method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { ...validWebhookBody, data: {
          ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, id: "encrypted_notice_1" },
          messageType: "secretEncryptedMessage",
          message: { messageContextInfo: {}, secretEncryptedMessage: { secretEncType: 2 } }
        } }
      });
      expect(response.json()).toEqual({ ok: true, ignored: true });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("refreshes the conversation preview only when the edited message is the latest", async () => {
    const prisma = createMockPrisma({
      message: {
        findFirst: vi.fn().mockResolvedValue({ id: "msg_1" }),
        update: vi.fn().mockImplementation(async ({ data }) => ({
          id: "msg_1", workspaceId: "workspace_a", conversationId: "conv_1",
          providerMessageId: "provider_msg_1", direction: "inbound", mediaUrl: null,
          status: "delivered", sentByUserId: null, createdAt: new Date("2026-05-20T12:00:00.000Z"),
          ...data
        }))
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({
        method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "MESSAGES_EDITED", instance: "client-one",
          data: { key: { id: "provider_msg_1" }, message: { conversation: "Bom dia" } }
        }
      });
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: "workspace_a", id: "conv_1" },
        data: { lastMessagePreview: "Bom dia" }
      });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation.updated" }));
      const editedEvent = publish.mock.calls.find(([event]) => event.type === "message.updated")?.[0];
      expect(realtimeEventSchema.parse(editedEvent)).toEqual(editedEvent);
    } finally {
      await app.close();
    }
  });

  it("updates message status using Evolution keyId before local messageId", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "messages.update",
          instance: "client-one",
          data: {
            keyId: "provider_media_1",
            messageId: "local_msg_1",
            status: "DELIVERY_ACK"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: {
          workspaceId_providerMessageId: {
            workspaceId: "workspace_a",
            providerMessageId: "provider_media_1"
          }
        },
        data: { status: "delivered" }
      });
    } finally {
      await app.close();
    }
  });

  it("publishes QR code update events without parsing message-shaped data", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "QRCODE_UPDATED",
          instance: "client-one",
          data: { qrcode: { code: "2@qr-code" } }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.channel.update).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "workspace_a",
            provider: "evolution",
            providerKey: "client-one"
          }
        },
        data: { status: "connecting" }
      });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith({
        type: "channel.qr_updated",
        workspaceId: "workspace_a",
        payload: {
          channelId: "channel_1",
          qrCode: "2@qr-code",
          expiresAt: expect.any(String)
        }
      });
    } finally {
      await app.close();
    }
  });

  it("ignores unknown non-message events without touching Prisma", async () => {
    const { app, prisma } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "foo.event",
          instance: "client-one",
          data: { qrcode: "abc" }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, ignored: true });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.channel.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the Evolution channel is missing", async () => {
    const prisma = createMockPrisma({
      channel: { findUnique: vi.fn().mockResolvedValue(null) }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: "channel_not_found" });
      expect(prisma.channel.findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "workspace_a",
            provider: "evolution",
            providerKey: "client-one"
          }
        },
        select: { id: true, provider: true }
      });
    } finally {
      await app.close();
    }
  });

  it("ingests official Meta via Evolution messages through a meta_cloud channel", async () => {
    const findUnique = vi.fn().mockImplementation(async (args) => {
      if (args.where.workspaceId_provider_providerKey.provider === "meta_cloud") {
        return { id: "channel_meta_1", provider: "meta_cloud" };
      }

      return null;
    });
    const prisma = createMockPrisma({
      channel: { findUnique }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "workspace_a",
            provider: "evolution",
            providerKey: "client-one"
          }
        },
        select: { id: true, provider: true }
      });
      expect(findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "workspace_a",
            provider: "meta_cloud",
            providerKey: "client-one"
          }
        },
        select: { id: true, provider: true }
      });
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            channelId: "channel_meta_1",
            customerServiceWindowExpiresAt: new Date("2026-05-21T18:00:00.000Z")
          })
        })
      );
    } finally {
      await app.close();
    }
  });

  it("returns ok duplicate without unread increments or publish when message create loses the race", async () => {
    const duplicateError = {
      code: "P2002",
      meta: { target: ["workspace_id", "provider_message_id"] }
    };
    const prisma = createMockPrisma({
      message: {
        create: vi.fn().mockRejectedValue(duplicateError)
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, duplicate: true });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          providerMessageId: "provider_msg_1"
        })
      });
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns ok duplicate without unread increments or publish for duplicate provider events", async () => {
    const duplicateError = {
      code: "P2002",
      meta: { target: ["workspace_id", "provider_event_id"] }
    };
    const prisma = createMockPrisma({
      message: {
        create: vi.fn().mockRejectedValue(duplicateError)
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, duplicate: true });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          providerEventId: "messages.upsert:client-one:provider_msg_1"
        })
      });
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("pauses the agent and cancels its queued reply when a human sends through another app", async () => {
    const prisma = createMockPrisma({ message: { create: vi.fn().mockImplementation(async (args) => ({
      id: "msg_1", workspaceId: "workspace_a", conversationId: "conv_1",
      providerMessageId: args.data.providerMessageId, direction: args.data.direction,
      type: args.data.type, body: args.data.body, mediaUrl: args.data.mediaUrl,
      status: args.data.status, createdAt: args.data.createdAt
    })) } });
    const control = vi.fn().mockResolvedValue(undefined);
    const assistantMessage = vi.fn().mockResolvedValue(undefined);
    const observeConversationActivity = vi.fn().mockResolvedValue({ status: "scheduled" });
    const observeMessage = vi.fn().mockResolvedValue(undefined);
    const { app, publish } = await buildEvolutionApp(prisma, undefined, {
      assistantScheduler: { control, message: assistantMessage, persistInbound: vi.fn().mockResolvedValue(undefined) } as never,
      followupService: { observeConversationActivity },
      inboxTriage: { observeMessage }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          ...validWebhookBody,
          data: {
            ...validWebhookBody.data,
            key: { ...validWebhookBody.data.key, id: "external_human_1", fromMe: true },
            message: { conversation: "Vou mandar a quantidade" }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace_a", id: "conv_1" }),
        data: expect.objectContaining({ aiControlStatus: "human_controlled" })
      }));
      expect(prisma.aiAgentSession.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: "workspace_a", id: "session_1", status: "active" },
        data: { status: "paused_by_human" }
      });
      expect(prisma.aiAgentPendingReply.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: "workspace_a", conversationId: "conv_1", status: { in: ["pending", "processing"] } },
        data: { status: "cancelled", lockedAt: null, lastError: "human_outbound" }
      });
      expect(control).toHaveBeenCalledWith("workspace_a", "conv_1", true);
      expect(assistantMessage).not.toHaveBeenCalled();
      expect(observeConversationActivity).toHaveBeenCalledWith({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        messageId: "msg_1",
        direction: "outbound",
        source: "human"
      });
      expect(observeMessage).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "workspace_a", conversationId: "conv_1", messageId: "msg_1", direction: "outbound"
      }));
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation.updated" }));
    } finally {
      await app.close();
    }
  });

  it("does not pause the agent when an already recorded system send returns through the webhook", async () => {
    const prisma = createMockPrisma({
      message: { create: vi.fn().mockRejectedValue({ code: "P2002", meta: { target: ["workspace_id", "provider_message_id"] } }) }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          ...validWebhookBody,
          data: { ...validWebhookBody.data, key: { ...validWebhookBody.data.key, fromMe: true } }
        }
      });
      expect(response.json()).toEqual({ ok: true, duplicate: true });
      expect(prisma.aiAgentSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.aiAgentPendingReply.updateMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps a hidden campaign send out of inbox recency when its outbound webhook arrives first", async () => {
    const prisma = createMockPrisma({ campaignRecipient: {
      findFirst: vi.fn().mockResolvedValue({ id: 'recipient-1' })
    } });
    const { app } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' },
        payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, fromMe: true } } } });
      expect(response.statusCode).toBe(200);
      expect(prisma.campaignRecipient.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'workspace_a', channelId: 'channel_1',
          campaign: { is: { hideFromInboxUntilReply: true } } })
      }));
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ hiddenUntilReply: true })
      }));
      const previewUpdate = prisma.conversation.updateMany.mock.calls.find(([input]) =>
        input.data?.lastMessagePreviewAt);
      expect(previewUpdate?.[0].data).not.toHaveProperty('lastMessageAt');
    } finally { await app.close(); }
  });

  it("stores Evolution image messages with media type and readable preview", async () => {
    const prisma = createMockPrisma();
    const { app } = await buildEvolutionApp(prisma);
    const imagePayload = {
      ...validWebhookBody,
      data: {
        ...validWebhookBody.data,
        key: {
          ...validWebhookBody.data.key,
          id: "provider_image_1"
        },
        message: {
          base64: "aW1hZ2Vt",
          imageMessage: {
            caption: "Comprovante",
            mimetype: "image/jpeg",
            url: "https://media.example.com/image.jpg"
          }
        }
      }
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: imagePayload
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerMessageId: "provider_image_1",
          type: "image",
          body: "Comprovante",
          mediaUrl: "data:image/jpeg;base64,aW1hZ2Vt"
        })
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastMessagePreview: "Comprovante"
          })
        })
      );
    } finally {
      await app.close();
    }
  });

  describe("durable media copy on the legacy webhook", () => {
    const imageBody = (id: string) => ({ ...validWebhookBody, data: { ...validWebhookBody.data, key: { ...validWebhookBody.data.key, id },
      message: { base64: "aW1hZ2Vt", imageMessage: { caption: "Comprovante", mimetype: "image/jpeg", url: "https://media.example.com/image.jpg" } } } });
    const send = (app: Awaited<ReturnType<typeof buildEvolutionApp>>["app"], payload: unknown) =>
      app.inject({ method: "POST", url: "/webhooks/evolution/workspace_a", headers: { "x-prymeira-talk-secret": "top_secret" }, payload: payload as never });

    it("prepares the saved attachment with an Evolution fetch as the fallback source", async () => {
      const prisma = createMockPrisma();
      const prepare = vi.fn().mockResolvedValue({ state: "stored", playback: "not_applicable" });
      const fetchMedia = vi.fn().mockResolvedValue("data:image/jpeg;base64,aW1hZ2Vt");
      const { app } = await buildEvolutionApp(prisma, undefined, { durableMedia: { prepare }, evolutionClient: { fetchMedia } });
      try {
        expect((await send(app, imageBody("provider_image_durable"))).statusCode).toBe(200);
        expect(prepare).toHaveBeenCalledTimes(1);
        const call = prepare.mock.calls[0]![0];
        expect(call).toMatchObject({ workspaceId: "workspace_a", messageId: expect.any(String) });
        expect(call.fetchers).toHaveLength(1);
        await call.fetchers[0].fetch();
        expect(fetchMedia).toHaveBeenCalledWith({ instanceName: validWebhookBody.instance, id: "provider_image_durable" });
      } finally { await app.close(); }
    });

    it("never fails or delays the webhook because the durable copy failed, and ignores text messages", async () => {
      const prisma = createMockPrisma();
      const prepare = vi.fn().mockRejectedValue(new Error("disk full"));
      const { app } = await buildEvolutionApp(prisma, undefined, { durableMedia: { prepare } });
      try {
        expect((await send(app, imageBody("provider_image_failing"))).statusCode).toBe(200);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect((await send(app, validWebhookBody)).statusCode).toBe(200);
        expect(prepare).toHaveBeenCalledTimes(1);
      } finally { await app.close(); }
    });

    it("a workspace outside the staged rollout gets no durable copy", async () => {
      const prisma = createMockPrisma();
      const prepare = vi.fn().mockResolvedValue({ state: "stored", playback: "not_applicable" });
      const { app } = await buildEvolutionApp(prisma, undefined, { durableMedia: { prepare }, durableMediaWorkspaces: (workspaceId) => workspaceId === "someone_else" });
      try {
        expect((await send(app, imageBody("provider_image_outside"))).statusCode).toBe(200);
        expect(prepare).not.toHaveBeenCalled();
      } finally { await app.close(); }
    });

    it("keeps the legacy behaviour untouched when no durable store is configured", async () => {
      const prisma = createMockPrisma();
      const { app } = await buildEvolutionApp(prisma);
      try { expect((await send(app, imageBody("provider_image_legacy"))).statusCode).toBe(200); } finally { await app.close(); }
    });
  });

  it("stores Evolution audio and sticker messages with non-empty previews", async () => {
    const prisma = createMockPrisma();
    const { app } = await buildEvolutionApp(prisma);
    const audioPayload = {
      ...validWebhookBody,
      data: {
        ...validWebhookBody.data,
        key: {
          ...validWebhookBody.data.key,
          id: "provider_audio_1"
        },
        message: {
          base64: "YXVkaW8=",
          audioMessage: {
            mimetype: "audio/ogg; codecs=opus",
            url: "https://media.example.com/audio.ogg"
          }
        }
      }
    };
    const stickerPayload = {
      ...validWebhookBody,
      data: {
        ...validWebhookBody.data,
        key: {
          ...validWebhookBody.data.key,
          id: "provider_sticker_1"
        },
        message: {
          base64: "c3RpY2tlcg==",
          stickerMessage: {
            mimetype: "image/webp",
            url: "https://media.example.com/sticker.webp"
          }
        }
      }
    };

    try {
      const audioResponse = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: audioPayload
      });
      const stickerResponse = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: stickerPayload
      });

      expect(audioResponse.statusCode).toBe(200);
      expect(stickerResponse.statusCode).toBe(200);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerMessageId: "provider_audio_1",
          type: "audio",
          body: "Áudio recebido",
          mediaUrl: "data:audio/ogg;base64,YXVkaW8="
        })
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerMessageId: "provider_sticker_1",
          type: "image",
          body: "Figurinha recebida",
          mediaUrl: "data:image/webp;base64,c3RpY2tlcg=="
        })
      });
    } finally {
      await app.close();
    }
  });

  it("recognizes stickers without a URL and inside temporary message wrappers", async () => {
    const prisma = createMockPrisma();
    const { app } = await buildEvolutionApp(prisma);
    try {
      for (const [id, message] of [
        ["sticker_direct_path", { stickerMessage: { directPath: "/v/t62.15575-24/asset", mediaKey: "key" } }],
        ["sticker_ephemeral", { ephemeralMessage: { message: { stickerMessage: { directPath: "/v/t62.15575-24/asset" } } } }],
        ["sticker_type_only", undefined]
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/webhooks/evolution/workspace_a",
          headers: { "x-prymeira-talk-secret": "top_secret" },
          payload: { ...validWebhookBody, data: { ...validWebhookBody.data, key: { ...validWebhookBody.data.key, id }, message, messageType: id === "sticker_type_only" ? "stickerMessage" : undefined } }
        });
        expect(response.statusCode).toBe(200);
        expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({
          providerMessageId: id, type: "image", body: "Figurinha recebida", mediaUrl: null
        }) });
      }
    } finally {
      await app.close();
    }
  });

  it("reads the text of an incoming WhatsApp template", async () => {
    const prisma = createMockPrisma();
    const { app } = await buildEvolutionApp(prisma);
    try {
      const response = await app.inject({ method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, id: "template_with_text" },
          messageType: "templateMessage",
          message: { templateMessage: { hydratedTemplate: {
            hydratedTitleText: "Pedido de orçamento",
            hydratedContentText: "Preciso de chapa galvanizada."
          } } }
        } }
      });
      expect(response.statusCode).toBe(200);
      expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        providerMessageId: "template_with_text",
        type: "template",
        body: "Pedido de orçamento\nPreciso de chapa galvanizada."
      }) });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ lastMessagePreview: "Pedido de orçamento\nPreciso de chapa galvanizada." })
      }));
    } finally {
      await app.close();
    }
  });

  it("does not schedule the agent for a template or unknown event without readable content", async () => {
    const prisma = createMockPrisma();
    const persistInbound = vi.fn();
    const agentReply = vi.fn();
    const { app } = await buildEvolutionApp(prisma, undefined, {
      assistantScheduler: { persistInbound } as never,
      agentReplyScheduler: { scheduleActiveSessionForMessage: agentReply }
    });
    try {
      for (const [id, message, messageType] of [
        ["empty_template", { templateMessage: { hydratedTemplate: {} } }, "templateMessage"],
        ["unknown_event", { protocolMessage: {} }, "protocolMessage"]
      ] as const) {
        const response = await app.inject({ method: "POST", url: "/webhooks/evolution/workspace_a",
          headers: { "x-prymeira-talk-secret": "top_secret" },
          payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
            key: { ...validWebhookBody.data.key, id }, message, messageType
          } }
        });
        expect(response.statusCode).toBe(200);
        expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({
          providerMessageId: id, type: "system"
        }) });
      }
      expect(persistInbound).not.toHaveBeenCalled();
      expect(agentReply).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("shows WhatsApp reactions without scheduling an assistant reply", async () => {
    const prisma = createMockPrisma();
    const persistInbound = vi.fn().mockResolvedValue(undefined);
    const assistantMessage = vi.fn().mockResolvedValue(undefined);
    const agentReply = vi.fn().mockResolvedValue({ scheduled: true });
    const { app } = await buildEvolutionApp(prisma, undefined, {
      assistantScheduler: { persistInbound, message: assistantMessage } as never,
      agentReplyScheduler: { scheduleActiveSessionForMessage: agentReply }
    });
    try {
      const response = await app.inject({ method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { ...validWebhookBody, data: { ...validWebhookBody.data,
          key: { ...validWebhookBody.data.key, id: "reaction_1" },
          messageType: "reactionMessage", message: { reactionMessage: { text: "👍" } }
        } }
      });
      expect(response.statusCode).toBe(200);
      expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        providerMessageId: "reaction_1", type: "system", body: "Reagiu com 👍"
      }) });
      expect(persistInbound).not.toHaveBeenCalled();
      expect(assistantMessage).not.toHaveBeenCalled();
      expect(agentReply).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("prepares inbound audio before automations and reply scheduling", async () => {
    const messageCreate = vi.fn().mockImplementation(async (args) => ({
      id: "msg_1",
      sentByUserId: null,
      updatedAt: new Date("2026-05-20T12:00:00.000Z"),
      ...args.data
    }));
    const prisma = createMockPrisma({
      message: { create: messageCreate }
    });
    const prepareAudioMessage = vi.fn().mockResolvedValue({
      status: "completed",
      text: "Preciso de chapas lisas."
    });
    const agentRuntime = {
      activateForMessage: vi.fn().mockResolvedValue({ status: "completed" }),
      prepareAudioMessage
    };
    const scheduleActiveSessionForMessage = vi.fn().mockResolvedValue({ scheduled: true });
    const { app } = await buildEvolutionApp(prisma, undefined, {
      agentRuntime,
      agentReplyScheduler: { scheduleActiveSessionForMessage }
    });
    const audioPayload = {
      ...validWebhookBody,
      data: {
        ...validWebhookBody.data,
        key: { ...validWebhookBody.data.key, id: "provider_audio_immediate" },
        message: {
          base64: "YXVkaW8=",
          audioMessage: { mimetype: "audio/ogg; codecs=opus" }
        }
      }
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: audioPayload
      });

      expect(response.statusCode).toBe(200);
      expect(prepareAudioMessage).toHaveBeenCalledWith({
        workspaceId: "workspace_a",
        messageId: "msg_1"
      });
      expect(prepareAudioMessage.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(prisma.automationRule.findMany).mock.invocationCallOrder[0]!
      );
      expect(prepareAudioMessage.mock.invocationCallOrder[0]).toBeLessThan(
        scheduleActiveSessionForMessage.mock.invocationCallOrder[0]!
      );
    } finally {
      await app.close();
    }
  });

  it("does not run audio preparation for inbound text", async () => {
    const prepareAudioMessage = vi.fn();
    const agentRuntime = {
      activateForMessage: vi.fn().mockResolvedValue({ status: "completed" }),
      prepareAudioMessage
    };
    const scheduleActiveSessionForMessage = vi.fn().mockResolvedValue({ scheduled: true });
    const { app } = await buildEvolutionApp(createMockPrisma(), undefined, {
      agentRuntime,
      agentReplyScheduler: { scheduleActiveSessionForMessage }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(prepareAudioMessage).not.toHaveBeenCalled();
      expect(scheduleActiveSessionForMessage).toHaveBeenCalledWith({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        messageId: "msg_1"
      });
    } finally {
      await app.close();
    }
  });

  it("increments unread without regressing preview when an older inbound message arrives", async () => {
    const currentLastMessageAt = new Date("2026-05-21T12:00:00.000Z");
    const incomingMessageAt = new Date(validWebhookBody.data.messageTimestamp * 1000);
    const prisma = createMockPrisma({
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: currentLastMessageAt,
          lastMessagePreview: "Mensagem mais nova",
          unreadCount: 4,
          priority: "normal"
        }),
        upsert: vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          lastMessageAt: currentLastMessageAt
        })
      }
    });
    const { app, publish } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          createdAt: incomingMessageAt
        })
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: "conv_1"
          }
        },
        data: {
          unreadCount: { increment: 1 },
          hiddenUntilReply: false
        }
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conv_1",
          workspaceId: "workspace_a",
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: incomingMessageAt } }]
        },
        data: {
          lastMessageAt: incomingMessageAt,
          lastMessagePreview: "Oi",
          lastMessagePreviewAt: incomingMessageAt
        }
      });
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenNthCalledWith(2, {
        type: "conversation.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "conv_1",
          workspaceId: "workspace_a",
          lastMessageAt: currentLastMessageAt.toISOString(),
          lastMessagePreview: "Mensagem mais nova",
          unreadCount: 4
        })
      });
    } finally {
      await app.close();
    }
  });

  it("uses top-level Evolution push names for contacts without a local name", async () => {
    const contactCreateMock = vi.fn().mockResolvedValue({
      id: "contact_1",
      workspaceId: "workspace_a",
      phone: "554799990000",
      name: "Ana WhatsApp"
    });
    const prisma = createMockPrisma({
      contact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: contactCreateMock
      }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "MESSAGES_UPSERT",
          instance: "client-one",
          pushName: "Ana WhatsApp",
          data: {
            key: { id: "provider_msg_ana_1", remoteJid: "5547999990000@s.whatsapp.net", fromMe: false },
            message: { conversation: "Oi" },
            messageTimestamp: 1779300000
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(contactCreateMock).toHaveBeenCalledWith({
        data: {
          workspaceId: "workspace_a",
          phone: "554799990000",
          name: "Ana WhatsApp"
        }
      });
      expect(prisma.contact.updateMany).toHaveBeenCalledWith({
        where: {
          workspaceId: "workspace_a",
          phone: { in: ["554799990000", "5547999990000"] },
          name: null
        },
        data: { name: "Ana WhatsApp" }
      });
    } finally {
      await app.close();
    }
  });

  it("keeps an existing local contact name when Evolution sends a push name", async () => {
    const contactFindFirstMock = vi.fn().mockResolvedValue({
      id: "contact_1",
      workspaceId: "workspace_a",
      phone: "554799990000",
      name: "Ana Local"
    });
    const prisma = createMockPrisma({
      contact: {
        findFirst: contactFindFirstMock
      }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "MESSAGES_UPSERT",
          instance: "client-one",
          data: {
            key: { id: "provider_msg_ana_2", remoteJid: "5547999990000@s.whatsapp.net", fromMe: false },
            pushName: "Ana WhatsApp",
            message: { conversation: "Oi" },
            messageTimestamp: 1779300000
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(contactFindFirstMock).toHaveBeenCalledWith({
        where: {
          workspaceId: "workspace_a",
          phone: { in: ["554799990000", "5547999990000"] }
        },
        orderBy: { updatedAt: "desc" }
      });
      expect(prisma.contact.updateMany).toHaveBeenCalledWith({
        where: {
          workspaceId: "workspace_a",
          phone: { in: ["554799990000", "5547999990000"] },
          name: null
        },
        data: { name: "Ana WhatsApp" }
      });
    } finally {
      await app.close();
    }
  });

  it("does not use Evolution push names from outbound messages", async () => {
    const contactCreateMock = vi.fn().mockResolvedValue({
      id: "contact_1",
      workspaceId: "workspace_a",
      phone: "554799990000"
    });
    const prisma = createMockPrisma({
      contact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: contactCreateMock
      }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "MESSAGES_UPSERT",
          instance: "client-one",
          data: {
            key: { id: "provider_msg_ana_3", remoteJid: "5547999990000@s.whatsapp.net", fromMe: true },
            pushName: "Connected Account",
            message: { conversation: "Oi" },
            messageTimestamp: 1779300000
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(contactCreateMock).toHaveBeenCalledWith({
        data: {
          workspaceId: "workspace_a",
          phone: "554799990000"
        }
      });
      expect(prisma.contact.updateMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["Você", "556392370750", "103547450441825@lid"])("does not use the inbound push name %j as a contact name", async (pushName) => {
    const contactCreateMock = vi.fn().mockResolvedValue({
      id: "contact_1",
      workspaceId: "workspace_a",
      phone: "554799990000"
    });
    const prisma = createMockPrisma({
      contact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: contactCreateMock
      }
    });
    const { app } = await buildEvolutionApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: {
          event: "MESSAGES_UPSERT",
          instance: "client-one",
          data: {
            key: { id: "provider_msg_placeholder", remoteJid: "5547999990000@s.whatsapp.net", fromMe: false },
            pushName,
            message: { conversation: "Oi" },
            messageTimestamp: 1779300000
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(contactCreateMock).toHaveBeenCalledWith({
        data: {
          workspaceId: "workspace_a",
          phone: "554799990000"
        }
      });
      expect(prisma.contact.updateMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("ingests a new inbound text event and publishes a workspace-consistent message", async () => {
    const observeConversationActivity = vi.fn().mockResolvedValue({ status: "cancelled" });
    const observeMessage = vi.fn().mockResolvedValue(undefined);
    const { app, prisma, publish } = await buildEvolutionApp(undefined, undefined, {
      followupService: { observeConversationActivity },
      inboxTriage: { observeMessage }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(observeConversationActivity).toHaveBeenCalledWith({
        workspaceId: "workspace_a",
        conversationId: "conv_1",
        messageId: "msg_1",
        direction: "inbound",
        source: "customer"
      });
      expect(observeMessage).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "workspace_a", conversationId: "conv_1", messageId: "msg_1", direction: "inbound"
      }));
      expect(prisma.contact.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: "workspace_a",
          phone: { in: ["551199999999", "5511999999999"] }
        },
        orderBy: { updatedAt: "desc" }
      });
      const timestampDate = new Date(validWebhookBody.data.messageTimestamp * 1000);
      expect(prisma.conversation.upsert).toHaveBeenCalledWith({
        where: {
          workspaceId_channelId_contactId: {
            workspaceId: "workspace_a",
            channelId: "channel_1",
            contactId: "contact_1"
          }
        },
        create: expect.objectContaining({
          workspaceId: "workspace_a",
          channelId: "channel_1",
          contactId: "contact_1",
          unreadCount: 0
        }),
        update: {}
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          providerEventId: "messages.upsert:client-one:provider_msg_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          status: "delivered",
          createdAt: timestampDate
        })
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: {
          workspaceId_id: {
            workspaceId: "workspace_a",
            id: "conv_1"
          }
        },
        data: {
          unreadCount: { increment: 1 },
          hiddenUntilReply: false
        }
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conv_1",
          workspaceId: "workspace_a",
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: timestampDate } }]
        },
        data: {
          lastMessageAt: timestampDate,
          lastMessagePreview: "Oi",
          lastMessagePreviewAt: timestampDate
        }
      });

      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenNthCalledWith(1, {
        type: "message.created",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "msg_1",
          workspaceId: "workspace_a",
          conversationId: "conv_1",
          providerMessageId: "provider_msg_1",
          mediaUrl: null,
          sentByUserId: null
        })
      });
      expect(publish).toHaveBeenNthCalledWith(2, {
        type: "conversation.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: "conv_1",
          workspaceId: "workspace_a",
          lastMessageAt: "2026-05-20T12:00:00.000Z",
          lastMessagePreview: "Oi",
          unreadCount: 1
        })
      });

      const messageEvent = publish.mock.calls[0][0];
      const conversationEvent = publish.mock.calls[1][0];
      expect(messageSchema.parse(messageEvent.payload)).toEqual(messageEvent.payload);
      expect(conversationSchema.parse(conversationEvent.payload)).toEqual(conversationEvent.payload);
      expect(realtimeEventSchema.parse(messageEvent)).toEqual(messageEvent);
      expect(realtimeEventSchema.parse(conversationEvent)).toEqual(conversationEvent);
    } finally {
      await app.close();
    }
  });

  it("keeps a group message in its own conversation without running direct-chat observers", async () => {
    const groupJid = "120363024158769234@g.us";
    const participant = "5511999999999@s.whatsapp.net";
    const contact = { id: "group_contact", workspaceId: "workspace_a", phone: groupJid, name: "Equipe comercial", isGroup: true };
    const conversation = {
      id: "group_conversation", workspaceId: "workspace_a", channelId: "channel_1", contactId: contact.id,
      status: "open", assignedUserId: null, departmentId: null, lastMessageAt: new Date(),
      lastMessagePreview: "Bom dia", unreadCount: 1, priority: "normal", aiControlStatus: "human_controlled",
      aiControlUpdatedAt: null, activeAgentSessionId: null,
      channel: { displayName: "Client One", phoneNumber: null, provider: "evolution" }, contact,
      department: null, assignedUser: null
    };
    const metadata = { groupSender: { jid: participant, name: "Ana" } };
    const message = { id: "group_message", workspaceId: "workspace_a", conversationId: conversation.id,
      providerMessageId: "group_provider_1", direction: "inbound", type: "text", body: "Bom dia",
      mediaUrl: null, metadata, status: "delivered", sentByUserId: null, createdAt: new Date() };
    const prisma = createMockPrisma({ contact: { findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue(contact) },
      conversation: { findUnique: vi.fn().mockResolvedValue(conversation), upsert: vi.fn().mockResolvedValue(conversation) },
      message: { create: vi.fn().mockResolvedValue(message) } });
    const followup = vi.fn().mockResolvedValue({ status: "skipped" });
    const triage = vi.fn().mockResolvedValue(undefined);
    const assistant = vi.fn().mockResolvedValue(undefined);
    const groupInfo = vi.fn().mockResolvedValue({ subject: "Equipe comercial" });
    const { app, publish } = await buildEvolutionApp(prisma,
      { mode: "real", client: { getGroupInfo: groupInfo } } as never,
      { followupService: { observeConversationActivity: followup }, inboxTriage: { observeMessage: triage },
        assistantScheduler: { message: assistant, persistInbound: assistant } as never });
    try {
      const response = await app.inject({ method: "POST", url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: { event: "messages.upsert", instance: "client-one", data: {
          key: { id: "group_provider_1", remoteJid: groupJid, participant, fromMe: false },
          pushName: "Ana", message: { conversation: "Bom dia" }, messageTimestamp: 1779300000
        } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(groupInfo).toHaveBeenCalledWith({ instanceName: "client-one", groupJid });
      expect(prisma.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ workspaceId: "workspace_a", phone: groupJid,
          name: "Equipe comercial", isGroup: true })
      }));
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ aiControlStatus: "human_controlled", contactId: contact.id })
      }));
      expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ metadata }) });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "message.created",
        payload: expect.objectContaining({ senderName: "Ana", senderJid: participant }) }));
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation.updated",
        payload: expect.objectContaining({ isGroup: true, contactName: "Equipe comercial", contactPhone: null }) }));
      expect(followup).not.toHaveBeenCalled();
      expect(triage).not.toHaveBeenCalled();
      expect(assistant).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("keeps a group message when Evolution cannot provide its subject", async () => {
    const groupJid = '120363024158769234@g.us';
    const groupInfo = vi.fn().mockRejectedValue(new Error('Group info unavailable'));
    const { app, prisma } = await buildEvolutionApp(createMockPrisma({
      contact: { findFirst: vi.fn().mockResolvedValue(null) }
    }), { mode: 'real', client: { getGroupInfo: groupInfo } } as never);
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/evolution/workspace_a',
        headers: { 'x-prymeira-talk-secret': 'top_secret' }, payload: {
          event: 'messages.upsert', instance: 'client-one', data: {
            key: { id: 'group_fallback_1', remoteJid: groupJid, fromMe: false },
            message: { conversation: 'Olá' }, messageTimestamp: 1779300000
          }
        } });
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ phone: groupJid, isGroup: true, name: 'Grupo 58769234' })
      }));
    } finally { await app.close(); }
  });

  it("runs enabled automations after an inbound Evolution message is ingested", async () => {
    const automationRule = {
      id: "automation_1",
      workspaceId: "workspace_a",
      name: "Primeiro contato",
      status: "enabled",
      trigger: "message.received",
      conditions: {},
      actions: {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_first_message",
            position: { x: 0, y: 0 },
            data: { title: "Primeira mensagem", config: {} }
          },
          {
            id: "send-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { message: "Bem-vindo!" } }
          }
        ],
        edges: [{ id: "edge-1", source: "trigger-1", target: "send-1" }]
      },
      createdAt: new Date("2026-05-20T10:00:00.000Z"),
      updatedAt: new Date("2026-05-20T10:00:00.000Z")
    };
    const prisma = createMockPrisma({
      automationRule: {
        findMany: vi.fn().mockResolvedValue([automationRule])
      },
      message: {
        count: vi.fn().mockResolvedValue(0)
      }
    });
    const evolutionClient = {
      sendText: vi.fn().mockResolvedValue({ providerMessageId: "provider_auto_1", raw: {} }),
      sendMedia: vi.fn()
    };
    const { app, publish } = await buildEvolutionApp(prisma, {
      mode: "real",
      client: evolutionClient
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(evolutionClient.sendText).toHaveBeenCalledWith({
        instanceName: "client-one",
        number: "551199999999",
        text: "Bem-vindo!"
      });
      expect(prisma.automationRun.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            workspaceId: "workspace_a",
            ruleId: "automation_1",
            eventKey: "message.received:provider_msg_1",
            status: "completed"
          })
        })
      );
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "automation_run.created",
          workspaceId: "workspace_a"
        })
      );
    } finally {
      await app.close();
    }
  });
});

describe("legacy webhook delegation to the ingress", () => {
  const post = (app: Awaited<ReturnType<typeof buildEvolutionApp>>["app"], workspaceId: string) => app.inject({
    method: "POST", url: `/webhooks/evolution/${workspaceId}`, headers: { "x-prymeira-talk-secret": "top_secret" }, payload: validWebhookBody });
  it("refuses a delegated workspace without touching the database and keeps serving the others", async () => {
    const { app, prisma } = await buildEvolutionApp(createMockPrisma(), undefined, { delegatedWorkspaces: new Set(["delegated-ws"]) });
    const refused = await post(app, "delegated-ws");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ ok: false, error: "delegated_to_ingress" });
    expect(JSON.stringify(Object.values(prisma).flatMap((v) => (typeof v === "function" ? [(v as { mock?: { calls: unknown[] } }).mock?.calls] : [])))).not.toContain("delegated-ws");
    expect((await post(app, "other-ws")).statusCode).not.toBe(409);
  });
  it("refuses every workspace for '*' and still authenticates first", async () => {
    const { app } = await buildEvolutionApp(createMockPrisma(), undefined, { delegatedWorkspaces: "*" });
    expect((await post(app, "any")).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/webhooks/evolution/any", headers: { "x-prymeira-talk-secret": "wrong" }, payload: validWebhookBody })).statusCode).toBe(401);
  });
});

