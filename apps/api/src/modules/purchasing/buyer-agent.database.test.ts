import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { createScriptedModel, toolCall, type ModelRequest } from "../harness/core/model.js";
import { createBuyerAgent } from "./buyer-agent.js";
import { createPurchasingService } from "./purchasing.service.js";

const url = process.env.PURCHASING_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/purchasing_test(?:\?|$)/.test(url)) {
  throw new Error("Refusing a non-disposable Purchasing test database.");
}

const text = (request: ModelRequest, role: "system" | "user") => {
  const found = role === "system" ? request.messages[0] : [...request.messages].reverse().find((message) => message.role === "user");
  return found && "content" in found && typeof found.content === "string" ? found.content : "";
};

/** Reader: "R$ 850 a cadeira, frete grátis, 10 dias, boleto 28" becomes a full quote. Writer: one line per move. */
const leitorEscritor = createScriptedModel("comprador-teste", (request) => {
  const isReader = text(request, "system").startsWith("Você é o leitor");
  if (isReader) {
    if (request.messages.some((message) => message.role === "tool")) return { content: null, toolCalls: [] };
    const itemId = text(request, "system").match(/\[id ([0-9a-f-]{36})\]/)?.[1];
    const last = text(request, "user").split("Última mensagem do contato:").at(-1) ?? "";
    const price = last.match(/R\$ ?(\d+)/)?.[1];
    if (/não trabalho/i.test(last)) return { content: null, toolCalls: [toolCall("marcar_declinou", { motivo: "Não trabalha com cadeiras." })] };
    if (!price || !itemId) return { content: null, toolCalls: [] };
    return { content: null, toolCalls: [toolCall("registrar_proposta", {
      itens: [{ itemId, precoUnitario: Number(price) }], frete: 0, prazoEntrega: "10 dias", pagamento: "boleto 28 dias", validade: "30/10/2026"
    })] };
  }
  const system = text(request, "system");
  const reply = /primeira mensagem/.test(system) ? "Boa tarde! Precisamos de 20 cadeiras giratórias. Pode mandar preço, frete, prazo e pagamento?"
    : /Faça a choradinha/.test(system) ? "Obrigado pela proposta! Consegue melhorar um pouco esse valor? A empresa vai escolher a melhor condição."
    : /cobrança/.test(system) ? "Oi! Conseguiu ver nosso pedido de orçamento?"
    : /não vai cotar/.test(system) ? "Obrigado pelo retorno!"
    : "Certo, obrigado!";
  return { content: null, toolCalls: [toolCall("responder", { texto: reply })] };
});

describe.skipIf(!url)("Buyer agent on PostgreSQL", () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? "postgresql://invalid/unused" } } });
  const purchasing = createPurchasingService(db);
  const workspaceId = `buyer-${randomUUID()}`;
  const actor = { workspaceId, userId: "user_owner" };
  let clock = new Date("2026-10-19T13:00:00.000Z"); // Monday, 10h in São Paulo
  const sent: Array<{ conversationId: string; body: string; metadata?: Record<string, unknown> }> = [];
  const agent = createBuyerAgent({
    prisma: db,
    purchasing,
    modelFor: async () => leitorEscritor,
    now: () => clock,
    outbound: {
      async createPendingOutboundMessage(input) {
        sent.push(input);
        const message = await db.message.create({ data: { workspaceId, conversationId: input.conversationId, direction: "outbound", type: "text",
          body: input.body, status: "sent", metadata: (input.metadata ?? {}) as object, createdAt: clock } });
        return { message: { id: message.id, status: "sent" } };
      }
    }
  });
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  afterAll(async () => { await db.$disconnect(); });

  it("asks, waits for a person in review mode, reads the quote into the comparison and asks once for a better price", async () => {
    await db.workspaceMirror.create({ data: { workspaceId, name: "Construtora Horizonte" } });
    const channel = await db.channel.create({ data: { workspaceId, provider: "evolution", providerKey: `inst-${randomUUID()}`, displayName: "Compras" } });
    const silva = await purchasing.createSupplier(workspaceId, { name: "Móveis Silva", phone: "47999990001" });
    let request = await purchasing.createRequest(actor, {
      title: "20 cadeiras", items: [{ description: "Cadeira giratória", quantity: 20, unit: "un" }],
      responseDeadline: "2026-10-23", deliveryDeadline: "2026-11-10", deliveryCep: "89201-000", supplierIds: [silva.id]
    });
    expect(request.agentChannels).toEqual([{ id: channel.id, name: "Compras" }]);
    request = await purchasing.startQuoting(actor, request.id, { agent: { mode: "review", channelId: channel.id } });
    expect(request).toMatchObject({ agentConnected: true, agent: { mode: "review", channel: { id: channel.id, name: "Compras" } } });
    const inviteId = request.invites[0]!.id;
    expect(request.invites[0]!.agent).toMatchObject({ stage: "nao_iniciado", working: true, draft: null });

    // Review mode: the opening waits as a draft; nothing goes out.
    expect(await agent.processDue({ workspaceId })).toBe(1);
    request = await purchasing.getRequest(workspaceId, request.id);
    expect(request.invites[0]!.agent?.draft).toMatchObject({ move: "abertura", text: expect.stringContaining("20 cadeiras") });
    expect(sent).toHaveLength(0);
    expect(await agent.processDue({ workspaceId })).toBe(0);

    request = await agent.sendDraft(actor, request.id, inviteId, "Boa tarde! Precisamos de 20 cadeiras giratórias. Preço, frete, prazo e pagamento?");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Preço, frete");
    expect(sent[0]!.metadata).toMatchObject({ source: "purchasing_agent", purchaseInviteId: inviteId, jogada: "abertura" });
    const invite = request.invites[0]!;
    expect(invite).toMatchObject({ status: "sent", agent: { stage: "abordado", draft: null } });
    expect(invite.conversationId).toBeTruthy();
    expect(request.events.map((event) => event.type)).toContain("agent_invite_sent");

    // The supplier answers with a full quote; the agent takes the message and answers after the burst window.
    advance(60 * 60_000);
    const inbound = await db.message.create({ data: { workspaceId, conversationId: invite.conversationId!, direction: "inbound", type: "text",
      body: "Oi! R$ 850 a cadeira, frete grátis, entrega em 10 dias, boleto 28 dias.", status: "delivered", createdAt: clock } });
    expect(await agent.claimInbound({ workspaceId, conversationId: invite.conversationId!, messageId: inbound.id })).toBe(true);
    expect(await agent.claimInbound({ workspaceId, conversationId: randomUUID(), messageId: inbound.id })).toBe(false);
    expect(await agent.processDue({ workspaceId })).toBe(0);
    advance(41_000);
    expect(await agent.processDue({ workspaceId })).toBe(1);

    request = await purchasing.getRequest(workspaceId, request.id);
    const quoted = request.invites[0]!;
    expect(quoted.quotes).toHaveLength(1);
    expect(quoted.quotes[0]).toMatchObject({ source: "agent", kind: "initial", freightCents: 0, paymentTerms: "boleto 28 dias", validUntil: "2026-10-30", totalCents: 1_700_000 });
    expect(quoted.agent?.draft).toMatchObject({ move: "choradinha" });

    const [first, second] = await Promise.allSettled([agent.sendDraft(actor, request.id, inviteId), agent.sendDraft(actor, request.id, inviteId)]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(sent.filter((message) => message.metadata?.jogada === "choradinha")).toHaveLength(1);
    request = await purchasing.getRequest(workspaceId, request.id);
    expect(request.invites[0]).toMatchObject({ status: "negotiating", agent: { stage: "choradinha" } });
    expect(request.events.map((event) => event.type)).toContain("agent_choradinha_sent");
    // A canceled request stops the agent.
    await purchasing.cancel(actor, request.id);
  });

  it("chases a supplier who went quiet, only in business hours, and gives up after the agreed number of chases", async () => {
    const channel = await db.channel.create({ data: { workspaceId, provider: "evolution", providerKey: `inst-${randomUUID()}` } });
    const quiet = await purchasing.createSupplier(workspaceId, { name: "Quieto Ltda", phone: "47999990009" });
    let request = await purchasing.createRequest(actor, {
      title: "cadeiras", items: [{ description: "Cadeira", quantity: 2, unit: "un" }],
      responseDeadline: "2026-10-30", deliveryDeadline: "2026-11-10", deliveryCep: "89201000", supplierIds: [quiet.id]
    });
    request = await purchasing.startQuoting(actor, request.id, { agent: { mode: "auto", channelId: channel.id } });
    sent.length = 0;
    expect(await agent.processDue({ workspaceId })).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.metadata).toMatchObject({ jogada: "abertura" });

    advance(23 * 3_600_000);
    expect(await agent.processDue({ workspaceId })).toBe(0);
    clock = new Date("2026-10-21T01:00:00.000Z"); // Tuesday 22h in São Paulo: past 24h but outside business hours
    expect(await agent.processDue({ workspaceId })).toBe(0);
    clock = new Date("2026-10-21T12:00:00.000Z");
    expect(await agent.processDue({ workspaceId })).toBe(1);
    expect(sent.at(-1)!.metadata).toMatchObject({ jogada: "cobranca" });
    clock = new Date("2026-10-22T12:30:00.000Z");
    expect(await agent.processDue({ workspaceId })).toBe(1);
    clock = new Date("2026-10-23T13:00:00.000Z");
    expect(await agent.processDue({ workspaceId })).toBe(1);
    expect(sent.filter((message) => message.metadata?.jogada === "cobranca")).toHaveLength(2);

    request = await purchasing.getRequest(workspaceId, request.id);
    expect(request.invites[0]).toMatchObject({ status: "no_response", followupCount: 2 });
    expect(await agent.processDue({ workspaceId })).toBe(0);
  });

  it("records a refusal as a decline and thanks the supplier", async () => {
    const channel = await db.channel.create({ data: { workspaceId, provider: "evolution", providerKey: `inst-${randomUUID()}` } });
    const nope = await purchasing.createSupplier(workspaceId, { name: "Nope", phone: "47999990010" });
    let request = await purchasing.createRequest(actor, {
      title: "cadeiras", items: [{ description: "Cadeira", quantity: 2, unit: "un" }],
      responseDeadline: "2026-10-30", deliveryDeadline: "2026-11-10", deliveryCep: "89201000", supplierIds: [nope.id]
    });
    request = await purchasing.startQuoting(actor, request.id, { agent: { mode: "auto", channelId: channel.id } });
    await agent.processDue({ workspaceId });
    request = await purchasing.getRequest(workspaceId, request.id);
    const conversationId = request.invites[0]!.conversationId!;
    advance(60_000);
    const inbound = await db.message.create({ data: { workspaceId, conversationId, direction: "inbound", type: "text", body: "Não trabalho com cadeiras, desculpa.", status: "delivered", createdAt: clock } });
    await agent.claimInbound({ workspaceId, conversationId, messageId: inbound.id });
    advance(41_000);
    sent.length = 0;
    expect(await agent.processDue({ workspaceId })).toBe(1);
    request = await purchasing.getRequest(workspaceId, request.id);
    expect(request.invites[0]).toMatchObject({ status: "declined", agent: { stage: "encerrado" } });
    expect(sent[0]!.body).toBe("Obrigado pelo retorno!");
  });
});
