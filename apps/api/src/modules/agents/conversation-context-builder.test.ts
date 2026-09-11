import { describe, expect, it, vi } from "vitest";
import { buildConversationContext } from "./conversation-context-builder.js";

const ids = {
  workspace: "workspace_a",
  conversation: "00000000-0000-4000-8000-000000000401"
};

describe("buildConversationContext", () => {
  it("loads stored history beyond 80 messages when complete context is requested", async () => {
    const messages = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, direction: "inbound", type: "text", body: i === 0 ? "Retirada em Joinville" : "continuação", createdAt: new Date(1000 * i) }));
    const prisma = { message: { findMany: vi.fn().mockResolvedValue(messages) } };
    const result = await buildConversationContext(prisma, { workspaceId: ids.workspace, conversationId: ids.conversation, complete: true });
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2001 }));
    expect(result.messages).toHaveLength(120);
    expect(result.formattedHistory).toContain("Retirada em Joinville");
  });
  it("refuses oversized complete history instead of silently dropping the beginning", async () => {
    const prisma = { message: { findMany: vi.fn().mockResolvedValue(Array.from({ length: 2001 }, (_, i) => ({ id: `m${i}`, body: "oi" }))) } };
    await expect(buildConversationContext(prisma, { workspaceId: ids.workspace, conversationId: ids.conversation, complete: true })).rejects.toThrow(/limite/i);
  });
  it("refuses the complete character limit even with few messages", async () => {
    const prisma = { message: { findMany: vi.fn().mockResolvedValue([{ id: "m", body: "x".repeat(120001) }]) } };
    await expect(buildConversationContext(prisma, { workspaceId: ids.workspace, conversationId: ids.conversation, complete: true })).rejects.toThrow(/limite/i);
  });
  it("loads recent conversation messages in chronological order and formats them for the LLM", async () => {
    const prisma = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message_1",
            direction: "inbound",
            type: "text",
            body: "Oi, vocês atendem hoje?",
            createdAt: new Date("2026-06-23T18:00:00.000Z")
          },
          {
            id: "message_2",
            direction: "outbound",
            type: "text",
            body: "Sim, atendemos até as 18h.",
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
      orderBy: [{ createdAt: "desc" }],
      take: 80
    });
    expect(result.messages).toEqual([
      {
        id: "message_1",
        direction: "inbound",
        type: "text",
        label: "cliente",
        body: "Oi, vocês atendem hoje?",
        createdAt: "2026-06-23T18:00:00.000Z"
      },
      {
        id: "message_2",
        direction: "outbound",
        type: "text",
        label: "atendente",
        body: "Sim, atendemos até as 18h.",
        createdAt: "2026-06-23T18:01:00.000Z"
      }
    ]);
    expect(result.formattedHistory).toBe(
      [
        "[2026-06-23T18:00:00.000Z] cliente: Oi, vocês atendem hoje?",
        "[2026-06-23T18:01:00.000Z] atendente: Sim, atendemos até as 18h."
      ].join("\n")
    );
  });

  it("loads the latest messages first and formats them chronologically", async () => {
    const prisma = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message_recent",
            direction: "inbound",
            type: "text",
            body: "Mensagem mais recente.",
            createdAt: new Date("2026-06-23T18:03:00.000Z")
          },
          {
            id: "message_previous",
            direction: "outbound",
            type: "text",
            body: "Mensagem anterior.",
            createdAt: new Date("2026-06-23T18:02:00.000Z")
          }
        ])
      }
    };

    const result = await buildConversationContext(prisma, {
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      limit: 2
    });

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }],
        take: 2
      })
    );
    expect(result.messages.map((message) => message.id)).toEqual([
      "message_previous",
      "message_recent"
    ]);
    expect(result.formattedHistory).toBe(
      [
        "[2026-06-23T18:02:00.000Z] atendente: Mensagem anterior.",
        "[2026-06-23T18:03:00.000Z] cliente: Mensagem mais recente."
      ].join("\n")
    );
  });

  it("omits internal notes and empty bodies from the default LLM context", async () => {
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
    expect(result.formattedHistory).toBe("");
  });

  it("can include internal notes when explicitly requested", async () => {
    const prisma = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "message_1",
            direction: "outbound",
            type: "internal_note",
            body: "Cliente prefere retorno a tarde.",
            createdAt: new Date("2026-06-23T18:02:00.000Z")
          }
        ])
      }
    };

    const result = await buildConversationContext(prisma, {
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      includeInternalNotes: true
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        id: "message_1",
        label: "nota interna",
        body: "Cliente prefere retorno a tarde."
      })
    ]);
    expect(result.formattedHistory).toBe(
      "[2026-06-23T18:02:00.000Z] nota interna: Cliente prefere retorno a tarde."
    );
  });
});
