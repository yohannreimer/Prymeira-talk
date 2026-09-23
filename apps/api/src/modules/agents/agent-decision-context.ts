import type { NormalizedConversationMessage } from "./conversation-context-builder.js";

export function buildAgentDecisionContext(input: {
  messages: NormalizedConversationMessage[];
  currentMessageId: string;
  effectiveText: string;
}) {
  const visible = input.messages
    .filter((message) => message.label === "cliente" || message.label === "atendente")
    .map((message) => message.id === input.currentMessageId
      ? { ...message, body: input.effectiveText }
      : message);

  if (!visible.some((message) => message.id === input.currentMessageId)) {
    visible.push({
      id: input.currentMessageId,
      direction: "inbound",
      label: "cliente",
      type: "text",
      body: input.effectiveText,
      createdAt: null
    });
  }

  const messages = visible.slice(-20);
  const formattedHistory = messages
    .filter((message) => Boolean(message.body?.trim()))
    .map((message) => `[${message.createdAt ?? "sem data"}] ${message.label}: ${message.body?.trim()}`)
    .join("\n");
  const customerBurst: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.label !== "cliente") break;
    if (message.body?.trim()) customerBurst.unshift(message.body.trim());
    if (customerBurst.length >= 3) break;
  }

  return {
    messages,
    formattedHistory,
    activeCustomerRequest: customerBurst.join("\n") || input.effectiveText
  };
}
