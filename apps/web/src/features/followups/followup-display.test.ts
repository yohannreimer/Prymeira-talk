import type { ConversationFollowupDto } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import {
  followupKindLabel,
  followupPurposeLabel,
  followupReasonLabel,
  followupStatusLabel,
  formatFollowupDate,
  matchesFollowupFilter
} from "./followup-display";

const reviewFollowup: ConversationFollowupDto = {
  id: "followup-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  kind: "qualification",
  status: "review",
  stepIndex: 1,
  scheduledAt: "2026-09-22T15:30:00.000Z",
  draftBody: "Ainda precisa de ajuda com as medidas?",
  contact: { name: "Ana Souza", phone: "+5547999991010" },
  channel: { displayName: "Villefer Geral" },
  anchorMessage: {
    id: "message-1",
    body: "Ainda vou separar as medidas.",
    type: "text",
    createdAt: "2026-09-22T11:50:00.000Z"
  },
  purpose: "missing_qualification",
  reasonCode: "jev_human_review",
  analysis: null,
  createdAt: "2026-09-22T12:00:00.000Z",
  updatedAt: "2026-09-22T14:00:00.000Z"
};

describe("followup display", () => {
  it("formats dates in the Talk business timezone", () => {
    expect(formatFollowupDate(reviewFollowup.scheduledAt, {
      locale: "pt-BR",
      timeZone: "America/Sao_Paulo",
      now: new Date("2026-09-22T12:00:00.000Z")
    })).toMatch(/22 de set.*12:30/i);
  });

  it("provides labels for kind, status and the allowlisted JEV purpose", () => {
    expect(followupKindLabel(reviewFollowup.kind)).toBe("Qualificação");
    expect(followupStatusLabel(reviewFollowup.status)).toBe("Para revisar");
    expect(followupPurposeLabel(reviewFollowup)).toBe("Completar dados da qualificação");
    expect(followupPurposeLabel({
      ...reviewFollowup,
      kind: "human_commercial",
      purpose: "proposal_checkin"
    })).toBe("Retomar proposta enviada");
    expect(followupPurposeLabel({ ...reviewFollowup, purpose: null })).toBe("Continuidade da conversa");
    expect(followupPurposeLabel({ ...reviewFollowup, purpose: "none" })).toBe("Continuidade da conversa");
  });

  it("translates safe reason categories and uses neutral active fallbacks", () => {
    expect(followupReasonLabel("customer_replied")).toContain("cliente respondeu");
    expect(followupReasonLabel("provider_new_reason")).toContain("mudança no contexto");
    expect(followupReasonLabel("jev_human_review")).toContain("revisão humana");
    expect(followupReasonLabel("agent_unavailable")).toContain("agente responsável");
    expect(followupReasonLabel("context_unavailable")).toContain("contexto da conversa");
    expect(followupReasonLabel("handoff_required")).toContain("atendimento humano");
    expect(followupReasonLabel("provider_reply_missing")).toContain("não gerou uma resposta");
    expect(followupReasonLabel("audit_blocked")).toContain("auditoria de segurança");
    expect(followupReasonLabel(null, "review")).toBe("Revisão humana necessária antes de continuar.");
    expect(followupReasonLabel(null, "scheduled")).toBe("Aguardando o horário previsto para o próximo acompanhamento.");
    expect(followupReasonLabel(null)).toBeNull();
  });

  it("labels seller reminders and the follow-up brain outcomes", () => {
    expect(followupKindLabel("seller_reminder")).toBe("Lembrete");
    expect(followupReasonLabel("seller_done")).toBe("Lembrete concluído");
    expect(followupReasonLabel("brain_closed")).toBe("Conversa encerrada");
    expect(followupReasonLabel("brain_no_pending")).toBe("Nada pendente");
    expect(followupReasonLabel("brain_internal_contact")).toBe("Contato interno ou pessoal");
    expect(followupReasonLabel("seller_reminder")).toContain("lembrete");
    expect(followupReasonLabel("followup_brain_unavailable")).toContain("indisponível");
  });

  it("separates seller reminders from the customer review queue", () => {
    const reminder = { ...reviewFollowup, kind: "seller_reminder" as const };
    expect(matchesFollowupFilter(reminder, "reminders")).toBe(true);
    expect(matchesFollowupFilter(reminder, "review")).toBe(false);
    expect(matchesFollowupFilter(reviewFollowup, "reminders")).toBe(false);
    expect(matchesFollowupFilter({ ...reminder, status: "scheduled" }, "reminders")).toBe(false);
  });

  it("treats persisted stepIndex as one-based and legacy zero as step one", async () => {
    const { followupStepLabel } = await import("./followup-display");
    expect(followupStepLabel(1)).toBe("Etapa 1");
    expect(followupStepLabel(0)).toBe("Etapa 1");
    expect(followupStepLabel(6)).toBe("Etapa 6");
  });

  it("matches exact active filters and groups terminal outcomes under cancelled", () => {
    expect(matchesFollowupFilter(reviewFollowup, "review")).toBe(true);
    expect(matchesFollowupFilter(reviewFollowup, "scheduled")).toBe(false);
    expect(matchesFollowupFilter({ ...reviewFollowup, status: "evaluating" }, "scheduled")).toBe(false);
    expect(matchesFollowupFilter({
      ...reviewFollowup,
      status: "skipped",
      reason: "eligibility_seller_action_pending"
    }, "cancelled")).toBe(false);
    expect(matchesFollowupFilter({
      ...reviewFollowup,
      status: "failed",
      reason: "manual_delivery_uncertain"
    }, "cancelled")).toBe(true);
    expect(matchesFollowupFilter({
      ...reviewFollowup,
      status: "sent",
      finalBody: "Mensagem enviada",
      sentAt: reviewFollowup.updatedAt,
      sentByUserId: null
    }, "cancelled")).toBe(false);
  });
});
