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

  it("translates known terminal reasons and safely falls back for unknown reasons", () => {
    expect(followupReasonLabel("customer_replied")).toContain("cliente respondeu");
    expect(followupReasonLabel("provider_new_reason")).toContain("mudança no contexto");
    expect(followupReasonLabel("jev_human_review")).toContain("revisão humana");
    expect(followupReasonLabel(null)).toBeNull();
  });

  it("treats persisted stepIndex as one-based and legacy zero as step one", async () => {
    const { followupStepLabel } = await import("./followup-display");
    expect(followupStepLabel(1)).toBe("Etapa 1 de 3");
    expect(followupStepLabel(0)).toBe("Etapa 1 de 3");
    expect(followupStepLabel(3)).toBe("Etapa 3 de 3");
  });

  it("matches exact active filters and groups terminal outcomes under cancelled", () => {
    expect(matchesFollowupFilter(reviewFollowup, "review")).toBe(true);
    expect(matchesFollowupFilter(reviewFollowup, "scheduled")).toBe(false);
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
