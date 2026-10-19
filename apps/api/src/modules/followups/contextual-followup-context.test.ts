import { describe, expect, it, vi } from "vitest";
import { createContextualFollowupContextBuilder, type ContextualFollowupStore } from "./contextual-followup-context.js";

function fixture() {
  const messages = [
    { id: "anchor", workspaceId: "w", conversationId: "c", direction: "inbound", type: "text", body: "Preciso avaliar a oferta", createdAt: new Date("2026-10-19T12:00Z"), metadata: {} },
    { id: "seller", workspaceId: "w", conversationId: "c", direction: "outbound", type: "text", body: "Qual horário prefere?", createdAt: new Date("2026-10-19T12:01Z"), metadata: {} }
  ];
  const agent = { id: "a", workspaceId: "w", name: "Any name", type: "attendance", status: "active", systemPrompt: "x".repeat(4500) + " REGRA FINAL", handoffConfig: { prospectingGoal: "Convidar para conversa" }, behaviorConfig: { contextualFollowup: { enabled: true } }, allowedActions: ["request_handoff"], limitsConfig: { max: 4 } };
  const conversation = { id: "c", channelId: "channel", workspaceId: "w", activeAgentSessionId: "s", status: "open", aiControlStatus: "agent_allowed", assignedUserId: null, channel: { id: "channel", workspaceId: "w", provider: "evolution", status: "connected", encryptedConfig: {} as Record<string, unknown>, followupConfig: { enabled: true, steps: [{ afterMinutes: 120 }] } }, contact: { isGroup: false, phone: "5511999991111" } };
  const session = { id: "s", workspaceId: "w", agentId: "a", conversationId: "c", status: "active", firstResponseMessageId: "anchor", prospectingGeneration: "g", sourceRecipientId: "r", metadata: { harness: { ficha: { secret: "NEVER REUSE" } } } };
  const sources = [
    { id: "fact", workspaceId: "w", agentId: "a", status: "ready", title: "Oferta", content: "Somente o serviço aprovado", metadata: { approvalStatus: "confirmed" } },
    { id: "behavior", workspaceId: "w", agentId: "a", status: "ready", title: "Regra", content: "Não inventar preço", metadata: { approvalStatus: "behavioral" } },
    { id: "unapproved", workspaceId: "w", agentId: "a", status: "ready", title: "Rascunho", content: "RASCUNHO SECRETO", metadata: {} }
  ];
  const db = {
    aiAgent: { findFirst: vi.fn(async () => agent) },
    conversation: { findFirst: vi.fn(async () => conversation), findMany: vi.fn(async () => []) },
    aiAgentSession: { findFirst: vi.fn(async () => session) },
    messageMedia: { findMany: vi.fn(async () => []) },
    message: { findMany: vi.fn(async () => messages) },
    aiKnowledgeSource: { findMany: vi.fn(async () => sources) },
    conversationFollowup: { findMany: vi.fn(async () => []) },
    meetingReminder: { findMany: vi.fn(async () => []) },
    workspaceMirror: { findUnique: vi.fn(async () => ({ limits: { modules: { campaignProspecting: true } } })) },
    campaignProspectingReservation: { findUnique: vi.fn(async (): Promise<unknown> => null) }
  };
  const request = { workspaceId: "w", conversationId: "c", agentId: "a", sessionId: "s", anchorMessageId: "anchor", profile: "attendance" as const, stepInstruction: "Retome somente a pendência", sequenceFollowupIds: ["previous"], now: new Date("2026-10-19T15:00Z") };
  return { db, messages, agent, conversation, session, sources, request,
    build: () => createContextualFollowupContextBuilder(db as unknown as ContextualFollowupStore) };
}

describe("isolated contextual follow-up context", () => {
  it("preserves complete rules, anchor, authors, dates and approved own sources in separate sections", async () => {
    const f = fixture();
    const result = await f.build()(f.request);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.context.instructions.agentRules).toBe(f.agent.systemPrompt);
    expect(result.context.instructions.stepInstruction).toBe(f.request.stepInstruction);
    expect(result.context.instructions.behavioralSources.map(s => s.id)).toEqual(["behavior"]);
    expect(result.context.factualSources.map(s => s.id)).toEqual(["fact"]);
    expect(result.context.messages.map(m => [m.id, m.label, m.createdAt])).toEqual([
      ["anchor", "cliente", "2026-10-19T12:00:00.000Z"], ["seller", "atendente", "2026-10-19T12:01:00.000Z"]
    ]);
    expect(result.context.coverage).toMatchObject({ complete: true, anchorIncluded: true, messageIds: ["anchor", "seller"], factualSourceIds: ["fact"], behavioralSourceIds: ["behavior"] });
    expect(JSON.stringify(result)).not.toContain("NEVER REUSE");
    expect(JSON.stringify(result)).not.toContain("RASCUNHO SECRETO");
    expect(f.db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2001, where: expect.objectContaining({ workspaceId: "w", conversationId: "c", hiddenByReset: false }) }));
    expect(f.db.aiKnowledgeSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", agentId: "a", status: "ready" } }));
  });

  it.each(["agent", "conversation", "session", "message", "source"])("rejects foreign %s records", async kind => {
    const f = fixture();
    if (kind === "agent") f.agent.workspaceId = "foreign";
    if (kind === "conversation") f.conversation.workspaceId = "foreign";
    if (kind === "session") f.session.agentId = "foreign";
    if (kind === "message") f.messages[0]!.workspaceId = "foreign";
    if (kind === "source") f.sources[0]!.agentId = "foreign";
    expect(await f.build()(f.request)).toMatchObject({ status: "unavailable", reason: "invalid_evidence" });
  });

  it("fails closed when the anchor is absent or incomplete history exceeds upstream limits", async () => {
    const f = fixture();
    expect(await f.build()({ ...f.request, anchorMessageId: "absent" })).toMatchObject({ reason: "invalid_evidence" });
    f.messages[0]!.body = "x".repeat(120001);
    expect(await f.build()(f.request)).toMatchObject({ status: "unavailable", reason: "context_limit" });
  });

  it("accounts for all serialized content and refuses budgets without slicing", async () => {
    const f = fixture();
    expect(await f.build()({ ...f.request, budget: { maxCharacters: 4000, maxMessages: 2000, maxSources: 100 } })).toMatchObject({ status: "unavailable", reason: "context_limit" });
    expect(await f.build()({ ...f.request, budget: { maxCharacters: 200000, maxMessages: 1, maxSources: 100 } })).toMatchObject({ reason: "context_limit" });
    expect(await f.build()({ ...f.request, budget: { maxCharacters: 200000, maxMessages: 2000, maxSources: 1 } })).toMatchObject({ reason: "context_limit" });
  });

  it.each(["audio", "document", "image"])("abstains on pending %s content", async type => {
    const f = fixture();
    f.messages[0]!.type = type;
    f.messages[0]!.body = type === "audio" ? "Processando áudio..." : "";
    expect(await f.build()(f.request)).toMatchObject({ status: "unavailable", reason: "invalid_evidence", detail: "pending_media" });
  });

  it("honors persistent pending transcription state even with a plausible body", async () => {
    const f = fixture(); f.messages[0]!.type = "audio";
    f.db.messageMedia.findMany.mockResolvedValue([{ messageId: "anchor", workspaceId: "w", conversationId: "c", transcriptionState: "running" }] as never);
    expect(await f.build()(f.request)).toMatchObject({ status: "unavailable", reason: "invalid_evidence", detail: "pending_media" });
  });

  it("includes verified extracted attachment text and completed audio without performing extraction", async () => {
    const f = fixture(); f.messages[0]!.type = "document";
    f.messages[0]!.metadata = { media: { status: "processed", extractedText: "Dado técnico efetivamente extraído" } };
    let result = await f.build()(f.request);
    expect(result.status === "ready" && result.context.messages[0]!.body).toContain("Dado técnico efetivamente extraído");
    f.messages[0]!.type = "audio"; f.messages[0]!.metadata = { transcription: { status: "completed" } };
    f.db.messageMedia.findMany.mockResolvedValue([{ messageId: "anchor", workspaceId: "w", conversationId: "c", transcriptionState: "completed" }] as never);
    result = await f.build()(f.request);
    expect(result.status).toBe("ready");
  });

  it("fails rather than silently dropping failed conversation scope reads", async () => {
    const f = fixture(); f.db.conversation.findMany.mockRejectedValue(new Error("database unavailable"));
    expect(await f.build()(f.request)).toMatchObject({ status: "unavailable", reason: "analysis_failed" });
  });

  it("does not use unapproved improvements as commercial facts", async () => {
    const f = fixture();
    f.sources[2]!.metadata = { source: "approved_agent_improvement" } as never;
    const result = await f.build()(f.request);
    expect(result.status === "ready" && result.context.factualSources.map(s => s.id)).toEqual(["fact"]);
    expect(result.status === "ready" && result.context.instructions.behavioralSources.map(s => s.id)).toEqual(["behavior", "unapproved"]);
  });

  it("uses only genuine persisted form evidence while preserving this agent's complete own rules", async () => {
    const f = fixture(); f.messages[0]!.body = "Vim do formulário. Minha reunião está confirmada";
    let result = await f.build()({ ...f.request, profile: "commercial" });
    expect(result.status === "ready" && result.context.profile.origin).toBe("direct_inbound");
    expect(result.status === "ready" && result.context.profile.meeting.state).toBe("unknown");
    f.messages[0]!.type = "system"; f.messages[0]!.metadata = { source: "automation_webhook" };
    result = await f.build()({ ...f.request, profile: "commercial" });
    expect(result.status === "ready" && result.context.profile.origin).toBe("site_form");
    expect(result.status === "ready" && result.context.instructions.agentRules).toBe(f.agent.systemPrompt);
    expect(result.status === "ready" && result.context.instructions.stepInstruction).toBe(f.request.stepInstruction);
  });

  it("reads persisted successful booking IDs, deduplicates reminder steps and ignores elapsed slots", async () => {
    const f = fixture();
    const booking = { id: "booking-reminder", workspaceId: "w", conversationId: "c", agentId: "a", eventId: "event", status: "scheduled", meetingStartsAt: new Date("2026-10-21T14:00Z") };
    f.db.meetingReminder.findMany.mockResolvedValue([booking, { ...booking, id: "another-step" }, { ...booking, id: "old-slot", eventId: "old-event", meetingStartsAt: new Date("2026-10-18T14:00Z") }] as never);
    const result = await f.build()({ ...f.request, profile: "commercial" });
    expect(result.status === "ready" && result.context.profile.meeting).toMatchObject({ state: "recorded_booking", currentCalendarVerified: false, recordedBookings: [{ evidenceId: "booking-reminder", eventId: "event", startsAt: "2026-10-21T14:00:00.000Z" }] });
    expect(result.status === "ready" && result.context.coverage.domainEvidenceIds).toEqual(["booking-reminder"]);
  });

  it("includes a scoped retired-conversation anchor through the shared complete context builder", async () => {
    const f = fixture(); f.messages[0]!.conversationId = "retired";
    f.db.conversation.findMany.mockResolvedValue([{ id: "retired" }] as never);
    const result = await f.build()(f.request);
    expect(result.status).toBe("ready");
    expect(f.db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ conversationId: { in: ["c", "retired"] } }) }));
  });

  it("reports a verifiable full serialized size", async () => {
    const f = fixture(); const result = await f.build()(f.request);
    expect(result.status === "ready" && result.context.coverage.serializedCharacters).toBe(result.status === "ready" && JSON.stringify(result.context).length);
  });

  it("abstains when complete approved factual evidence exceeds the budget", async () => {
    const f = fixture(); f.sources[0]!.content = "x".repeat(10000) + "FINAL FACT";
    expect(await f.build()({ ...f.request, budget: { maxCharacters: 10000, maxMessages: 2000, maxSources: 100 } })).toMatchObject({ status: "unavailable", reason: "context_limit" });
    const result = await f.build()(f.request);
    expect(result.status === "ready" && result.context.factualSources[0]!.content).toBe(f.sources[0]!.content);
  });

  it("resolves and validates the persisted active session when sessionId is omitted", async () => {
    const f = fixture();
    const result = await f.build()({ ...f.request, sessionId: undefined });
    expect(result.status === "ready" && result.context.sessionId).toBe("s");
    expect(f.db.aiAgentSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", id: "s", conversationId: "c", agentId: "a" } }));
    f.session.agentId = "another-agent";
    expect(await f.build()({ ...f.request, sessionId: undefined })).toMatchObject({ status: "unavailable", reason: "invalid_evidence" });
  });

  it("rejects a replaced active session even when the request omits the session", async () => {
    const f = fixture(); f.conversation.activeAgentSessionId = "another-session";
    expect(await f.build()({ ...f.request, sessionId: undefined })).toMatchObject({ status: "unavailable" });
    f.db.aiAgentSession.findFirst.mockResolvedValue(null as never);
    expect(await f.build()({ ...f.request, sessionId: undefined })).toMatchObject({ status: "unavailable" });
  });

  it("rejects conflicting channel assistant authority and preserves a legitimate sessionless form", async () => {
    const f = fixture(); f.conversation.activeAgentSessionId = null as never;
    f.messages[0]!.type = "system"; f.messages[0]!.metadata = { source: "automation_webhook" };
    expect(await f.build()({ ...f.request, sessionId: undefined, profile: "commercial" })).toMatchObject({ status: "ready", context: { sessionId: null } });
    f.conversation.channel.encryptedConfig = { assistant: { mode: "automatic_with_agent", agentId: "00000000-0000-4000-8000-000000000999" } };
    expect(await f.build()({ ...f.request, sessionId: undefined, profile: "commercial" })).toMatchObject({ status: "unavailable", reason: "policy_changed" });
  });

  it("rejects a saturated raw page before duplicate audit filtering could hide an omitted oldest message", async () => {
    const f = fixture();
    const realMessages = Array.from({ length: 2001 }, (_, index) => ({ ...f.messages[0]!, id: index === 0 ? "anchor" : `real-${index}` }));
    const audit = { ...f.messages[0]!, id: "newest-audit", metadata: { campaignDuplicateAudit: true } };
    // A real database honors take=2001: this page has one audit and 2000 real messages, omitting real-2000.
    f.db.message.findMany.mockResolvedValue([audit, ...realMessages].slice(0, 2001));
    expect(await f.build()({ ...f.request, budget: { maxCharacters: 1000000, maxMessages: 2000, maxSources: 100 } })).toMatchObject({ status: "unavailable", reason: "context_limit" });
  });

  it("returns complete serializable policy inputs outside model-facing context", async () => {
    const f = fixture();
    f.conversation.channel.encryptedConfig = { privateProviderCredential: "DO NOT EXPOSE", assistant: { mode: "disabled" } };
    const result = await f.build()(f.request);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.policyInputs).toMatchObject({
      profile: "attendance", stepInstruction: f.request.stepInstruction,
      agent: { id: "a", name: "Any name", type: "attendance", status: "active", systemPrompt: f.agent.systemPrompt, allowedActions: ["request_handoff"], behaviorConfig: f.agent.behaviorConfig, handoffConfig: f.agent.handoffConfig, limitsConfig: { max: 4 } },
      channel: { id: "channel", workspaceId: "w", provider: "evolution", status: "connected", assistant: { mode: "disabled" }, followupConfig: f.conversation.channel.followupConfig },
      conversation: { id: "c", aiControlStatus: "agent_allowed", activeAgentSessionId: "s", historyResetAt: null },
      session: { id: "s", agentId: "a", prospectingGeneration: "g", firstResponseMessageId: "anchor" },
      reservation: null,
      approvedSources: [expect.objectContaining({ id: "fact", classification: "factual", content: f.sources[0]!.content, metadata: { approvalStatus: "confirmed" } }), expect.objectContaining({ id: "behavior", classification: "behavioral", metadata: { approvalStatus: "behavioral" } })]
    });
    expect(JSON.parse(JSON.stringify(result.policyInputs))).toEqual(result.policyInputs);
    expect(result.context).not.toHaveProperty("policyInputs");
    expect(JSON.stringify(result.policyInputs)).not.toContain("NEVER REUSE");
    expect(JSON.stringify(result)).not.toContain("DO NOT EXPOSE");
    const firstSnapshot = JSON.stringify(result.policyInputs);
    f.agent.limitsConfig.max = 5; f.conversation.channel.followupConfig.steps[0]!.afterMinutes = 1440;
    const changed = await f.build()(f.request);
    expect(changed.status === "ready" && JSON.stringify(changed.policyInputs)).not.toBe(firstSnapshot);
  });

  it.each(["automatic_with_agent", "automatic", "on_demand"])("allows a review draft with matching %s channel authority and no session", async mode => {
    const f = fixture(); const agentId = "00000000-0000-4000-8000-000000000111";
    f.agent.id = agentId; f.request.agentId = agentId; f.session.agentId = agentId; f.sources.forEach(source => { source.agentId = agentId; });
    f.conversation.activeAgentSessionId = null as never;
    f.messages[0]!.type = "system"; f.messages[0]!.metadata = { source: "automation_webhook" };
    f.conversation.channel.encryptedConfig = { assistant: { mode, agentId } };
    expect(await f.build()({ ...f.request, sessionId: undefined, profile: "commercial" })).toMatchObject({ status: "ready", context: { sessionId: null } });
  });

  it("preserves current reservation generation and first respondent in policy inputs", async () => {
    const f = fixture(); f.agent.type = "prospecting";
    f.db.campaignProspectingReservation.findUnique.mockResolvedValue({
      workspaceId: "w", conversationId: "c", agentId: "a", campaignId: "campaign", recipientId: "r", generation: "g",
      status: "confirmed", confirmedAt: new Date("2026-10-19T11:00Z"), dispatchIntentAt: new Date("2026-10-19T10:59Z"), pendingInboundMessageId: "anchor"
    });
    const result = await f.build()({ ...f.request, sessionId: undefined, profile: "prospecting", expectedGeneration: "g" });
    expect(result).toMatchObject({ status: "ready", policyInputs: { reservation: { generation: "g", pendingInboundMessageId: "anchor", confirmedAt: "2026-10-19T11:00:00.000Z" }, session: { id: "s", prospectingGeneration: "g" } } });
  });

  it("normalizes nested policy object order and snapshots do not alias mutable configuration", async () => {
    const f = fixture(); f.agent.behaviorConfig = { b: 2, a: 1 } as never;
    const first = await f.build()(f.request);
    f.agent.behaviorConfig = { a: 1, b: 2 } as never;
    const reordered = await f.build()(f.request);
    expect(first.status === "ready" && JSON.stringify(first.policyInputs)).toBe(reordered.status === "ready" && JSON.stringify(reordered.policyInputs));
    f.agent.behaviorConfig = { a: 2, b: 2 } as never;
    expect(first.status === "ready" && first.policyInputs.agent.behaviorConfig).toEqual({ a: 1, b: 2 });
  });

  it("counts only scoped confirmed sent attempts returned for the lifecycle's sequence", async () => {
    const f = fixture();
    f.db.conversationFollowup.findMany.mockResolvedValue([{ id: "previous", workspaceId: "w", conversationId: "c", agentId: "a", status: "sent", sentAt: new Date("2026-10-19T13:00Z") }] as never);
    const result = await f.build()(f.request);
    expect(result.status === "ready" && result.context.sentAttempts).toEqual([{ followupId: "previous", sentAt: "2026-10-19T13:00:00.000Z" }]);
  });
});
