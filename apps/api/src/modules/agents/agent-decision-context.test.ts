import { describe, expect, it } from "vitest";
import type { NormalizedConversationMessage } from "./conversation-context-builder.js";
import { buildAgentDecisionContext } from "./agent-decision-context.js";

function inbound(id: string, body: string): NormalizedConversationMessage {
  return { id, direction: "inbound", type: "text", label: "cliente", body, createdAt: null };
}

function outbound(id: string, body: string): NormalizedConversationMessage {
  return { id, direction: "outbound", type: "text", label: "atendente", body, createdAt: null };
}

describe("buildAgentDecisionContext", () => {
  it("keeps the latest 20 visible messages in order without cutting long bodies", () => {
    const messages = Array.from({ length: 22 }, (_, index) => inbound(`message-${index + 1}`, index === 20 ? "B".repeat(3_000) : `Mensagem ${index + 1}`));
    const result = buildAgentDecisionContext({ messages, currentMessageId: "message-22", effectiveText: "Mensagem 22" });

    expect(result.messages).toHaveLength(20);
    expect(result.messages[0]?.id).toBe("message-3");
    expect(result.messages.at(-1)?.id).toBe("message-22");
    expect(result.messages.find((item) => item.id === "message-21")?.body).toHaveLength(3_000);
  });

  it("uses processed text for the current media message", () => {
    const result = buildAgentDecisionContext({
      messages: [inbound("current", "[áudio]")],
      currentMessageId: "current",
      effectiveText: "Preciso de chapa de inox."
    });
    expect(result.messages[0]?.body).toBe("Preciso de chapa de inox.");
    expect(result.activeCustomerRequest).toBe("Preciso de chapa de inox.");
  });

  it("combines consecutive customer fragments but resets after an attendant reply", () => {
    const result = buildAgentDecisionContext({
      messages: [
        inbound("old", "Preciso de prazo de entrega"),
        outbound("answer", "Qual material precisa?"),
        inbound("product", "Barra para viga baldrame"),
        inbound("current", "10mm")
      ],
      currentMessageId: "current",
      effectiveText: "10mm"
    });
    expect(result.activeCustomerRequest).toBe("Barra para viga baldrame\n10mm");
    expect(result.formattedHistory).toContain("Preciso de prazo de entrega");
    expect(result.activeCustomerRequest).not.toContain("prazo de entrega");
  });

  it("appends an absent current message once and excludes notes", () => {
    const result = buildAgentDecisionContext({
      messages: [inbound("previous", "Barra lisa"), { ...inbound("note", "Segredo"), label: "nota interna", type: "internal_note" }],
      currentMessageId: "current",
      effectiveText: "12 metros"
    });
    expect(result.messages.map((message) => message.id)).toEqual(["previous", "current"]);
    expect(result.activeCustomerRequest).toBe("Barra lisa\n12 metros");
  });

  it("keeps at most three customer fragments in the primary retrieval query", () => {
    const result = buildAgentDecisionContext({
      messages: [inbound("old", "Falar de chapa"), inbound("one", "Barra"), inbound("two", "para viga baldrame"), inbound("current", "10mm")],
      currentMessageId: "current",
      effectiveText: "10mm"
    });
    expect(result.activeCustomerRequest).toBe("Barra\npara viga baldrame\n10mm");
  });
});
