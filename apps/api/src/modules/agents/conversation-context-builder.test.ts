import { describe, expect, it, vi } from "vitest";
import { buildConversationContext } from "./conversation-context-builder.js";

const ids = {
  workspace: "workspace_a",
  conversation: "00000000-0000-4000-8000-000000000401"
};

describe("buildConversationContext", () => {
  it("loads recent conversation messages in chronological order and formats them for the LLM", async () => {
    const prisma = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message_1",
            direction: "inbound",
            type: "text",
            body: "Oi, voces atendem hoje?",
            createdAt: new Date("2026-06-23T18:00:00.000Z")
          },
          {
            id: "message_2",
            direction: "outbound",
            type: "text",
            body: "Sim, atendemos ate as 18h.",
            createdAt: "2026-06-23T18:01:00.000Z"
          }
        ])
      }
    };

    const result = await buildConversationContext(prisma, {
      workspaceId: ids.workspace,
      conversationId: ids.conversation
    });

    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: ids.workspace,
        conversationId: ids.conversation
      },
      orderBy: [{ createdAt: "asc" }],
      take: 80
    });
    expect(result.messages).toEqual([
      {
        id: "message_1",
        direction: "inbound",
        type: "text",
        label: "cliente",
        body: "Oi, voces atendem hoje?",
        createdAt: "2026-06-23T18:00:00.000Z"
      },
      {
        id: "message_2",
        direction: "outbound",
        type: "text",
        label: "atendente",
        body: "Sim, atendemos ate as 18h.",
        createdAt: "2026-06-23T18:01:00.000Z"
      }
    ]);
    expect(result.formattedHistory).toBe(
      [
        "[2026-06-23T18:00:00.000Z] cliente: Oi, voces atendem hoje?",
        "[2026-06-23T18:01:00.000Z] atendente: Sim, atendemos ate as 18h."
      ].join("\n")
    );
  });

  it("labels internal notes and omits empty bodies from formatted history", async () => {
    const prisma = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message_1",
            direction: "outbound",
            type: "internal_note",
            body: "Cliente prefere retorno a tarde.",
            createdAt: new Date("2026-06-23T18:02:00.000Z")
          },
          {
            id: "message_2",
            direction: "inbound",
            type: "text",
            body: "   ",
            createdAt: new Date("2026-06-23T18:03:00.000Z")
          },
          {
            id: "message_3",
            direction: "system",
            type: "system",
            body: null,
            createdAt: null
          }
        ])
      }
    };

    const result = await buildConversationContext(prisma, {
      workspaceId: ids.workspace,
      conversationId: ids.conversation
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        id: "message_1",
        label: "nota interna",
        body: "Cliente prefere retorno a tarde.",
        createdAt: "2026-06-23T18:02:00.000Z"
      }),
      expect.objectContaining({
        id: "message_2",
        label: "cliente",
        body: "   ",
        createdAt: "2026-06-23T18:03:00.000Z"
      }),
      expect.objectContaining({
        id: "message_3",
        label: "sistema",
        body: null,
        createdAt: null
      })
    ]);
    expect(result.formattedHistory).toBe(
      "[2026-06-23T18:02:00.000Z] nota interna: Cliente prefere retorno a tarde."
    );
  });
});
