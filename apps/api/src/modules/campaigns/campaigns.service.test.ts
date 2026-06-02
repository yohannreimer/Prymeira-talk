import Fastify from "fastify";
import { realtimeEventSchema, type UserRole } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { campaignsRoutes } from "./campaigns.routes.js";
import { createCampaignsService } from "./campaigns.service.js";
import type { PrismaLike } from "./campaigns.service.js";

type MockPrisma = {
  campaign: {
    findMany: any;
    findFirst: any;
    create: any;
    update: any;
  };
  campaignRecipient: {
    findMany: any;
    upsert: any;
  };
  channel: {
    findFirst: any;
  };
  metaMessageTemplate: {
    findFirst: any;
  };
  integrationConfig: {
    findUnique: any;
  };
  contactBoard: {
    findFirst: any;
  };
  contactBoardMembership: {
    findMany: any;
  };
};

const campaignId = "00000000-0000-4000-8000-000000000201";
const boardId = "00000000-0000-4000-8000-000000000202";
const firstContactId = "00000000-0000-4000-8000-000000000203";
const secondContactId = "00000000-0000-4000-8000-000000000204";

const baseCampaign = {
  id: campaignId,
  workspaceId: "workspace_a",
  name: "Reativacao VIP",
  status: "draft" as const,
  audience: { type: "board", boardId },
  messageBody: "Oi {{name}}, temos uma novidade para voce.",
  templates: [],
  fallbackName: "cliente",
  cadence: {
    minDelaySeconds: 30,
    maxDelaySeconds: 90,
    batchSize: 2,
    pauseMinSeconds: 300,
    pauseMaxSeconds: 600
  },
  scheduledAt: null,
  mode: "simulated" as const,
  createdAt: new Date("2026-05-21T12:00:00.000Z"),
  updatedAt: new Date("2026-05-21T12:00:00.000Z")
};

const baseRecipients = [
  {
    id: "00000000-0000-4000-8000-000000000205",
    workspaceId: "workspace_a",
    campaignId,
    contactId: firstContactId,
    status: "sent_simulated",
    result: {
      mode: "simulated",
      result: "sent_simulated",
      messagePreview: "Oi Ana, temos uma novidade para voce."
    },
    createdAt: new Date("2026-05-21T12:01:00.000Z"),
    updatedAt: new Date("2026-05-21T12:01:00.000Z"),
    contact: {
      id: firstContactId,
      workspaceId: "workspace_a",
      name: "Ana",
      phone: "+5511999990001",
      email: null,
      company: null
    }
  },
  {
    id: "00000000-0000-4000-8000-000000000206",
    workspaceId: "workspace_a",
    campaignId,
    contactId: secondContactId,
    status: "sent_simulated",
    result: {
      mode: "simulated",
      result: "sent_simulated",
      messagePreview: "Oi Bruno, temos uma novidade para voce."
    },
    createdAt: new Date("2026-05-21T12:01:00.000Z"),
    updatedAt: new Date("2026-05-21T12:01:00.000Z"),
    contact: {
      id: secondContactId,
      workspaceId: "workspace_a",
      name: "Bruno",
      phone: "+5511999990002",
      email: null,
      company: null
    }
  }
];

function createMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma & PrismaLike {
  return {
    campaign: {
      findMany: overrides.campaign?.findMany ?? vi.fn().mockResolvedValue([baseCampaign]),
      findFirst: overrides.campaign?.findFirst ?? vi.fn().mockResolvedValue(baseCampaign),
      create: overrides.campaign?.create ?? vi.fn().mockResolvedValue(baseCampaign),
      update: overrides.campaign?.update ?? vi.fn().mockResolvedValue(baseCampaign)
    },
    campaignRecipient: {
      findMany:
        overrides.campaignRecipient?.findMany ?? vi.fn().mockResolvedValue(baseRecipients),
      upsert:
        overrides.campaignRecipient?.upsert ??
        vi.fn().mockImplementation(async (args) => ({
          ...baseRecipients.find(
            (recipient) => {
              const contactId = args.where.workspaceId_campaignId_contactId?.contactId;
              const audienceKey = args.where.workspaceId_campaignId_audienceKey?.audienceKey;
              return recipient.contactId === contactId || recipient.contactId === audienceKey;
            }
          ),
          ...args.create,
          ...args.update
        }))
    },
    channel: {
      findFirst:
        overrides.channel?.findFirst ??
        vi.fn().mockResolvedValue({
          id: "channel_1",
          workspaceId: "workspace_a",
          provider: "evolution",
          providerKey: "talk-workspace-a",
          status: "connected"
        })
    },
    metaMessageTemplate: {
      findFirst:
        overrides.metaMessageTemplate?.findFirst ??
        vi.fn().mockResolvedValue({
          id: "template_1",
          workspaceId: "workspace_a",
          wabaId: "waba_1",
          templateId: "meta_template_1",
          name: "reactivation_vip",
          language: "pt_BR",
          category: "MARKETING",
          status: "APPROVED",
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: "Ana" }]
            }
          ],
          syncedAt: new Date("2026-05-24T12:00:00.000Z"),
          createdAt: new Date("2026-05-24T12:00:00.000Z"),
          updatedAt: new Date("2026-05-24T12:00:00.000Z")
        })
    },
    integrationConfig: {
      findUnique:
        overrides.integrationConfig?.findUnique ??
        vi.fn().mockResolvedValue({
          mode: "real",
          status: "connected",
          settings: {
            enabled: true,
            wabaId: "waba_1",
            phoneNumberId: "phone_number_1",
            accessToken: "meta_access_token"
          }
        })
    },
    contactBoard: {
      findFirst:
        overrides.contactBoard?.findFirst ??
        vi.fn().mockResolvedValue({ id: boardId, workspaceId: "workspace_a" })
    },
    contactBoardMembership: {
      findMany:
        overrides.contactBoardMembership?.findMany ??
        vi.fn().mockResolvedValue([
          {
            contactId: firstContactId,
            contact: {
              id: firstContactId,
              workspaceId: "workspace_a",
              name: "Ana",
              phone: "+5511999990001"
            }
          },
          {
            contactId: secondContactId,
            contact: {
              id: secondContactId,
              workspaceId: "workspace_a",
              name: "Bruno",
              phone: "+5511999990002"
            }
          }
        ])
    }
  } as MockPrisma & PrismaLike;
}

async function buildCampaignsApp(input: {
  prisma?: MockPrisma & PrismaLike;
  role?: UserRole;
} = {}) {
  const app = Fastify({ logger: false });
  const prisma = input.prisma ?? createMockPrisma();
  const role = input.role ?? "manager";
  const publish = vi.fn();

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role };
  });
  await app.register(campaignsRoutes);

  return { app, prisma, publish };
}

describe("campaigns service", () => {
  it("creates simulated recipients from a board audience when sending a campaign", async () => {
    const prisma = createMockPrisma();
    const service = createCampaignsService(prisma);

    const result = await service.sendSimulated({
      workspaceId: "workspace_a",
      campaignId
    });

    expect(result).toEqual({
      mode: "simulated",
      result: "queued_simulated",
      recipientsCreated: 2
    });
    expect(prisma.contactBoardMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace_a", boardId }
      })
    );
    expect(prisma.campaignRecipient.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.campaignRecipient.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          workspaceId_campaignId_audienceKey: {
            workspaceId: "workspace_a",
            campaignId,
            audienceKey: firstContactId
          }
        },
        create: expect.objectContaining({
          workspaceId: "workspace_a",
          campaignId,
          contactId: firstContactId,
          status: "queued_simulated",
          result: expect.objectContaining({
            mode: "simulated",
            result: "queued_simulated"
          })
        })
      })
    );
  });

  it("builds a delayed simulated queue from imported rows with rotating templates and fallback names", async () => {
    const importedCampaign = {
      ...baseCampaign,
      audience: {
        type: "imported",
        rows: [
          { name: "", phone: "+5511999990001", fields: { company: "Prymeira" } },
          { name: "Maria", phone: "+5511999990002", fields: { company: "Acme" } },
          { phone: "+5511999990003", fields: { company: "Sem Nome" } }
        ]
      },
      templates: [
        "Oi {{name}}, novidade para {{company}}.",
        "{{name}}, passando para falar contigo."
      ],
      fallbackName: "cliente"
    };
    const upsert = vi.fn().mockImplementation(async (args) => args.create);
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(importedCampaign),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ ...importedCampaign, status: "completed" })
      },
      campaignRecipient: {
        findMany: vi.fn(),
        upsert
      }
    });
    const service = createCampaignsService(prisma, {
      now: () => new Date("2026-05-25T12:00:00.000Z")
    });

    const result = await service.sendSimulated({
      workspaceId: "workspace_a",
      campaignId
    });

    expect(result.recipientsCreated).toBe(3);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert.mock.calls[0]?.[0].create).toEqual(
      expect.objectContaining({
        audienceKey: "+5511999990001",
        contactId: null,
        scheduledAt: new Date("2026-05-25T12:00:00.000Z"),
        status: "queued_simulated",
        result: expect.objectContaining({
          messagePreview: "Oi cliente, novidade para Prymeira.",
          templateIndex: 0
        })
      })
    );
    expect(upsert.mock.calls[1]?.[0].create).toEqual(
      expect.objectContaining({
        audienceKey: "+5511999990002",
        scheduledAt: new Date("2026-05-25T12:01:00.000Z"),
        result: expect.objectContaining({
          messagePreview: "Maria, passando para falar contigo.",
          templateIndex: 1
        })
      })
    );
    expect(upsert.mock.calls[2]?.[0].create).toEqual(
      expect.objectContaining({
        audienceKey: "+5511999990003",
        scheduledAt: new Date("2026-05-25T12:07:00.000Z"),
        result: expect.objectContaining({
          messagePreview: "Oi cliente, novidade para Sem Nome.",
          templateIndex: 0
        })
      })
    );
  });

  it("sends a real campaign through the connected Evolution channel", async () => {
    const sendText = vi.fn().mockResolvedValue({ providerMessageId: "wamid_campaign_1", raw: {} });
    const upsert = vi.fn().mockImplementation(async (args) => args.create);
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({
          ...baseCampaign,
          templates: ["Oi {{name}}, campanha real."]
        }),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ ...baseCampaign, status: "completed", mode: "real" })
      },
      campaignRecipient: {
        findMany: vi.fn(),
        upsert
      }
    });
    const service = createCampaignsService(prisma, {
      evolution: {
        mode: "real",
        client: { sendText }
      },
      now: () => new Date("2026-05-25T12:00:00.000Z")
    });

    const result = await service.sendReal({
      workspaceId: "workspace_a",
      campaignId
    });

    expect(result).toEqual({
      mode: "real",
      result: "sent",
      recipientsCreated: 2,
      recipientsSent: 2,
      recipientsFailed: 0
    });
    expect(sendText).toHaveBeenCalledWith({
      instanceName: "talk-workspace-a",
      number: "+5511999990001",
      text: "Oi Ana, campanha real."
    });
    expect(upsert.mock.calls[0]?.[0].create).toEqual(
      expect.objectContaining({
        status: "sent",
        attempts: 1,
        providerMessageId: "wamid_campaign_1",
        sentAt: new Date("2026-05-25T12:00:00.000Z")
      })
    );
  });

  it("sends a Meta template campaign through the connected Meta channel", async () => {
    const sendTemplate = vi.fn().mockResolvedValue({
      providerMessageId: "wamid_meta_campaign_1",
      raw: { messages: [{ id: "wamid_meta_campaign_1" }] }
    });
    const upsert = vi.fn().mockImplementation(async (args) => args.create);
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(baseCampaign),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ ...baseCampaign, status: "completed", mode: "real" })
      },
      campaignRecipient: {
        findMany: vi.fn(),
        upsert
      },
      channel: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel_meta_1",
          workspaceId: "workspace_a",
          provider: "meta_cloud",
          providerKey: "phone_number_1",
          status: "connected"
        })
      }
    });
    const service = createCampaignsService(prisma, {
      meta: {
        phoneNumberId: "phone_number_1",
        client: { sendTemplate }
      },
      now: () => new Date("2026-05-25T12:00:00.000Z")
    });

    const result = await service.sendMetaTemplate({
      workspaceId: "workspace_a",
      campaignId,
      template: {
        name: "reactivation_vip",
        language: "pt_BR"
      }
    });

    expect(result).toEqual({
      mode: "real",
      result: "sent",
      recipientsCreated: 2,
      recipientsSent: 2,
      recipientsFailed: 0
    });
    expect(prisma.metaMessageTemplate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_a",
          name: "reactivation_vip",
          language: "pt_BR",
          status: "APPROVED"
        })
      })
    );
    expect(sendTemplate).toHaveBeenCalledWith({
      phoneNumberId: "phone_number_1",
      to: "+5511999990001",
      name: "reactivation_vip",
      language: "pt_BR",
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "Ana" }]
        }
      ]
    });
    expect(upsert.mock.calls[0]?.[0].create).toEqual(
      expect.objectContaining({
        status: "sent",
        attempts: 1,
        providerMessageId: "wamid_meta_campaign_1",
        sentAt: new Date("2026-05-25T12:00:00.000Z"),
        result: expect.objectContaining({
          mode: "real",
          result: "sent",
          templateName: "reactivation_vip",
          templateLanguage: "pt_BR"
        })
      })
    );
  });

  it("rejects Meta template campaigns when Meta runtime is not configured", async () => {
    const sendTemplate = vi.fn();
    const upsert = vi.fn();
    const prisma = createMockPrisma({
      campaignRecipient: {
        findMany: vi.fn(),
        upsert
      }
    });
    const service = createCampaignsService(prisma, {
      meta: {
        phoneNumberId: null,
        client: { sendTemplate }
      }
    });

    await expect(
      service.sendMetaTemplate({
        workspaceId: "workspace_a",
        campaignId,
        template: { name: "reactivation_vip", language: "pt_BR" }
      })
    ).rejects.toMatchObject({ code: "CAMPAIGN_META_NOT_CONFIGURED" });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects Meta template campaigns when no connected Meta channel exists", async () => {
    const sendTemplate = vi.fn();
    const upsert = vi.fn();
    const prisma = createMockPrisma({
      campaignRecipient: {
        findMany: vi.fn(),
        upsert
      },
      channel: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    });
    const service = createCampaignsService(prisma, {
      meta: {
        phoneNumberId: "phone_number_1",
        client: { sendTemplate }
      }
    });

    await expect(
      service.sendMetaTemplate({
        workspaceId: "workspace_a",
        campaignId,
        template: { name: "reactivation_vip", language: "pt_BR" }
      })
    ).rejects.toMatchObject({ code: "CAMPAIGN_CHANNEL_NOT_FOUND" });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects Meta template campaigns when no approved local template exists", async () => {
    const sendTemplate = vi.fn();
    const upsert = vi.fn();
    const prisma = createMockPrisma({
      campaignRecipient: {
        findMany: vi.fn(),
        upsert
      },
      metaMessageTemplate: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    });
    const service = createCampaignsService(prisma, {
      meta: {
        phoneNumberId: "phone_number_1",
        client: { sendTemplate }
      }
    });

    await expect(
      service.sendMetaTemplate({
        workspaceId: "workspace_a",
        campaignId,
        template: { name: "reactivation_vip", language: "pt_BR" }
      })
    ).rejects.toMatchObject({ code: "CAMPAIGN_TEMPLATE_NOT_FOUND" });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("marks Meta template campaigns as failed when any recipient send fails", async () => {
    const sendTemplate = vi
      .fn()
      .mockResolvedValueOnce({
        providerMessageId: "wamid_meta_campaign_1",
        raw: { messages: [{ id: "wamid_meta_campaign_1" }] }
      })
      .mockRejectedValueOnce(new Error("Meta rejected recipient"));
    const upsert = vi.fn().mockImplementation(async (args) => args.create);
    const update = vi.fn().mockResolvedValue({ ...baseCampaign, status: "failed", mode: "real" });
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(baseCampaign),
        create: vi.fn(),
        update
      },
      campaignRecipient: {
        findMany: vi.fn(),
        upsert
      },
      channel: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel_meta_1",
          workspaceId: "workspace_a",
          provider: "meta_cloud",
          providerKey: "phone_number_1",
          status: "connected"
        })
      }
    });
    const service = createCampaignsService(prisma, {
      meta: {
        phoneNumberId: "phone_number_1",
        client: { sendTemplate }
      }
    });

    const result = await service.sendMetaTemplate({
      workspaceId: "workspace_a",
      campaignId,
      template: { name: "reactivation_vip", language: "pt_BR" }
    });

    expect(result).toEqual({
      mode: "real",
      result: "sent",
      recipientsCreated: 2,
      recipientsSent: 1,
      recipientsFailed: 1
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          mode: "real"
        })
      })
    );
  });

  it("rejects audience resolution for campaigns outside the current workspace", async () => {
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    const service = createCampaignsService(prisma);

    await expect(
      service.resolveAudience({ workspaceId: "workspace_a", campaignId })
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_FOUND" });
    expect(prisma.contactBoardMembership.findMany).not.toHaveBeenCalled();
  });

  it("derives scheduled status when updating a campaign schedule without explicit status", async () => {
    const prisma = createMockPrisma();
    const service = createCampaignsService(prisma);

    await service.updateCampaign({
      workspaceId: "workspace_a",
      campaignId,
      data: {
        scheduledAt: "2026-05-22T12:00:00.000Z"
      }
    });

    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledAt: new Date("2026-05-22T12:00:00.000Z"),
          status: "scheduled"
        })
      })
    );
  });

  it("keeps completed campaign status when editing an empty schedule without explicit status", async () => {
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ ...baseCampaign, status: "completed" }),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ ...baseCampaign, status: "completed" })
      }
    });
    const service = createCampaignsService(prisma);

    await service.updateCampaign({
      workspaceId: "workspace_a",
      campaignId,
      data: {
        name: "Reativacao editada",
        scheduledAt: null
      }
    });

    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledAt: null,
          status: "completed"
        })
      })
    );
  });

  it("returns scheduled campaigns to draft when clearing schedule without explicit status", async () => {
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ ...baseCampaign, status: "scheduled" }),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({ ...baseCampaign, status: "draft" })
      }
    });
    const service = createCampaignsService(prisma);

    await service.updateCampaign({
      workspaceId: "workspace_a",
      campaignId,
      data: {
        scheduledAt: null
      }
    });

    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledAt: null,
          status: "draft"
        })
      })
    );
  });
});

describe("campaigns routes", () => {
  it("sends a simulated campaign from POST /campaigns/:campaignId/send-simulated", async () => {
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(baseCampaign)
          .mockResolvedValueOnce({
            ...baseCampaign,
            status: "completed",
            updatedAt: new Date("2026-05-21T12:05:00.000Z")
          }),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({
          ...baseCampaign,
          status: "completed",
          updatedAt: new Date("2026-05-21T12:05:00.000Z")
        })
      }
    });
    const { app, publish } = await buildCampaignsApp({ prisma });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/send-simulated`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        mode: "simulated",
        result: "queued_simulated",
        recipientsCreated: 2
      });
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "campaign.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: campaignId,
          workspaceId: "workspace_a",
          status: "completed"
        })
      });
    } finally {
      await app.close();
    }
  });

  it("sends a Meta template campaign from POST /campaigns/:campaignId/send-meta-template", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid_route_meta_1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const prisma = createMockPrisma({
      campaign: {
        findMany: vi.fn(),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(baseCampaign)
          .mockResolvedValueOnce({
            ...baseCampaign,
            status: "completed",
            mode: "real",
            updatedAt: new Date("2026-05-21T12:05:00.000Z")
          }),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({
          ...baseCampaign,
          status: "completed",
          mode: "real",
          updatedAt: new Date("2026-05-21T12:05:00.000Z")
        })
      },
      channel: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel_meta_1",
          workspaceId: "workspace_a",
          provider: "meta_cloud",
          providerKey: "phone_number_1",
          status: "connected"
        })
      }
    });
    const { app, publish } = await buildCampaignsApp({ prisma });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/campaigns/${campaignId}/send-meta-template`,
        payload: {
          template: {
            name: "reactivation_vip",
            language: "pt_BR"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        mode: "real",
        result: "sent",
        recipientsCreated: 2,
        recipientsSent: 2,
        recipientsFailed: 0
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(realtimeEventSchema.parse(publish.mock.calls[0]?.[0])).toEqual({
        type: "campaign.updated",
        workspaceId: "workspace_a",
        payload: expect.objectContaining({
          id: campaignId,
          workspaceId: "workspace_a",
          status: "completed",
          mode: "real"
        })
      });
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it.each([
    {
      method: "POST" as const,
      url: "/campaigns",
      payload: {
        name: "Reativacao VIP",
        audience: { type: "board", boardId },
        messageBody: "Oi {{name}}"
      }
    },
    {
      method: "PATCH" as const,
      url: `/campaigns/${campaignId}`,
      payload: { status: "scheduled" }
    },
    {
      method: "POST" as const,
      url: `/campaigns/${campaignId}/send-simulated`,
      payload: {}
    },
    {
      method: "POST" as const,
      url: `/campaigns/${campaignId}/send-meta-template`,
      payload: { template: { name: "reactivation_vip", language: "pt_BR" } }
    }
  ])("returns 403 for agents on $method $url", async ({ method, url, payload }) => {
    const { app, prisma } = await buildCampaignsApp({ role: "agent" });

    try {
      const response = await app.inject({ method, url, payload });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        code: "CAMPAIGN_MANAGE_FORBIDDEN",
        error: "Campaign management permission required."
      });
      expect(prisma.campaign.create).not.toHaveBeenCalled();
      expect(prisma.campaign.update).not.toHaveBeenCalled();
      expect(prisma.campaignRecipient.upsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
