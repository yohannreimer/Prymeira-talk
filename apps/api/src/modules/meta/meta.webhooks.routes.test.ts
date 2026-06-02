import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { metaWebhooksRoutes } from "./meta.webhooks.routes.js";

const metaTextPayload = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "222" },
            contacts: [{ wa_id: "5511999999999", profile: { name: "Cliente" } }],
            messages: [
              {
                id: "wamid_in_1",
                from: "5511999999999",
                timestamp: "1780401600",
                type: "text",
                text: { body: "Oi" }
              }
            ]
          }
        }
      ]
    }
  ]
};

function createMetaPayloadWithMessages(messages: Array<Record<string, unknown>>) {
  return {
    ...metaTextPayload,
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "222" },
              contacts: [{ wa_id: "5511999999999", profile: { name: "Cliente" } }],
              messages
            }
          }
        ]
      }
    ]
  };
}

function createMockPrisma(overrides: {
  integrationConfig?: { findUnique?: ReturnType<typeof vi.fn> };
  $transaction?: ReturnType<typeof vi.fn>;
  channel?: { findUnique?: ReturnType<typeof vi.fn> };
  contact?: {
    findFirst?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
  };
  conversation?: {
    upsert?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
    findUnique?: ReturnType<typeof vi.fn>;
  };
  message?: { create?: ReturnType<typeof vi.fn> };
} = {}) {
  const prisma = {
    integrationConfig: {
      findUnique:
        overrides.integrationConfig?.findUnique ??
        vi.fn().mockResolvedValue({
          mode: "real",
          status: "connected",
          settings: {
            enabled: true,
            wabaId: "111",
            phoneNumberId: "222",
            accessToken: "meta-token",
            webhookVerifyToken: "verify-me"
          }
        })
    },
    channel: {
      findUnique:
        overrides.channel?.findUnique ??
        vi.fn().mockResolvedValue({
          id: "channel_1"
        })
    },
    contact: {
      findFirst:
        overrides.contact?.findFirst ??
        vi.fn().mockResolvedValue({
          id: "contact_1",
          workspaceId: "local_workspace",
          phone: "551199999999"
        }),
      create:
        overrides.contact?.create ??
        vi.fn().mockResolvedValue({
          id: "contact_1",
          workspaceId: "local_workspace",
          phone: "551199999999",
          name: "Cliente"
        }),
      updateMany: overrides.contact?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 })
    },
    conversation: {
      upsert:
        overrides.conversation?.upsert ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "local_workspace",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: null,
          lastMessagePreview: null,
          unreadCount: 0,
          priority: "normal"
        }),
      update:
        overrides.conversation?.update ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "local_workspace",
          channelId: "channel_1",
          contactId: "contact_1"
        }),
      updateMany: overrides.conversation?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 }),
      findUnique:
        overrides.conversation?.findUnique ??
        vi.fn().mockResolvedValue({
          id: "conv_1",
          workspaceId: "local_workspace",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          assignedUserId: null,
          departmentId: null,
          lastMessageAt: new Date("2026-06-02T12:00:00.000Z"),
          lastMessagePreview: "Oi",
          unreadCount: 1,
          priority: "normal",
          channel: { displayName: "Meta WhatsApp", phoneNumber: "+55 11 99999-9999" },
          contact: { name: "Cliente", phone: "551199999999" },
          department: null,
          assignedUser: null,
          tags: []
        })
    },
    message: {
      create:
        overrides.message?.create ??
        vi.fn().mockResolvedValue({
          id: "msg_1",
          workspaceId: "local_workspace",
          conversationId: "conv_1",
          providerMessageId: "wamid_in_1",
          providerEventId: "meta:222:wamid_in_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "delivered",
          sentByUserId: null,
          createdAt: new Date(1780401600 * 1000)
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

async function buildMetaApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  await app.register(metaWebhooksRoutes);

  return { app, prisma, publish };
}

describe("Meta webhook routes", () => {
  it("returns the Meta challenge when the verify token matches active runtime settings", async () => {
    const { app } = await buildMetaApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/webhooks/meta/local_workspace?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123"
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("abc123");
      expect(response.headers["content-type"]).toContain("text/plain");
    } finally {
      await app.close();
    }
  });

  it("returns 403 when the Meta verify token does not match", async () => {
    const { app } = await buildMetaApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/webhooks/meta/local_workspace?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123"
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Invalid Meta webhook verification token." });
    } finally {
      await app.close();
    }
  });

  it("returns 400 when the Meta verification query is malformed", async () => {
    const { app } = await buildMetaApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/webhooks/meta/local_workspace?hub.mode=subscribe&hub.verify_token=verify-me"
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Invalid Meta webhook verification request."
      });
    } finally {
      await app.close();
    }
  });

  it("returns 409 for inactive Meta runtime without writing messages", async () => {
    const prisma = createMockPrisma({
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          status: "connected",
          settings: {
            enabled: false,
            wabaId: "111",
            phoneNumberId: "222",
            accessToken: "meta-token",
            webhookVerifyToken: "verify-me"
          }
        })
      }
    });
    const { app } = await buildMetaApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta/local_workspace",
        payload: metaTextPayload
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ ok: false, error: "meta_cloud_not_configured" });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("stores inbound Meta text messages and publishes realtime events", async () => {
    const { app, prisma, publish } = await buildMetaApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta/local_workspace",
        payload: metaTextPayload
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(prisma.channel.findUnique).toHaveBeenCalledWith({
        where: {
          workspaceId_provider_providerKey: {
            workspaceId: "local_workspace",
            provider: "meta_cloud",
            providerKey: "222"
          }
        },
        select: { id: true }
      });
      expect(prisma.contact.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: "local_workspace",
          phone: { in: ["551199999999", "5511999999999"] }
        },
        orderBy: { updatedAt: "desc" }
      });
      expect(prisma.contact.updateMany).toHaveBeenCalledWith({
        where: {
          workspaceId: "local_workspace",
          phone: { in: ["551199999999", "5511999999999"] },
          name: null
        },
        data: { name: "Cliente" }
      });
      expect(prisma.conversation.upsert).toHaveBeenCalledWith({
        where: {
          workspaceId_channelId_contactId: {
            workspaceId: "local_workspace",
            channelId: "channel_1",
            contactId: "contact_1"
          }
        },
        create: expect.objectContaining({
          workspaceId: "local_workspace",
          channelId: "channel_1",
          contactId: "contact_1",
          status: "open",
          unreadCount: 0,
          customerServiceWindowExpiresAt: new Date((1780401600 + 24 * 60 * 60) * 1000)
        }),
        update: {}
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "local_workspace",
          conversationId: "conv_1",
          providerMessageId: "wamid_in_1",
          providerEventId: "meta:222:wamid_in_1",
          direction: "inbound",
          type: "text",
          body: "Oi",
          mediaUrl: null,
          status: "delivered",
          createdAt: new Date(1780401600 * 1000)
        }
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: {
          workspaceId_id: {
            workspaceId: "local_workspace",
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
          workspaceId: "local_workspace",
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: new Date(1780401600 * 1000) } }]
        },
        data: {
          lastMessageAt: new Date(1780401600 * 1000),
          lastMessagePreview: "Oi"
        }
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conv_1",
          workspaceId: "local_workspace",
          OR: [
            { customerServiceWindowExpiresAt: null },
            {
              customerServiceWindowExpiresAt: {
                lt: new Date((1780401600 + 24 * 60 * 60) * 1000)
              }
            }
          ]
        },
        data: {
          customerServiceWindowExpiresAt: new Date((1780401600 + 24 * 60 * 60) * 1000)
        }
      });
      expect(publish).toHaveBeenCalledWith({
        type: "message.created",
        workspaceId: "local_workspace",
        payload: expect.objectContaining({
          id: "msg_1",
          providerMessageId: "wamid_in_1",
          body: "Oi"
        })
      });
      expect(publish).toHaveBeenCalledWith({
        type: "conversation.updated",
        workspaceId: "local_workspace",
        payload: expect.objectContaining({
          id: "conv_1",
          contactName: "Cliente",
          lastMessagePreview: "Oi"
        })
      });
    } finally {
      await app.close();
    }
  });

  it("continues processing later messages when an earlier message is a duplicate", async () => {
    const duplicateError = {
      code: "P2002",
      meta: { target: ["workspace_id", "provider_message_id"] }
    };
    const create = vi
      .fn()
      .mockRejectedValueOnce(duplicateError)
      .mockResolvedValueOnce({
        id: "msg_2",
        workspaceId: "local_workspace",
        conversationId: "conv_1",
        providerMessageId: "wamid_in_2",
        providerEventId: "meta:222:wamid_in_2",
        direction: "inbound",
        type: "text",
        body: "Tudo bem?",
        mediaUrl: null,
        status: "delivered",
        sentByUserId: null,
        createdAt: new Date(1780401610 * 1000)
      });
    const prisma = createMockPrisma({
      message: { create }
    });
    const { app, publish } = await buildMetaApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta/local_workspace",
        payload: createMetaPayloadWithMessages([
          {
            id: "wamid_in_1",
            from: "5511999999999",
            timestamp: "1780401600",
            type: "text",
            text: { body: "Oi" }
          },
          {
            id: "wamid_in_2",
            from: "5511999999999",
            timestamp: "1780401610",
            type: "text",
            text: { body: "Tudo bem?" }
          }
        ])
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, partial: true });
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            providerMessageId: "wamid_in_2",
            body: "Tudo bem?"
          })
        })
      );
      expect(publish).toHaveBeenCalledWith({
        type: "message.created",
        workspaceId: "local_workspace",
        payload: expect.objectContaining({
          id: "msg_2",
          providerMessageId: "wamid_in_2",
          body: "Tudo bem?"
        })
      });
    } finally {
      await app.close();
    }
  });

  it("continues processing valid messages when an earlier message targets a missing channel", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "channel_1" });
    const prisma = createMockPrisma({
      channel: { findUnique }
    });
    const { app, publish } = await buildMetaApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta/local_workspace",
        payload: createMetaPayloadWithMessages([
          {
            id: "wamid_in_1",
            from: "5511999999999",
            timestamp: "1780401600",
            type: "text",
            text: { body: "Oi" }
          },
          {
            id: "wamid_in_2",
            from: "5511999999999",
            timestamp: "1780401610",
            type: "text",
            text: { body: "Tudo bem?" }
          }
        ])
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, partial: true });
      expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerMessageId: "wamid_in_2",
          body: "Tudo bem?"
        })
      });
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "message.created",
          workspaceId: "local_workspace"
        })
      );
    } finally {
      await app.close();
    }
  });

  it("ignores inbound messages for a different Meta phone number", async () => {
    const { app, prisma } = await buildMetaApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta/local_workspace",
        payload: {
          ...metaTextPayload,
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: "different-phone" },
                    contacts: [{ wa_id: "5511999999999", profile: { name: "Cliente" } }],
                    messages: [
                      {
                        id: "wamid_in_1",
                        from: "5511999999999",
                        timestamp: "1780401600",
                        type: "text",
                        text: { body: "Oi" }
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, ignored: true });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("guards customer service window updates so older webhooks cannot move it backwards", async () => {
    const { app, prisma } = await buildMetaApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta/local_workspace",
        payload: metaTextPayload
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {}
        })
      );
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conv_1",
          workspaceId: "local_workspace",
          OR: [
            { customerServiceWindowExpiresAt: null },
            {
              customerServiceWindowExpiresAt: {
                lt: new Date((1780401600 + 24 * 60 * 60) * 1000)
              }
            }
          ]
        },
        data: {
          customerServiceWindowExpiresAt: new Date((1780401600 + 24 * 60 * 60) * 1000)
        }
      });
    } finally {
      await app.close();
    }
  });
});
