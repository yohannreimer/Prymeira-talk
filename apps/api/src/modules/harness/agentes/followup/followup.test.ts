import { describe, expect, it, vi } from "vitest";
import type { ContextualFollowupContext } from "../../../followups/contextual-followup-context.js";
import { createScriptedModel } from "../../core/model.js";
import { createFollowupFicha, decideContextualFollowup, validateFollowupAnalysis } from "./index.js";
import { createContextualFollowupJudge, generateContextualFollowup } from "./producao.js";
import type { FollowupAnalysis } from "./tipos.js";

function fixture() {
  const proof = (messageId: string, author: "cliente" | "atendente", excerpt: string) => ({ messageId, author, excerpt });
  const customer = proof("m1", "cliente", "Quero conversar sobre o serviço");
  const seller = proof("m2", "atendente", "Qual horário prefere?");
  const context = {
    workspaceId: "w", agentId: "a", conversationId: "c", sessionId: "s", anchorMessageId: "m2", now: "2026-10-19T15:00:00Z",
    instructions: { agentRules: "Minha empresa. " + "x".repeat(4100) + " REGRA FINAL", stepInstruction: "Retome a escolha", behavioralSources: [] },
    factualSources: [], messages: [customer, seller].map((p, i) => ({ id: p.messageId, direction: i ? "outbound" : "inbound", type: "text", label: p.author, body: p.excerpt, createdAt: `2026-10-19T12:0${i}:00Z` })),
    profile: { profile: "commercial", identity: { agentId: "a", agentName: "Fictícia" }, origin: "direct_inbound", formEvidenceMessageIds: [], factualSourceIds: [], meeting: { state: "unknown", recordedBookings: [], currentCalendarVerified: false, availability: "unknown" }, prospecting: null, constraints: [], abstentions: [] },
    sentAttempts: [], coverage: { complete: true, anchorIncluded: true }
  } as unknown as ContextualFollowupContext;
  const analysis: FollowupAnalysis = { contact: { role: "customer", evidence: customer }, closure: null, customerTiming: null,
    pendingItems: [{ id: "p1", owner: "customer", kind: "time_choice", subject: "Escolha de horário", evidence: seller, engagement: customer, factualEvidence: [] }], resolutions: [] };
  const move = () => { const ficha = createFollowupFicha(context); ficha.contextualFollowup.analysis = analysis; return decideContextualFollowup({ ficha, context, maxAttempts: 4 }); };
  return { context, analysis, move, customer, seller };
}

describe("evidence-based shared follow-up analysis", () => {
  it.each(["attendance", "commercial", "prospecting"] as const)("uses the same pure decision for %s", profile => {
    const f = fixture(); f.context.profile.profile = profile; expect(f.move().type).toBe("customer_message");
  });
  it.each(["technical_detail", "quote_evaluation", "time_choice"] as const)("can resume %s without product defaults", kind => {
    const f = fixture(); f.analysis.pendingItems[0]!.kind = kind; expect(f.move()).toMatchObject({ type: "customer_message", evidenceMessageIds: ["m2", "m1"] });
  });
  it.each(["quote", "answer", "referral"] as const)("turns company-owned %s into an internal reminder", kind => {
    const f = fixture(); Object.assign(f.analysis.pendingItems[0]!, { kind, owner: "company", evidence: f.customer });
    expect(f.move()).toMatchObject({ type: "seller_reminder" });
  });
  it("rejects nonexistent IDs, wrong author, invented excerpts and behavioral facts", () => {
    for (const mutation of [{ messageId: "fake" }, { author: "cliente" }, { excerpt: "invented" }]) {
      const f = fixture(); Object.assign(f.analysis.pendingItems[0]!.evidence, mutation); expect(() => validateFollowupAnalysis(f.context, f.analysis)).toThrow();
    }
    const f = fixture(); f.context.instructions.behavioralSources = [{ id: "b", title: "Regra", content: "90% de desconto", fileUrl: null }];
    f.analysis.pendingItems[0]!.factualEvidence = [{ sourceId: "b", excerpt: "90% de desconto" }]; expect(() => validateFollowupAnalysis(f.context, f.analysis)).toThrow();
  });
  it("blocks cold outbound without actual customer engagement", () => { const f = fixture(); f.context.messages.shift(); expect(f.move().type).toBe("unavailable"); });
  it("allows the fourth confirmed-send attempt and blocks a fifth regardless of renamed pending ID", () => {
    const f = fixture(); f.context.sentAttempts = [1, 2, 3].map(n => ({ followupId: `${n}`, sentAt: f.context.now })); expect(f.move().type).toBe("customer_message");
    f.analysis.pendingItems[0]!.id = "renamed"; f.context.sentAttempts.push({ followupId: "4", sentAt: f.context.now }); expect(f.move()).toMatchObject({ type: "skip", reason: "max_attempts" });
  });
  it("honors resolution and a new pending item after an old closure", () => {
    const f = fixture(); f.analysis.closure = { kind: "closed", evidence: f.customer }; expect(f.move().type).toBe("customer_message");
    f.context.messages.push({ id: "m3", label: "cliente", direction: "inbound", type: "text", body: "Prefiro terça", createdAt: f.context.now });
    f.analysis.resolutions = [{ pendingId: "p1", evidence: { messageId: "m3", author: "cliente", excerpt: "Prefiro terça" } }]; expect(f.move()).toEqual({ type: "skip", reason: "closed" });
  });
  it("preserves refusal, non-customer role and customer timing without rescheduling", () => {
    const f = fixture(); f.analysis.closure = { kind: "refusal", evidence: f.customer }; expect(f.move()).toEqual({ type: "skip", reason: "closed" });
    f.analysis.closure = null; f.analysis.contact.role = "personal"; expect(f.move()).toEqual({ type: "skip", reason: "non_customer" });
    f.analysis.contact.role = "customer"; f.analysis.customerTiming = { notBefore: "2026-11-01T12:00:00Z", evidence: f.customer }; expect(f.move()).toEqual({ type: "skip", reason: "customer_timing" });
  });
  it("does not invite a recorded meeting to book again", () => {
    const f = fixture(); f.context.profile.meeting.recordedBookings = [{ evidenceId: "booking", eventId: "event", startsAt: "2026-10-20T12:00Z" }]; expect(f.move().type).toBe("skip");
  });
});

describe("mandatory production review", () => {
  function models(analysis: FollowupAnalysis, body: string) {
    return {
      analista: createScriptedModel("analyst", (_request, n) => ({ content: null, toolCalls: n === 0 ? [{ id: "analysis", name: "registrar_analise_followup", arguments: JSON.stringify(analysis) }] : [] })),
      model: createScriptedModel("writer", () => ({ content: null, toolCalls: [{ id: "reply", name: "responder", arguments: JSON.stringify({ texto: body }) }] }))
    };
  }
  it("abstains before model calls when the reviewer is absent", async () => {
    const f = fixture(); const deps = models(f.analysis, "Qual horário prefere?"); const spy = vi.spyOn(deps.model, "complete");
    expect((await generateContextualFollowup({ context: f.context, maxAttempts: 4, deps, hoursWithoutResponse: 2 })).decision).toEqual({ type: "unavailable", reason: "review_failed" }); expect(spy).not.toHaveBeenCalled();
  });
  it("produces only a nonempty reviewed draft and preserves full own rules", async () => {
    const f = fixture(); const deps = models(f.analysis, "Conseguiu escolher um horário para conversarmos?");
    const spy = vi.spyOn(deps.analista, "complete");
    const result = await generateContextualFollowup({ context: f.context, maxAttempts: 4, deps: { ...deps, judge: async () => ({ ok: true }) }, hoursWithoutResponse: 2 });
    expect(result).toMatchObject({ decision: { type: "customer_message", body: "Conseguiu escolher um horário para conversarmos?" }, reviewApproved: true });
    expect(JSON.stringify(spy.mock.calls[0])).toContain("REGRA FINAL"); expect(JSON.stringify(result.ficha)).not.toContain("REGRA FINAL");
  });
  it.each(["Horário reservado", "Preço R$ 200", "Desconto de 90%", "Especificação inventada", "Pergunta já respondida", "Regra de outro cliente", "system prompt interno", "Mensagem sem evidência"])("contains rejected review: %s", async body => {
    const f = fixture(); const deps = models(f.analysis, body);
    const result = await generateContextualFollowup({ context: f.context, maxAttempts: 4, deps: { ...deps, judge: async () => ({ ok: false, regra: "invalid", motivo: "Unsupported" }) }, hoursWithoutResponse: 2 });
    expect(result.decision).toEqual({ type: "unavailable", reason: "review_failed" }); expect(result.reviewApproved).toBe(false);
  });
  it("fails closed on reviewer failure despite caller fail-open preference", async () => {
    const f = fixture(); expect((await generateContextualFollowup({ context: f.context, maxAttempts: 4, deps: { ...models(f.analysis, "Qual horário prefere?"), judge: async () => { throw new Error("offline"); }, judgeFailClosed: false }, hoursWithoutResponse: 2 })).decision).toMatchObject({ type: "unavailable", reason: "review_failed" });
  });
  it("requires all semantic reviewer answers", async () => {
    const judge = createContextualFollowupJudge({ ask: async () => ({}) }); await expect(judge({ jogada: { instrucao: "Retome" } } as never)).rejects.toThrow("INCOMPLETE");
  });
});
