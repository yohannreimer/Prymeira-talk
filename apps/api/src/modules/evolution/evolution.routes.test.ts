import Fastify from "fastify";
import { conversationSchema, messageSchema, realtimeEventSchema } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { evolutionRoutes, isUniqueConstraintError } from "./evolution.routes.js";
import { evolutionWebhookEnvelopeSchema, evolutionWebhookSchema } from "./evolution.schemas.js";

const validWebhookBody = {
  event: "messages.upsert",
  instance: "client-one",
  data: {
    key: { id: "provider_msg_1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "Oi" },
    messageTimestamp: 1779300000
  }
};

function createMockPrisma(overrides: {
  $transaction?: ReturnType<typeof vi.fn>;
  channel?: { findUnique?: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> };
  contact?: {
    findFirst?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
  };
  conversation?: {
    findUnique?: ReturnType<typeof vi.fn>;
    upsert?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
  };
  message?: {
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
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
    message: {
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
    }
  };

  return {
    ...prisma,
    $transaction:
      overrides.$transaction ??
      vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma))
  };
}

async function buildEvolutionApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  await app.register(evolutionRoutes, { webhookSecret: "top_secret" });

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
        select: { id: true }
      });
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
          mediaUrl: "https://media.example.com/image.jpg"
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
          audioMessage: {
            mimetype: "audio/ogg",
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
          body: "Audio recebido",
          mediaUrl: "https://media.example.com/audio.ogg"
        })
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerMessageId: "provider_sticker_1",
          type: "image",
          body: "Figurinha recebida",
          mediaUrl: "https://media.example.com/sticker.webp"
        })
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
          unreadCount: { increment: 1 }
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
          lastMessagePreview: "Oi"
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

  it("ingests a new inbound text event and publishes a workspace-consistent message", async () => {
    const { app, prisma, publish } = await buildEvolutionApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution/workspace_a",
        headers: { "x-prymeira-talk-secret": "top_secret" },
        payload: validWebhookBody
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
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
          unreadCount: { increment: 1 }
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
          lastMessagePreview: "Oi"
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
});
