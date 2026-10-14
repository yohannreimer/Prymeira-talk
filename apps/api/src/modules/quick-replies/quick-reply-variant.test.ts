import { describe, expect, it, vi } from "vitest";
import { createQuickRepliesService } from "./quick-replies.service.js";
import { acceptVariant } from "./quick-reply-variant.js";

const original = "{saudacao}, {primeiro_nome}! Quanto tempo que não nos falamos, sou o {vendedor} da Prymeira, queria voltar a ter contato contigo.";

describe("quick reply without the contact's name", () => {
  it("accepts a rewrite that drops the missing field and keeps the others and the message", () => {
    expect(acceptVariant(original, ["primeiro_nome"], { body: "{saudacao}! Quanto tempo que não nos falamos! Aqui é o {vendedor}, da Prymeira, queria voltar a ter contato contigo." })).toContain("{vendedor}");
    expect(acceptVariant(original, ["primeiro_nome"], { body: "{saudacao}, {primeiro_nome}!" })).toBeNull();
    expect(acceptVariant(original, ["primeiro_nome"], { body: "{saudacao}! Sua {empresa} merece. Quanto tempo que não nos falamos" })).toBeNull();
    expect(acceptVariant(original, ["primeiro_nome"], { body: "Olá! Temos promoções de pneus hoje." })).toBeNull();
    expect(acceptVariant(original, ["primeiro_nome"], "texto")).toBeNull();
  });
  it("asks the AI once, saves it, and reuses it until the message is edited", async () => {
    const row = { id: "q1", workspaceId: "w", title: "Tempo", body: original, category: null, ownerUserId: null, shortcut: "tempo", variants: {} as unknown,
      createdAt: new Date(), updatedAt: new Date() };
    const prisma = { quickReply: { findFirst: async () => row, update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data) } };
    const generate = vi.fn().mockResolvedValue({ reply: JSON.stringify({ body: "{saudacao}! Quanto tempo que não nos falamos, sou o {vendedor} da Prymeira, queria voltar a ter contato contigo." }) });
    const service = createQuickRepliesService(prisma as never);
    const ai = { provider: { generate }, model: "m" };
    expect(await service.variant({ workspaceId: "w", id: "q1", missing: ["primeiro_nome"], ai })).toMatchObject({ source: "ai", body: expect.stringContaining("{saudacao}!") });
    expect(await service.variant({ workspaceId: "w", id: "q1", missing: ["primeiro_nome"], ai })).toMatchObject({ source: "saved" });
    expect(generate).toHaveBeenCalledTimes(1);
    row.body = original.replace("Prymeira", "Villefer");
    expect(await service.variant({ workspaceId: "w", id: "q1", missing: ["primeiro_nome"], ai: null })).toEqual({ body: null, source: "none" });
  });
});
