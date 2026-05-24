import Fastify from "fastify";
import { contactSchema, conversationSchema, realtimeEventSchema } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { createContactsService } from "./contacts.service.js";
import type { PrismaLike } from "./contacts.service.js";
import { contactsRoutes } from "./contacts.routes.js";

type MockPrisma = {
  contact: {
    findMany: ReturnType<typeof vi.fn<PrismaLike["contact"]["findMany"]>>;
    create: ReturnType<typeof vi.fn<PrismaLike["contact"]["create"]>>;
    update: ReturnType<typeof vi.fn<PrismaLike["contact"]["update"]>>;
    findUnique: ReturnType<typeof vi.fn<PrismaLike["contact"]["findUnique"]>>;
    findFirst: ReturnType<typeof vi.fn<PrismaLike["contact"]["findFirst"]>>;
  };
  channel: {
    findFirst: ReturnType<typeof vi.fn<PrismaLike["channel"]["findFirst"]>>;
  };
  conversation: {
    upsert: ReturnType<typeof vi.fn<PrismaLike["conversation"]["upsert"]>>;
  };
};

const baseContact = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace_a",
  name: "Ana Silva",
  phone: "+5511999990000",
  email: "ana@example.com",
  company: "Prymeira",
  avatarUrl: null,
  customFields: {},
  atomicCrmContactId: null,
  atomicCrmLeadId: null,
  createdAt: new Date("2026-05-20T12:00:00.000Z"),
  updatedAt: new Date("2026-05-20T12:30:00.000Z")
};

function createMockPrisma(
  overrides: Partial<MockPrisma["contact"]> = {}
): MockPrisma {
  return {
    contact: {
      findMany:
        overrides.findMany ??
        vi.fn<PrismaLike["contact"]["findMany"]>().mockResolvedValue([baseContact]),
      create:
        overrides.create ??
        vi.fn<PrismaLike["contact"]["create"]>().mockResolvedValue(baseContact),
      update:
        overrides.update ??
        vi.fn<PrismaLike["contact"]["update"]>().mockResolvedValue({
          ...baseContact,
          name: "Ana Paula"
        }),
      findUnique:
        overrides.findUnique ??
        vi.fn<PrismaLike["contact"]["findUnique"]>().mockResolvedValue({ id: baseContact.id }),
      findFirst:
        overrides.findFirst ??
        vi.fn<PrismaLike["contact"]["findFirst"]>().mockResolvedValue(null)
    },
    channel: {
      findFirst: vi.fn<PrismaLike["channel"]["findFirst"]>().mockResolvedValue({ id: "channel_1" })
    },
    conversation: {
      upsert: vi.fn<PrismaLike["conversation"]["upsert"]>().mockResolvedValue({
        id: "conv_1",
        workspaceId: "workspace_a",
        channelId: "channel_1",
        contactId: baseContact.id,
        status: "open",
        assignedUserId: null,
        departmentId: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        unreadCount: 0,
        priority: "normal",
        channel: { displayName: "WhatsApp", phoneNumber: null },
        contact: { name: "Ana Silva", phone: "554791396920" },
        department: null,
        assignedUser: null
      })
    }
  };
}

async function buildContactsApp(prisma = createMockPrisma()) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "agent" };
  });
  await app.register(contactsRoutes);

  return { app, prisma, publish };
}

describe("contacts service", () => {
  it("lists contacts inside a workspace with stable ordering and limit", async () => {
    const prisma = createMockPrisma();
    const service = createContactsService(prisma);

    await service.listContacts({ workspaceId: "workspace_a" });

    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_a" },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
      take: 100
    });
  });

  it("adds search filters without dropping the workspace filter", async () => {
    const prisma = createMockPrisma();
    const service = createContactsService(prisma);

    await service.listContacts({ workspaceId: "workspace_a", search: "ana" });

    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "workspace_a",
          OR: [
            { name: { contains: "ana", mode: "insensitive" } },
            { company: { contains: "ana", mode: "insensitive" } },
            { email: { contains: "ana", mode: "insensitive" } },
            { phone: { contains: "ana", mode: "insensitive" } }
          ]
        }
      })
    );
  });

  it("creates contacts with workspace id and normalized optional fields", async () => {
    const prisma = createMockPrisma();
    const service = createContactsService(prisma);

    await service.createContact({
      workspaceId: "workspace_a",
      name: "",
      phone: "+5511999990000",
      email: "",
      company: " Prymeira "
    });

    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_a",
        name: null,
        phone: "551199990000",
        email: null,
        company: "Prymeira"
      }
    });
  });

  it("updates an existing contact when the only phone difference is the Brazilian ninth digit", async () => {
    const prisma = createMockPrisma({
      findFirst: vi.fn<PrismaLike["contact"]["findFirst"]>().mockResolvedValue({
        ...baseContact,
        phone: "554791396920"
      })
    });
    const service = createContactsService(prisma);

    const contact = await service.createContact({
      workspaceId: "workspace_a",
      name: "Yohann",
      phone: "5547991396920",
      email: "",
      company: "Prymeira"
    });

    expect(contact.id).toBe(baseContact.id);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_a",
        phone: { in: ["554791396920", "5547991396920"] }
      },
      orderBy: { updatedAt: "desc" }
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: baseContact.id
        }
      },
      data: {
        name: "Yohann",
        phone: "554791396920",
        email: null,
        company: "Prymeira"
      }
    });
  });

  it("updates contacts with the workspace/contact composite key", async () => {
    const prisma = createMockPrisma();
    const service = createContactsService(prisma);

    await service.updateContact({
      workspaceId: "workspace_a",
      contactId: baseContact.id,
      name: "Ana Paula",
      phone: "+5511888880000",
      email: "",
      company: ""
    });

    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace_a",
          id: baseContact.id
        }
      },
        data: {
          name: "Ana Paula",
          phone: "5511888880000",
          email: null,
          company: null
        }
      });
  });

  it("starts a conversation for a contact and channel", async () => {
    const prisma = createMockPrisma();
    const service = createContactsService(prisma);

    const conversation = await service.startConversation({
      workspaceId: "workspace_a",
      contactId: baseContact.id,
      channelId: "channel_1"
    });

    expect(conversationSchema.parse(conversation)).toEqual(conversation);
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_channelId_contactId: {
            workspaceId: "workspace_a",
            channelId: "channel_1",
            contactId: baseContact.id
          }
        }
      })
    );
  });
});

describe("contacts routes", () => {
  it("returns contacts for the request workspace", async () => {
    const { app, prisma } = await buildContactsApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/contacts?search=ana"
      });

      expect(response.statusCode).toBe(200);
      expect(contactSchema.array().parse(response.json())).toEqual(response.json());
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: "workspace_a" })
        })
      );
    } finally {
      await app.close();
    }
  });

  it("validates create payloads and returns created contacts", async () => {
    const { app } = await buildContactsApp();

    try {
      const invalid = await app.inject({
        method: "POST",
        url: "/contacts",
        payload: { name: "Ana" }
      });
      expect(invalid.statusCode).toBe(400);

      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        payload: {
          name: "Ana Silva",
          phone: "+5511999990000",
          email: "ana@example.com",
          company: "Prymeira"
        }
      });

      expect(response.statusCode).toBe(201);
      expect(contactSchema.parse(response.json())).toEqual(response.json());
    } finally {
      await app.close();
    }
  });

  it("publishes contact.updated for created contacts in the caller workspace", async () => {
    const { app, publish } = await buildContactsApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        payload: {
          name: "Ana Silva",
          phone: "+5511999990000"
        }
      });

      expect(response.statusCode).toBe(201);
      const event = publish.mock.calls[0]?.[0];
      expect(realtimeEventSchema.parse(event)).toEqual(event);
      expect(event).toEqual({
        type: "contact.updated",
        workspaceId: "workspace_a",
        payload: contactSchema.parse(response.json())
      });
    } finally {
      await app.close();
    }
  });

  it("returns conflict when create uses a duplicate phone in the workspace", async () => {
    const prisma = createMockPrisma({
      create: vi.fn<PrismaLike["contact"]["create"]>().mockRejectedValue({ code: "P2002" })
    });
    const { app } = await buildContactsApp(prisma);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        payload: {
          name: "Ana Silva",
          phone: "+5511999990000"
        }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "CONTACT_PHONE_CONFLICT",
        error: "A contact with this phone already exists."
      });
    } finally {
      await app.close();
    }
  });

  it("returns updated contacts from patch requests", async () => {
    const { app, prisma, publish } = await buildContactsApp();

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/contacts/${baseContact.id}`,
        payload: { name: "Ana Paula" }
      });

      expect(response.statusCode).toBe(200);
      expect(contactSchema.parse(response.json())).toEqual(response.json());
      expect(prisma.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            workspaceId_id: {
              workspaceId: "workspace_a",
              id: baseContact.id
            }
          }
        })
      );
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "contact.updated",
        workspaceId: "workspace_a",
        payload: contactSchema.parse(response.json())
      });
    } finally {
      await app.close();
    }
  });

  it("returns not found when patch cannot find the contact in the workspace", async () => {
    const prisma = createMockPrisma({
      update: vi.fn<PrismaLike["contact"]["update"]>().mockRejectedValue({ code: "P2025" })
    });
    const { app } = await buildContactsApp(prisma);

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/contacts/${baseContact.id}`,
        payload: { name: "Ana Paula" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "CONTACT_NOT_FOUND",
        error: "Contact not found."
      });
    } finally {
      await app.close();
    }
  });

  it("returns conflict when patch uses a duplicate phone in the workspace", async () => {
    const prisma = createMockPrisma({
      update: vi.fn<PrismaLike["contact"]["update"]>().mockRejectedValue({ code: "P2002" })
    });
    const { app } = await buildContactsApp(prisma);

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/contacts/${baseContact.id}`,
        payload: { phone: "+5511999990000" }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "CONTACT_PHONE_CONFLICT",
        error: "A contact with this phone already exists."
      });
    } finally {
      await app.close();
    }
  });
});
