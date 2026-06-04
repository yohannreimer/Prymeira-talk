import { describe, expect, it, vi } from "vitest";
import { realtimeEventSchema } from "@prymeira-talk/shared";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import { createAutomationRunner } from "./automation-runner.js";
import type { AutomationRunnerPrisma } from "./automation-runner.js";

const workspaceId = "workspace_a";
const automationId = "00000000-0000-4000-8000-000000000101";
const messageId = "00000000-0000-4000-8000-000000000201";
const conversationId = "00000000-0000-4000-8000-000000000301";
const contactId = "00000000-0000-4000-8000-000000000401";
const channelId = "00000000-0000-4000-8000-000000000501";

const currentMessage = {
  id: messageId,
  workspaceId,
  conversationId,
  providerMessageId: "wamid-inbound",
  providerEventId: "messages.upsert:instance:wamid-inbound",
  direction: "inbound",
  type: "text",
  body: "quero comprar agora",
  mediaUrl: null,
  status: "delivered",
  sentByUserId: null,
  createdAt: new Date("2026-05-24T12:00:00.000Z"),
  updatedAt: new Date("2026-05-24T12:00:00.000Z")
};

const conversation = {
  id: conversationId,
  workspaceId,
  channelId,
  contactId,
  status: "open",
  assignedUserId: null,
  departmentId: null,
  lastMessageAt: currentMessage.createdAt,
  lastMessagePreview: currentMessage.body,
  unreadCount: 1,
  priority: "normal",
  createdAt: new Date("2026-05-24T11:59:00.000Z"),
  updatedAt: new Date("2026-05-24T12:00:00.000Z"),
  contact: {
    id: contactId,
    phone: "5547991396920",
    name: "Yohann"
  },
  channel: {
    id: channelId,
    provider: "evolution",
    providerKey: "talk-instance",
    displayName: "WhatsApp"
  },
  tags: []
};

const baseRule = {
  id: automationId,
  workspaceId,
  name: "Boas-vindas real",
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
        data: { title: "Enviar mensagem", config: { message: "Ola! Como posso ajudar?" } }
      },
      {
        id: "tag-1",
        type: "add_tag",
        position: { x: 520, y: 0 },
        data: { title: "Adicionar tag", config: { tagName: "Novo lead" } }
      }
    ],
    edges: [
      { id: "edge-1", source: "trigger-1", target: "send-1" },
      { id: "edge-2", source: "send-1", target: "tag-1" }
    ]
  },
  createdAt: new Date("2026-05-24T11:00:00.000Z"),
  updatedAt: new Date("2026-05-24T11:00:00.000Z")
};

function createMockPrisma(overrides: Partial<AutomationRunnerPrisma> = {}) {
  const prisma = {
    automationRule: {
      findMany: vi.fn().mockResolvedValue([baseRule])
    },
    automationRun: {
      upsert: vi.fn().mockImplementation(async (args) => ({
        id: "00000000-0000-4000-8000-000000000901",
        workspaceId: args.create.workspaceId,
        ruleId: args.create.ruleId,
        eventKey: args.create.eventKey,
        status: args.create.status,
        input: args.create.input,
        result: args.create.result,
        createdAt: new Date("2026-05-24T12:00:01.000Z"),
        updatedAt: new Date("2026-05-24T12:00:01.000Z")
      }))
    },
    message: {
      findUnique: vi.fn().mockResolvedValue({ ...currentMessage, conversation }),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        ...currentMessage,
        id: "00000000-0000-4000-8000-000000000202",
        providerMessageId: "wamid-outbound",
        direction: "outbound",
        body: "Ola! Como posso ajudar?",
        status: "sent"
      })
    },
    conversation: {
      update: vi.fn().mockResolvedValue({
        ...conversation,
        lastMessagePreview: "Ola! Como posso ajudar?"
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    tag: {
      upsert: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000601",
        workspaceId,
        name: "Novo lead",
        color: "#2f5f4f"
      }),
      findFirst: vi.fn().mockResolvedValue(null)
    },
    conversationTag: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null)
    },
    contactBoardStage: {
      findFirst: vi.fn().mockResolvedValue(null)
    },
    contactBoardMembership: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({})
    },
    contactNote: {
      create: vi.fn().mockResolvedValue({})
    },
    ...(overrides as object)
  } as AutomationRunnerPrisma;

  return prisma;
}

describe("automation runner", () => {
  it("executes a first-message flow with real text send and tag actions", async () => {
    const prisma = createMockPrisma();
    const evolutionClient = {
      sendText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-outbound", raw: {} }),
      sendMedia: vi.fn()
    };
    const realtime = { publish: vi.fn() };
    const runner = createAutomationRunner({
      prisma,
      evolution: { mode: "real", client: evolutionClient },
      realtime
    });

    const runs = await runner.runForInboundMessage({
      workspaceId,
      messageId,
      eventKey: "message.received:wamid-inbound"
    });

    expect(evolutionClient.sendText).toHaveBeenCalledWith({
      instanceName: "talk-instance",
      number: "5547991396920",
      text: "Ola! Como posso ajudar?"
    });
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: messageId }
      })
    );
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId,
        conversationId,
        direction: "outbound",
        type: "text",
        body: "Ola! Como posso ajudar?",
        providerMessageId: "wamid-outbound",
        status: "sent"
      })
    });
    expect(prisma.tag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ workspaceId, name: "Novo lead" })
      })
    );
    expect(prisma.automationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId,
          ruleId: automationId,
          eventKey: "message.received:wamid-inbound",
          status: "completed",
          result: expect.objectContaining({ mode: "real" })
        })
      })
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toMatchObject({
      mode: "real",
      actionResults: [
        { nodeId: "trigger-1", status: "completed" },
        { nodeId: "send-1", status: "completed" },
        { nodeId: "tag-1", status: "completed" }
      ]
    });
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "automation_run.created", workspaceId })
    );
    expect(realtimeEventSchema.parse(realtime.publish.mock.calls[0]?.[0])).toEqual(
      expect.objectContaining({
        type: "automation_run.created",
        workspaceId,
        payload: expect.objectContaining({ workspaceId })
      })
    );
  });

  it("records a skipped run when a first-message trigger does not match", async () => {
    const prisma = createMockPrisma({
      message: {
        ...createMockPrisma().message,
        count: vi.fn().mockResolvedValue(1)
      }
    } as Partial<AutomationRunnerPrisma>);
    const runner = createAutomationRunner({
      prisma,
      evolution: {
        mode: "real",
        client: { sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const runs = await runner.runForInboundMessage({
      workspaceId,
      messageId,
      eventKey: "message.received:wamid-inbound"
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("skipped");
    expect(prisma.automationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "skipped",
          result: expect.objectContaining({
            skippedReason: "trigger_not_matched",
            actionResults: [
              expect.objectContaining({
                nodeId: "trigger-1",
                status: "skipped",
                message: "Trigger did not match this event."
              })
            ]
          })
        })
      })
    );
  });

  it("matches keyword triggers when any configured keyword is present", async () => {
    const keywordRule = {
      ...baseRule,
      actions: {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_keyword",
            position: { x: 0, y: 0 },
            data: { title: "Palavra-chave", config: { keywords: ["catalogo", "comprar", "suporte"] } }
          },
          {
            id: "send-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { message: "Te mando as opcoes agora." } }
          }
        ],
        edges: [{ id: "edge-1", source: "trigger-1", target: "send-1" }]
      }
    };
    const prisma = createMockPrisma({
      automationRule: { findMany: vi.fn().mockResolvedValue([keywordRule]) }
    } as Partial<AutomationRunnerPrisma>);
    const evolutionClient = {
      sendText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-keyword", raw: {} }),
      sendMedia: vi.fn()
    };
    const runner = createAutomationRunner({
      prisma,
      evolution: { mode: "real", client: evolutionClient }
    });

    const runs = await runner.runForInboundMessage({
      workspaceId,
      messageId,
      eventKey: "message.received:wamid-keyword"
    });

    expect(evolutionClient.sendText).toHaveBeenCalledWith({
      instanceName: "talk-instance",
      number: "5547991396920",
      text: "Te mando as opcoes agora."
    });
    expect(runs[0]?.result).toMatchObject({
      actionResults: [
        { nodeId: "trigger-1", status: "completed" },
        { nodeId: "send-1", status: "completed" }
      ]
    });
  });

  it("routes condition_text through yes and sends media files", async () => {
    const fileRule = {
      ...baseRule,
      actions: {
        version: 1,
        nodes: [
          baseRule.actions.nodes[0],
          {
            id: "condition-1",
            type: "condition_text",
            position: { x: 260, y: 0 },
            data: { title: "Texto contem comprar", config: { text: "comprar" } }
          },
          {
            id: "file-1",
            type: "send_file",
            position: { x: 520, y: -80 },
            data: {
              title: "Enviar PDF",
              config: {
                fileUrl: "data:application/pdf;base64,JVBERi0x",
                fileName: "proposta.pdf",
                mimetype: "application/pdf",
                caption: "Segue proposta"
              }
            }
          },
          {
            id: "tag-1",
            type: "add_tag",
            position: { x: 520, y: 80 },
            data: { title: "Adicionar tag", config: { tagName: "Nao comprar" } }
          }
        ],
        edges: [
          { id: "edge-1", source: "trigger-1", target: "condition-1" },
          { id: "edge-yes", source: "condition-1", target: "file-1", sourceHandle: "yes" },
          { id: "edge-no", source: "condition-1", target: "tag-1", sourceHandle: "no" }
        ]
      }
    };
    const prisma = createMockPrisma({
      automationRule: { findMany: vi.fn().mockResolvedValue([fileRule]) }
    } as Partial<AutomationRunnerPrisma>);
    const evolutionClient = {
      sendText: vi.fn(),
      sendMedia: vi.fn().mockResolvedValue({ providerMessageId: "wamid-file", raw: {} })
    };
    const runner = createAutomationRunner({
      prisma,
      evolution: { mode: "real", client: evolutionClient }
    });

    const runs = await runner.runForInboundMessage({
      workspaceId,
      messageId,
      eventKey: "message.received:wamid-inbound"
    });

    expect(evolutionClient.sendMedia).toHaveBeenCalledWith({
      instanceName: "talk-instance",
      number: "5547991396920",
      mediatype: "document",
      mimetype: "application/pdf",
      media: "data:application/pdf;base64,JVBERi0x",
      fileName: "proposta.pdf",
      caption: "Segue proposta"
    });
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
    expect(runs[0]?.result).toMatchObject({
      actionResults: [
        { nodeId: "trigger-1", status: "completed" },
        { nodeId: "condition-1", status: "completed", branch: "yes" },
        { nodeId: "file-1", status: "completed" }
      ]
    });
  });

  it("continues from a text step into an image step and records media node failures", async () => {
    const imageRule = {
      ...baseRule,
      actions: {
        version: 1,
        nodes: [
          baseRule.actions.nodes[0],
          {
            id: "send-1",
            type: "send_message",
            position: { x: 260, y: 0 },
            data: { title: "Enviar mensagem", config: { message: "Vou enviar a imagem." } }
          },
          {
            id: "image-1",
            type: "send_image",
            position: { x: 520, y: 0 },
            data: {
              title: "Enviar imagem",
              config: {
                fileUrl: "https://talk.prymeiradigital.com.br/uploads/automations/workspace_a/foto.jpeg",
                fileName: "foto.jpeg",
                mimetype: "image/jpeg",
                caption: "oiii"
              }
            }
          }
        ],
        edges: [
          { id: "edge-1", source: "trigger-1", target: "send-1" },
          { id: "edge-2", source: "send-1", target: "image-1" }
        ]
      }
    };
    const prisma = createMockPrisma({
      automationRule: { findMany: vi.fn().mockResolvedValue([imageRule]) }
    } as Partial<AutomationRunnerPrisma>);
    const evolutionClient = {
      sendText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-text", raw: {} }),
      sendMedia: vi.fn().mockRejectedValue(
        new EvolutionClientError(400, { message: "Media URL could not be downloaded" })
      )
    };
    const runner = createAutomationRunner({
      prisma,
      evolution: { mode: "real", client: evolutionClient }
    });

    const runs = await runner.runForInboundMessage({
      workspaceId,
      messageId,
      eventKey: "message.received:wamid-inbound"
    });

    expect(evolutionClient.sendText).toHaveBeenCalledWith({
      instanceName: "talk-instance",
      number: "5547991396920",
      text: "Vou enviar a imagem."
    });
    expect(evolutionClient.sendMedia).toHaveBeenCalledWith({
      instanceName: "talk-instance",
      number: "5547991396920",
      mediatype: "image",
      mimetype: "image/jpeg",
      media: "https://talk.prymeiradigital.com.br/uploads/automations/workspace_a/foto.jpeg",
      fileName: "foto.jpeg",
      caption: "oiii"
    });
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.result).toMatchObject({
      actionResults: [
        { nodeId: "trigger-1", status: "completed" },
        { nodeId: "send-1", status: "completed" },
        {
          nodeId: "image-1",
          status: "failed",
          error: "Evolution API request failed with status 400: Media URL could not be downloaded"
        }
      ]
    });
  });

  it("matches reengagement after the configured pause and can move CRM stage and close the conversation", async () => {
    const reengagementRule = {
      ...baseRule,
      actions: {
        version: 1,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger_reengagement",
            position: { x: 0, y: 0 },
            data: { title: "Retorno apos pausa", config: { pauseDays: 3 } }
          },
          {
            id: "move-1",
            type: "move_board_stage",
            position: { x: 260, y: 0 },
            data: { title: "Mover no CRM", config: { stageName: "Qualificado" } }
          },
          {
            id: "close-1",
            type: "close_conversation",
            position: { x: 520, y: 0 },
            data: { title: "Fechar conversa", config: {} }
          }
        ],
        edges: [
          { id: "edge-1", source: "trigger-1", target: "move-1" },
          { id: "edge-2", source: "move-1", target: "close-1" }
        ]
      }
    };
    const prisma = createMockPrisma({
      automationRule: { findMany: vi.fn().mockResolvedValue([reengagementRule]) },
      message: {
        ...createMockPrisma().message,
        count: vi.fn().mockResolvedValue(1),
        findFirst: vi.fn().mockResolvedValue({
          ...currentMessage,
          id: "00000000-0000-4000-8000-000000000199",
          createdAt: new Date("2026-05-20T11:59:00.000Z")
        })
      },
      contactBoardStage: {
        findFirst: vi.fn().mockResolvedValue({
          id: "00000000-0000-4000-8000-000000000701",
          boardId: "00000000-0000-4000-8000-000000000801",
          name: "Qualificado"
        })
      }
    } as Partial<AutomationRunnerPrisma>);
    const runner = createAutomationRunner({
      prisma,
      evolution: {
        mode: "real",
        client: { sendText: vi.fn(), sendMedia: vi.fn() }
      }
    });

    const runs = await runner.runForInboundMessage({
      workspaceId,
      messageId,
      eventKey: "message.received:wamid-inbound"
    });

    expect(prisma.contactBoardMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId,
          contactId,
          stageId: "00000000-0000-4000-8000-000000000701"
        })
      })
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: conversationId } },
      data: { status: "closed" }
    });
    expect(runs[0]?.status).toBe("completed");
  });

  it("routes channel and time conditions without executing the wrong branch", async () => {
    const conditionalRule = {
      ...baseRule,
      actions: {
        version: 1,
        nodes: [
          baseRule.actions.nodes[0],
          {
            id: "channel-condition",
            type: "condition_channel",
            position: { x: 260, y: 0 },
            data: { title: "Canal WhatsApp", config: { providerKey: "talk-instance" } }
          },
          {
            id: "time-condition",
            type: "condition_time",
            position: { x: 520, y: 0 },
            data: { title: "Horario comercial", config: { startTime: "08:00", endTime: "18:00" } }
          },
          {
            id: "send-yes",
            type: "send_message",
            position: { x: 780, y: -80 },
            data: { title: "Enviar dentro do horario", config: { message: "Estamos online" } }
          },
          {
            id: "send-no",
            type: "send_message",
            position: { x: 780, y: 80 },
            data: { title: "Enviar fora do horario", config: { message: "Voltamos amanha" } }
          }
        ],
        edges: [
          { id: "edge-1", source: "trigger-1", target: "channel-condition" },
          { id: "edge-channel-yes", source: "channel-condition", target: "time-condition", sourceHandle: "yes" },
          { id: "edge-channel-no", source: "channel-condition", target: "send-no", sourceHandle: "no" },
          { id: "edge-time-yes", source: "time-condition", target: "send-yes", sourceHandle: "yes" },
          { id: "edge-time-no", source: "time-condition", target: "send-no", sourceHandle: "no" }
        ]
      }
    };
    const prisma = createMockPrisma({
      automationRule: { findMany: vi.fn().mockResolvedValue([conditionalRule]) },
      message: {
        ...createMockPrisma().message,
        findUnique: vi.fn().mockResolvedValue({
          ...currentMessage,
          createdAt: new Date("2026-05-24T13:00:00.000Z"),
          conversation
        }),
        count: vi.fn().mockResolvedValue(0)
      }
    } as Partial<AutomationRunnerPrisma>);
    const evolutionClient = {
      sendText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-online", raw: {} }),
      sendMedia: vi.fn()
    };
    const runner = createAutomationRunner({
      prisma,
      evolution: { mode: "real", client: evolutionClient }
    });

    const runs = await runner.runForInboundMessage({
      workspaceId,
      messageId,
      eventKey: "message.received:wamid-inbound"
    });

    expect(evolutionClient.sendText).toHaveBeenCalledTimes(1);
    expect(evolutionClient.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Estamos online" })
    );
    expect(runs[0]?.result).toMatchObject({
      actionResults: [
        { nodeId: "trigger-1", status: "completed" },
        { nodeId: "channel-condition", branch: "yes" },
        { nodeId: "time-condition", branch: "yes" },
        { nodeId: "send-yes", status: "completed" }
      ]
    });
  });
});
