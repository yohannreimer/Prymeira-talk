import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readContextualSnapshot, readContextualSnapshotInTransaction } from "./contextual-followup-snapshot.js";
import { sendCanonicalFollowupText } from "./contextual-followup-delivery.js";
import { sha } from "../messaging/canonical-values.js";
import { createConversationFollowupsService } from "./conversation-followups.service.js";
import { createContextualFollowupRuntime } from "../agents/contextual-followup-runtime.js";
import type { FollowupAnalysis } from "../harness/agentes/followup/tipos.js";
import Fastify from "fastify";
import { conversationFollowupsRoutes } from "./conversation-followups.routes.js";
import { createConversationsService } from "../conversations/conversations.service.js";

const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)("contextual follow-ups at the real PostgreSQL frontier", () => {
  let db: PrismaClient;
  const workspaces: string[] = [];
  beforeAll(() => {
    const u = new URL(url!); if (u.hostname !== "127.0.0.1" || u.pathname !== "/messaging_test") throw new Error("Owned fixture database required");
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    for (const workspaceId of workspaces) {
      await db.outboundIntent.deleteMany({ where: { workspaceId } });
      await db.campaignProspectingReservation.deleteMany({ where: { workspaceId } });
      await db.campaign.deleteMany({ where: { workspaceId } });
      await db.conversationFollowup.deleteMany({ where: { workspaceId } });
      await db.channel.deleteMany({ where: { workspaceId } });
      await db.aiAgent.deleteMany({ where: { workspaceId } });
      await db.contact.deleteMany({ where: { workspaceId } });
      await db.userProfile.deleteMany({ where: { workspaceId } });
      await db.integrationConfig.deleteMany({ where: { workspaceId } });
      await db.workspaceMirror.deleteMany({ where: { workspaceId } });
    }
    await db.$disconnect();
  });
  async function fixture(actorKind: "user" | "agent" = "user", delivery: "review" | "automatic" = "review") {
    const ws = `contextual-fixture-${randomUUID()}`; workspaces.push(ws);
    const channel = await db.channel.create({ data: { workspaceId: ws, provider: "evolution", providerKey: randomUUID(), followupConfig: {
      enabled: true, timeZone: "America/Sao_Paulo", businessDays: [0, 1, 2, 3, 4, 5, 6], businessHours: { start: "00:00", end: "23:59" },
      steps: [120, 1440, 2880, 5760].map(afterMinutes => ({ afterMinutes })), humanCommercialDelivery: delivery
    } } });
    const connection = await db.channelConnection.create({ data: { workspaceId: ws, channelId: channel.id, provider: "evolution", sessionName: randomUUID() } });
    const contact = await db.contact.create({ data: { workspaceId: ws, phone: "15550001111" } });
    const conversation = await db.conversation.create({ data: { workspaceId: ws, channelId: channel.id, contactId: contact.id } });
    const user = await db.userProfile.create({ data: { workspaceId: ws, clerkUserId: randomUUID(), displayName: "Synthetic reviewer" } });
    const behaviorConfig = { contextualFollowup: { version: 1, enabled: true, profile: "commercial", channels: [channel.id] } };
    const agent = await db.aiAgent.create({ data: { workspaceId: ws, name: "Synthetic agent", status: "active", systemPrompt: "x".repeat(4100) + " PROTECTED_RULE_TAIL", behaviorConfig } });
    const session = await db.aiAgentSession.create({ data: { workspaceId: ws, conversationId: conversation.id, agentId: agent.id } });
    await db.conversation.update({ where: { id: conversation.id }, data: { activeAgentSessionId: session.id } });
    const customer = await db.message.create({ data: { workspaceId: ws, conversationId: conversation.id, direction: "inbound", type: "text", body: "Quero conversar sobre o serviço", status: "delivered", createdAt: new Date(Date.now() - 4 * 3600000), ingestedAt: new Date(Date.now() - 4 * 3600000) } });
    const anchor = await db.message.create({ data: { workspaceId: ws, conversationId: conversation.id, direction: "outbound", type: "text", body: "Qual horário prefere?", status: "sent", createdAt: new Date(Date.now() - 3 * 3600000), ingestedAt: new Date(Date.now() - 3 * 3600000) } });
    const body = "Conseguiu escolher um horário para conversarmos?", claimAt = new Date();
    const followup = await db.conversationFollowup.create({ data: { workspaceId: ws, conversationId: conversation.id, agentId: agent.id, sessionId: session.id,
      kind: "qualification", stepIndex: 1, status: "processing", activeKey: "active", lockedAt: claimAt, scheduledAt: new Date(Date.now() - 60000),
      anchorMessageId: anchor.id, anchorMessageAt: anchor.createdAt, anchorIngestedAt: anchor.ingestedAt!, finalBody: body,
      decision: { contextualEngine: { version: 1, profile: "commercial", policyRevision: "initial" } } } });
    const snapshot = await readContextualSnapshot(db, followup, "commercial", new Date());
    if (snapshot.status !== "ready") throw new Error(`Fixture snapshot unavailable: ${JSON.stringify(snapshot)}`);
    const analysis: FollowupAnalysis = { contact: { role: "customer", evidence: { messageId: customer.id, author: "cliente", excerpt: customer.body! } }, closure: null, customerTiming: null,
      pendingItems: [{ id: "p1", kind: "time_choice", owner: "customer", subject: "Escolha de horário", evidence: { messageId: anchor.id, author: "atendente", excerpt: anchor.body! }, engagement: { messageId: customer.id, author: "cliente", excerpt: customer.body! }, factualEvidence: [] }], resolutions: [] };
    const actor = { kind: actorKind, id: actorKind === "user" ? user.id : agent.id };
    const decision = { contextualEngine: { version: 1, profile: "commercial", policyRevision: snapshot.policyRevision }, sequenceFollowupIds: [],
      contextualFollowup: { version: 1, analysis, output: { type: "customer_message", body, evidenceMessageIds: [anchor.id, customer.id] }, reviewApproved: true, risk: "none", pendingKind: "time_choice" },
      contextualApproval: { actor, claimAt: claimAt.toISOString(), bodyHash: sha(body), policyRevision: snapshot.policyRevision } };
    const frozen = await db.conversationFollowup.update({ where: { id: followup.id }, data: { decision } });
    await db.message.create({ data: { id: followup.id, workspaceId: ws, conversationId: conversation.id, direction: "outbound", type: "text", status: "pending", body, sentByUserId: actorKind === "user" ? user.id : null,
      metadata: { source: actorKind === "user" ? "followup_review" : "ai_agent", followupId: followup.id, contextualFollowup: true } } });
    const send = vi.fn(async () => ({ providerMessageId: "SYNTHETIC", raw: { key: { id: "SYNTHETIC", remoteJid: "15550001111@s.whatsapp.net", fromMe: true } } }));
    const dispatch = () => sendCanonicalFollowupText({ prisma: db, workspaceId: ws, channelId: channel.id, messageId: followup.id, connectionId: connection.id, provider: "evolution", text: body, send });
    return { ws, channel, connection, conversation, contact, user, agent, session, customer, anchor, followup: frozen, behaviorConfig, body, claimAt, decision, snapshot, analysis, send, dispatch };
  }
  it("sends an explicitly approved draft once through followup origin, preserving its UUID and hiding raw rules", async () => {
    const f = await fixture(); expect((await f.dispatch()).localMessageId).toBe(f.followup.id);
    expect(f.send).toHaveBeenCalledTimes(1);
    const intent = await db.outboundIntent.findUniqueOrThrow({ where: { messageId: f.followup.id } });
    expect(intent.state).toBe("bound"); expect(JSON.stringify(intent.request)).not.toContain("PROTECTED_RULE_TAIL");
    expect((intent.request as any).origin.kind).toBe("followup");
    await expect(f.dispatch()).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each(["prompt_tail", "profile", "channel_plan", "new_source", "source_edit", "source_delete", "source_reclassify", "inbound", "takeover_resume", "reset", "session", "body", "claim", "approval", "marker"])("rejects stale %s even with freshly captured send fences", async mutation => {
    const f = await fixture();
    if (mutation === "prompt_tail") await db.aiAgent.update({ where: { id: f.agent.id }, data: { systemPrompt: f.agent.systemPrompt + " changed" } });
    if (mutation === "profile") await db.aiAgent.update({ where: { id: f.agent.id }, data: { behaviorConfig: { ...f.behaviorConfig, contextualFollowup: { ...f.behaviorConfig.contextualFollowup, profile: "attendance" } } } });
    if (mutation === "channel_plan") await db.channel.update({ where: { id: f.channel.id }, data: { followupConfig: { ...(f.channel.followupConfig as object), steps: [{ afterMinutes: 999 }] } } });
    if (mutation.startsWith("source_") || mutation === "new_source") {
      const source = await db.aiKnowledgeSource.create({ data: { workspaceId: f.ws, agentId: f.agent.id, type: "text", title: "Fact", content: "Approved fact", metadata: { approvalStatus: "confirmed" } } });
      if (mutation !== "new_source") {
        const fresh = await readContextualSnapshot(db, f.followup, "commercial", new Date()); if (fresh.status !== "ready") throw new Error("fixture");
        f.decision.contextualEngine.policyRevision = fresh.policyRevision; f.decision.contextualApproval.policyRevision = fresh.policyRevision;
        await db.conversationFollowup.update({ where: { id: f.followup.id }, data: { decision: f.decision } });
        if (mutation === "source_edit") await db.aiKnowledgeSource.update({ where: { id: source.id }, data: { content: "Changed fact" } });
        if (mutation === "source_delete") await db.aiKnowledgeSource.delete({ where: { id: source.id } });
        if (mutation === "source_reclassify") await db.aiKnowledgeSource.update({ where: { id: source.id }, data: { metadata: { approvalStatus: "behavioral" } } });
      }
    }
    if (mutation === "inbound") await db.message.create({ data: { workspaceId: f.ws, conversationId: f.conversation.id, direction: "inbound", type: "text", body: "Já escolhi", status: "delivered" } });
    if (mutation === "takeover_resume") await db.conversation.update({ where: { id: f.conversation.id }, data: { aiControlUpdatedAt: new Date(), aiControlStatus: "agent_allowed" } });
    if (mutation === "reset") await db.message.update({ where: { id: f.anchor.id }, data: { hiddenByReset: true } });
    if (mutation === "session") await db.aiAgentSession.update({ where: { id: f.session.id }, data: { status: "paused_by_human" } });
    if (mutation === "body") await db.conversationFollowup.update({ where: { id: f.followup.id }, data: { finalBody: "Changed" } });
    if (mutation === "claim") await db.conversationFollowup.update({ where: { id: f.followup.id }, data: { lockedAt: new Date(Date.now() + 1000) } });
    if (mutation === "approval") { f.decision.contextualApproval.actor.id = randomUUID(); await db.conversationFollowup.update({ where: { id: f.followup.id }, data: { decision: f.decision } }); }
    if (mutation === "marker") await db.conversationFollowup.update({ where: { id: f.followup.id }, data: { decision: { contextualEngine: { version: 99 } } } });
    await expect(f.dispatch()).rejects.toThrow(); expect(f.send).not.toHaveBeenCalled();
    expect(await db.outboundAttempt.count({ where: { workspaceId: f.ws } })).toBe(0);
  });
  it("channel review blocks an automatic actor even with a valid reviewed draft", async () => {
    const f = await fixture("agent", "review"); await expect(f.dispatch()).rejects.toThrow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("explicit automatic policy keeps an already eligible kind", async () => {
    const f = await fixture("agent", "automatic"); await f.dispatch(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("rollback disables new adoption without invalidating an existing frozen sequence", async () => {
    const f = await fixture(); await db.aiAgent.update({ where: { id: f.agent.id }, data: { behaviorConfig: { ...f.behaviorConfig, contextualFollowup: { ...f.behaviorConfig.contextualFollowup, enabled: false } } } });
    await f.dispatch(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("durably contains provider uncertainty and never dispatches again", async () => {
    const f = await fixture(); f.send.mockRejectedValue(new Error("connection interrupted"));
    await expect(f.dispatch()).rejects.toThrow(); await expect(f.dispatch()).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
    expect((await db.outboundIntent.findUniqueOrThrow({ where: { messageId: f.followup.id } })).state).toBe("uncertain");
  });
  it("serializes a new approved-source insertion through the agent FK while the snapshot is locked", async () => {
    const f = await fixture(); let unlock!: () => void, locked!: () => void;
    const hold = new Promise<void>(resolve => { unlock = resolve; }); const entered = new Promise<void>(resolve => { locked = resolve; });
    const reader = db.$transaction(async tx => { await readContextualSnapshotInTransaction(tx, f.followup, "commercial", new Date()); locked(); await hold; }, { timeout: 10000 });
    await entered;
    await expect(db.$transaction(async tx => { await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '100ms'`); await tx.aiKnowledgeSource.create({ data: { workspaceId: f.ws, agentId: f.agent.id, type: "text", title: "Inserted", content: "New fact", metadata: { approvalStatus: "confirmed" } } }); })).rejects.toThrow();
    unlock(); await reader;
  });

  async function prospecting(f: Awaited<ReturnType<typeof fixture>>) {
    const defaultAgent = await db.aiAgent.create({ data: { workspaceId: f.ws, name: "Synthetic channel default", status: "active", systemPrompt: "Synthetic default" } });
    await db.channel.update({ where: { id: f.channel.id }, data: { encryptedConfig: { assistant: { mode: "automatic_with_agent", agentId: defaultAgent.id } } } });
    await db.workspaceMirror.create({ data: { workspaceId: f.ws, limits: { modules: { campaignProspecting: true } } } });
    const campaign = await db.campaign.create({ data: { workspaceId: f.ws, channelId: f.channel.id, name: "Synthetic campaign", messageBody: "Synthetic opening", status: "completed" } });
    const recipient = await db.campaignRecipient.create({ data: { workspaceId: f.ws, channelId: f.channel.id, campaignId: campaign.id, contactId: f.contact.id, status: "sent" } });
    const generation = randomUUID();
    await db.aiAgent.update({ where: { id: f.agent.id }, data: { type: "prospecting", handoffConfig: { prospectingGoal: "Conversar sobre o serviço autorizado" }, behaviorConfig: { contextualFollowup: { ...f.behaviorConfig.contextualFollowup, profile: "prospecting" } } } });
    await db.aiAgentSession.update({ where: { id: f.session.id }, data: { sourceCampaignId: campaign.id, sourceRecipientId: recipient.id, firstResponseMessageId: f.customer.id, firstResponseAt: f.customer.createdAt, prospectingGeneration: generation } });
    const reservation = await db.campaignProspectingReservation.create({ data: { workspaceId: f.ws, conversationId: f.conversation.id, contactId: f.contact.id, channelId: f.channel.id,
      campaignId: campaign.id, recipientId: recipient.id, agentId: f.agent.id, generation, status: "confirmed", dispatchStartedAt: new Date(), dispatchIntentAt: new Date(), confirmedAt: new Date(), pendingInboundMessageId: f.customer.id } });
    f.decision.contextualEngine.profile = "prospecting";
    const s = await readContextualSnapshot(db, f.followup, "prospecting", new Date()); if (s.status !== "ready") throw new Error(JSON.stringify(s));
    f.decision.contextualEngine.policyRevision = s.policyRevision; f.decision.contextualApproval.policyRevision = s.policyRevision;
    f.followup = await db.conversationFollowup.update({ where: { id: f.followup.id }, data: { decision: f.decision } });
    return reservation;
  }
  async function runGeneration(f: Awaited<ReturnType<typeof fixture>>, duringGeneration?: () => Promise<unknown>) {
    await db.integrationConfig.create({ data: { workspaceId: f.ws, provider: "openai_compatible", mode: "real", status: "configured", settings: { baseUrl: "https://synthetic.invalid", apiKey: "synthetic-never-used", chatModel: "synthetic" } } });
    const generate = vi.fn(async () => {
      await duringGeneration?.();
      return { decision: { type: "customer_message" as const, body: f.body, evidenceMessageIds: [f.anchor.id, f.customer.id] }, reviewApproved: true,
        ficha: { contextualFollowup: { version: 1 as const, analysis: f.analysis, sentAttempts: [] } } };
    });
    const outbound = { createPendingOutboundMessage: vi.fn(async () => { throw new Error("Review must never call transport"); }) };
    const lifecycle = createConversationFollowupsService(db as never);
    const runtime = createContextualFollowupRuntime({ prisma: db, followups: lifecycle, outbound, generate });
    const result = await runtime.runFollowup({ workspaceId: f.ws, followupId: f.followup.id, followup: f.followup, claim: { lockedAt: f.claimAt } });
    return { result, generate, outbound };
  }
  it.each(["site", "commercial_harness", "prospecting"])("generates a real review draft for %s without transport or live-session ficha changes", async profile => {
    const f = await fixture();
    if (profile === "commercial_harness") await db.aiAgent.update({ where: { id: f.agent.id }, data: { behaviorConfig: { ...f.behaviorConfig, harness: { agente: "comercial", canais: [f.channel.id] } } } });
    if (profile === "prospecting") await prospecting(f);
    const originalSession = await db.aiAgentSession.findUniqueOrThrow({ where: { id: f.session.id } });
    const run = await runGeneration(f); expect(run.result.status).toBe("review"); expect(run.generate).toHaveBeenCalledTimes(1); expect(run.outbound.createPendingOutboundMessage).not.toHaveBeenCalled();
    const persisted = await db.conversationFollowup.findUniqueOrThrow({ where: { id: f.followup.id } }); expect(persisted.draftBody).toBe(f.body); expect(persisted.status).toBe("review");
    expect((await db.aiAgentSession.findUniqueOrThrow({ where: { id: f.session.id } })).metadata).toEqual(originalSession.metadata);
  });
  it.each(["inbound", "rules", "takeover", "generation", "reset"])("does not persist or send a draft when %s changes during analysis", async race => {
    const f = await fixture(); const reservation = race === "generation" ? await prospecting(f) : null;
    const run = await runGeneration(f, async () => {
      if (race === "inbound") return db.message.create({ data: { workspaceId: f.ws, conversationId: f.conversation.id, direction: "inbound", type: "text", body: "Nova resposta", status: "delivered" } });
      if (race === "rules") return db.aiAgent.update({ where: { id: f.agent.id }, data: { systemPrompt: f.agent.systemPrompt + " changed" } });
      if (race === "takeover") return db.conversation.update({ where: { id: f.conversation.id }, data: { aiControlUpdatedAt: new Date(), aiControlStatus: "human_controlled" } });
      if (race === "generation") return db.campaignProspectingReservation.update({ where: { id: reservation!.id }, data: { generation: randomUUID() } });
      return db.message.update({ where: { id: f.anchor.id }, data: { hiddenByReset: true } });
    });
    expect(run.result.status).toBe("failed"); expect(run.outbound.createPendingOutboundMessage).not.toHaveBeenCalled();
    expect((await db.conversationFollowup.findUniqueOrThrow({ where: { id: f.followup.id } })).status).toBe("failed");
  });
  it("adopts an engaged new candidate without running legacy technical screening, retaining the four-step channel plan", async () => {
    const f = await fixture(); await db.conversationFollowup.delete({ where: { id: f.followup.id } }); await db.message.delete({ where: { id: f.followup.id } });
    const evaluate = vi.fn(async () => { throw new Error("Legacy classifier must not run"); });
    const lifecycle = createConversationFollowupsService(db as never, { eligibility: { evaluate } });
    const result = await lifecycle.observeConversationActivity({ workspaceId: f.ws, conversationId: f.conversation.id, messageId: f.anchor.id, direction: "outbound", source: "agent" });
    expect(result.status).toBe("scheduled"); expect(evaluate).not.toHaveBeenCalled();
    const next = await db.conversationFollowup.findFirstOrThrow({ where: { workspaceId: f.ws, activeKey: "active" } });
    expect(next.decision).toMatchObject({ contextualEngine: { version: 1, profile: "commercial" } });
    expect(next.scheduledAt.getTime()).toBe(f.anchor.createdAt.getTime() + 120 * 60000);
  });
  it("does not adopt a cold outbound without previous customer or verified form evidence", async () => {
    const f = await fixture(); await db.conversationFollowup.delete({ where: { id: f.followup.id } }); await db.message.deleteMany({ where: { workspaceId: f.ws, id: { in: [f.followup.id, f.customer.id] } } });
    const result = await createConversationFollowupsService(db as never).observeConversationActivity({ workspaceId: f.ws, conversationId: f.conversation.id, messageId: f.anchor.id, direction: "outbound", source: "agent" });
    expect(result.status).toBe("ignored");
  });
  it("manual contextual prospect approval preserves the active session and schedules the next step from the actual sent Message", async () => {
    const f = await fixture(); await prospecting(f);
    const review = await db.conversationFollowup.update({ where: { id: f.followup.id }, data: { status: "review", lockedAt: null, draftBody: f.body } });
    const service = createConversationsService(db as never, { evolution: { mode: "real", client: { supportsCanonicalFollowups: true, sendText: async () => f.dispatch() } } as never });
    const app = Fastify(); app.decorateRequest("talk");
    app.addHook("onRequest", async request => { request.talk = { workspaceId: f.ws, role: "owner", clerkUserId: "synthetic" }; });
    await app.register(conversationFollowupsRoutes, { prisma: db as never, outbound: service, realtime: { publish() {} }, resolveActorUserId: async () => f.user.id });
    const stale = await app.inject({ method: "POST", url: `/followups/${review.id}/send`, payload: { body: f.body, expectedUpdatedAt: new Date(0).toISOString() } }); expect(stale.statusCode).toBe(409); expect(f.send).not.toHaveBeenCalled();
    const sent = await app.inject({ method: "POST", url: `/followups/${review.id}/send`, payload: { body: f.body, expectedUpdatedAt: review.updatedAt.toISOString() } });
    await app.close(); expect(sent.statusCode, sent.body).toBe(200); expect(f.send).toHaveBeenCalledTimes(1);
    expect((await db.aiAgentSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).toBe("active");
    expect((await db.campaignProspectingReservation.findUniqueOrThrow({ where: { workspaceId_conversationId: { workspaceId: f.ws, conversationId: f.conversation.id } } })).status).toBe("confirmed");
    const next = await db.conversationFollowup.findFirstOrThrow({ where: { workspaceId: f.ws, activeKey: "active" } });
    const actualMessage = await db.message.findUniqueOrThrow({ where: { id: f.followup.id } });
    expect(next.stepIndex).toBe(2); expect(next.anchorMessageId).toBe(actualMessage.id); expect(next.anchorMessageAt).toEqual(actualMessage.createdAt); expect(next.anchorIngestedAt).toEqual(actualMessage.ingestedAt);
    const completed = await db.conversationFollowup.findUniqueOrThrow({ where: { id: f.followup.id } });
    expect(next.scheduledAt.getTime()).toBe(completed.sentAt!.getTime() + 1440 * 60000);
    expect(next.decision).toMatchObject({ contextualEngine: { version: 1, profile: "prospecting" }, sequenceFollowupIds: [f.followup.id] });
  });
  it("advances exactly four confirmed steps, once each, without a fifth or invented anchor timestamp", async () => {
    const f = await fixture(); const lifecycle = createConversationFollowupsService(db as never);
    let current = f.followup;
    for (let step = 1; step <= 4; step++) {
      if (step > 1) {
        const claimed = await lifecycle.claimScheduledFollowup({ workspaceId: f.ws, followupId: current.id }); expect(claimed.status).toBe("claimed");
        current = await db.conversationFollowup.findUniqueOrThrow({ where: { id: current.id } });
        await db.message.create({ data: { id: current.id, workspaceId: f.ws, conversationId: f.conversation.id, direction: "outbound", type: "text", body: f.body, status: "sent", metadata: { source: "followup_review", followupId: current.id, contextualFollowup: true } } });
      } else await db.message.update({ where: { id: current.id }, data: { status: "sent" } });
      const message = await db.message.findUniqueOrThrow({ where: { id: current.id } });
      const sentAt = new Date(Date.now() + step * 1000);
      const completion = { workspaceId: f.ws, followupId: current.id, followup: current, claim: { lockedAt: current.lockedAt! }, agentBehaviorConfig: f.behaviorConfig,
        finalBody: f.body, decision: current.decision, sentMessageId: message.id, sentMessageAt: message.createdAt, now: sentAt };
      const result = await lifecycle.completeAutomaticFollowup(completion);
      expect((await lifecycle.completeAutomaticFollowup(completion)).status).toBe("not_active");
      if (step < 4) {
        expect(result.status).toBe("scheduled"); if (result.status !== "scheduled") throw new Error("next step missing");
        const next = await db.conversationFollowup.findUniqueOrThrow({ where: { id: result.followupId } });
        expect(next.stepIndex).toBe(step + 1); expect(next.anchorMessageId).toBe(message.id); expect(next.anchorMessageAt).toEqual(message.createdAt); expect(next.anchorIngestedAt).toEqual(message.ingestedAt);
        expect(next.scheduledAt.getTime()).toBe(sentAt.getTime() + [120, 1440, 2880, 5760][step]! * 60000);
        expect((next.decision as any).sequenceFollowupIds).toHaveLength(step); current = next;
      } else expect(result.status).toBe("sent");
    }
    expect(await db.conversationFollowup.count({ where: { workspaceId: f.ws, status: "sent" } })).toBe(4);
    expect(await db.conversationFollowup.count({ where: { workspaceId: f.ws, activeKey: "active" } })).toBe(0);
  });
});
