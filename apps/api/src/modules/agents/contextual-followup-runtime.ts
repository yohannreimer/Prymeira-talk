import { Prisma, type PrismaClient } from "@prisma/client";
import { asRecord } from "../prospecting/prospecting-policy.js";
import { blocksAutonomousAgent } from "../assistant/assistant-policy.js";
import { resolveContextualFollowupEngine } from "../followups/contextual-followup-engine.js";
import { contextualAnchorCurrent, readContextualSnapshotInTransaction } from "../followups/contextual-followup-snapshot.js";
import { requiresHumanReview, contextualKindAllowsAutomatic } from "../followups/contextual-followup-policy.js";
import { nextBusinessStart } from "../followups/business-time.js";
import { createOpenAiCompatibleModel } from "../harness/core/model.js";
import type { JevClient } from "../harness/core/jev.js";
import { createContextualFollowupJudge, generateContextualFollowup } from "../harness/agentes/followup/producao.js";
import { decideContextualFollowup } from "../harness/agentes/followup/index.js";
import { resolveOpenAiCompatibleSettings } from "./ai-provider-settings.js";
import type { AgentFollowupRuntimeResult } from "./agent-followup-runtime.js";
import { publishPersistedConversationFollowup, type ConversationFollowupPublisher } from "../followups/conversation-followup-events.js";
import type { ConversationFollowupRecord, createConversationFollowupsService } from "../followups/conversation-followups.service.js";
import type { ConversationOutboundTextDelivery } from "../conversations/conversations.service.js";
import { sha } from "../messaging/canonical-values.js";

export function createContextualFollowupRuntime(input: {
  prisma: PrismaClient; followups: Pick<ReturnType<typeof createConversationFollowupsService>, "revalidateActiveFollowup" | "recoverClaimedFollowup" | "completeAutomaticFollowup">;
  outbound: ConversationOutboundTextDelivery; jev?: JevClient; publisher?: ConversationFollowupPublisher; now?: () => Date;
  snapshot?: typeof readContextualSnapshotInTransaction; generate?: typeof generateContextualFollowup;
}) {
  const db = input.prisma, clock = input.now ?? (() => new Date()), snapshot = input.snapshot ?? readContextualSnapshotInTransaction;
  const publish = (f: ConversationFollowupRecord) => publishPersistedConversationFollowup({ store: db.conversationFollowup as never, publisher: input.publisher, workspaceId: f.workspaceId, followupId: f.id });
  return { async runFollowup(run: { workspaceId: string; followupId: string; followup: ConversationFollowupRecord; claim: { lockedAt: Date } }): Promise<AgentFollowupRuntimeResult> {
    const f = run.followup, engine = resolveContextualFollowupEngine({ decision: f.decision });
    const recover = (reason: string, outcome: "failed" | "retry" = "failed") => input.followups.recoverClaimedFollowup({ workspaceId: run.workspaceId, followupId: f.id, claim: run.claim, outcome, reason });
    if (engine.status !== "contextual") { await recover("contextual_version_unsupported"); return { status: "failed", followupId: f.id, message: "Unsupported contextual version" }; }
    let crossedDelivery = false;
    try {
      const before = await input.followups.revalidateActiveFollowup({ workspaceId: run.workspaceId, followupId: f.id, claim: run.claim });
      if (before.status !== "valid") return { status: "skipped", followupId: f.id };
      const initial = await db.$transaction(tx => snapshot(tx, f, engine.engine.profile, clock()), { timeout: 15_000 });
      if (initial.status !== "ready") { await recover(`contextual_${initial.reason}`, "retry"); return { status: "failed", followupId: f.id, message: initial.detail }; }
      if (initial.context.sentAttempts.length >= initial.plan.steps.length) {
        await db.conversationFollowup.updateMany({ where: { workspaceId: run.workspaceId, id: f.id, status: "processing", activeKey: "active", lockedAt: run.claim.lockedAt }, data: { status: "skipped", activeKey: null, lockedAt: null, reason: "followup_step_limit" } });
        await publish(f); return { status: "skipped", followupId: f.id };
      }
      const settings = await resolveOpenAiCompatibleSettings(db, { workspaceId: run.workspaceId });
      if (!settings.active) { await recover("contextual_provider_unavailable", "retry"); return { status: "failed", followupId: f.id, message: "Provider unavailable" }; }
      const result = await (input.generate ?? generateContextualFollowup)({ context: initial.context, maxAttempts: initial.plan.steps.length,
        hoursWithoutResponse: Math.max(0, (clock().getTime() - new Date(f.anchorMessageAt).getTime()) / 3600000),
        deps: {
          model: createOpenAiCompatibleModel({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.chatModel, mode: "json", reasoningEffort: "low" }),
          analista: createOpenAiCompatibleModel({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.chatModel, mode: "json", reasoningEffort: "high", maxCompletionTokens: 16000 }),
          ...(input.jev ? { judge: createContextualFollowupJudge(input.jev) } : {})
        } });
      if (result.decision.type === "unavailable") { await recover(`contextual_${result.decision.reason}`, "retry"); return { status: "failed", followupId: f.id, message: result.decision.reason }; }
      const generationDecision = result.decision;
      const move = result.ficha ? decideContextualFollowup({ ficha: result.ficha, context: initial.context, maxAttempts: initial.plan.steps.length }) : null;
      const pendingKind = move?.type === "customer_message" ? move.pendingItem.kind : "none";
      const risk = result.decision.type === "customer_message" && /R\$|\d\s*%|desconto|garantid[oa]/i.test(result.decision.body) ? "commercial" : "none";
      const automatic = result.decision.type === "customer_message" && !requiresHumanReview({ delivery: initial.plan.humanCommercialDelivery,
        profileAllowsAutomatic: !blocksAutonomousAgent({ assistant: initial.policyInputs.channel.assistant }),
        legacyKindAllowsAutomatic: contextualKindAllowsAutomatic(f.kind, pendingKind), reviewApproved: result.reviewApproved, risk });
      const decision = { contextualEngine: { ...engine.engine, policyRevision: initial.policyRevision },
        sequenceFollowupIds: asRecord(f.decision).sequenceFollowupIds ?? [],
        contextualFollowup: { version: 1, output: result.decision, analysis: result.ficha?.contextualFollowup.analysis ?? null, reviewApproved: result.reviewApproved, risk, pendingKind } };
      const persisted = await db.$transaction(async tx => {
        const current = await snapshot(tx, f, engine.engine.profile, clock());
        if (current.status !== "ready" || current.policyRevision !== initial.policyRevision || !await contextualAnchorCurrent(tx, f, f.id)) return false;
        const output = generationDecision;
        const data = output.type === "skip" ? { status: "skipped" as const, activeKey: null, draftBody: null, reason: `contextual_${output.reason}` }
          : output.type === "seller_reminder" ? { status: "review" as const, kind: "seller_reminder" as const, draftBody: null, reason: "seller_reminder" }
          : { status: automatic ? "processing" as const : "review" as const, draftBody: output.body, reason: "contextual_review" };
        const changed = await tx.conversationFollowup.updateMany({ where: { workspaceId: run.workspaceId, id: f.id, status: "processing", activeKey: "active", lockedAt: run.claim.lockedAt },
          data: { ...data, lockedAt: automatic ? run.claim.lockedAt : null, decision: JSON.parse(JSON.stringify({ ...decision,
            ...(output.type === "seller_reminder" ? { resumo: output.summary, motivo: "A vez é da empresa." } : {}) })) } });
        return changed.count === 1;
      }, { timeout: 15_000 });
      if (!persisted) { await recover("contextual_policy_changed"); return { status: "failed", followupId: f.id, message: "Policy or authority changed" }; }
      await publish(f);
      if (result.decision.type === "skip") return { status: "skipped", followupId: f.id };
      if (!automatic || result.decision.type !== "customer_message") return { status: "review", followupId: f.id };
      const permittedAt = nextBusinessStart({ from: clock(), ...initial.plan });
      if (permittedAt > clock()) { await input.followups.recoverClaimedFollowup({ workspaceId: run.workspaceId, followupId: f.id, claim: run.claim, outcome: "retry", reason: "outside_business_hours", scheduledAt: permittedAt }); return { status: "deferred", followupId: f.id }; }
      const body = result.decision.body;
      const frozenDecision = { ...decision, contextualApproval: { actor: { kind: "agent", id: f.agentId }, claimAt: run.claim.lockedAt.toISOString(), bodyHash: sha(body), policyRevision: initial.policyRevision } };
      await db.$transaction(async tx => {
        const changed = await tx.conversationFollowup.updateMany({ where: { workspaceId: run.workspaceId, id: f.id, status: "processing", activeKey: "active", lockedAt: run.claim.lockedAt }, data: { finalBody: body, decision: frozenDecision as unknown as Prisma.InputJsonObject } });
        if (changed.count !== 1 || await tx.outboundIntent.findUnique({ where: { messageId: f.id } })) throw new Error("Contextual send claim changed");
        await tx.message.create({ data: { id: f.id, workspaceId: run.workspaceId, conversationId: f.conversationId, direction: "outbound", type: "text", body, status: "pending", metadata: { source: "followup_review", agentId: f.agentId, followupId: f.id, contextualFollowup: true } } });
      });
      crossedDelivery = true;
      const delivery = await input.outbound.createPendingOutboundMessage({ workspaceId: run.workspaceId, conversationId: f.conversationId, body, sentByUserId: null,
        reservedMessageId: f.id, metadata: { source: "ai_agent", agentId: f.agentId, followupId: f.id, contextualFollowup: true } });
      if (delivery.message.status !== "sent") throw new Error("Contextual delivery unconfirmed");
      const completed = await input.followups.completeAutomaticFollowup({ workspaceId: run.workspaceId, followupId: f.id, followup: f, claim: run.claim,
        agentBehaviorConfig: initial.policyInputs.agent.behaviorConfig, finalBody: body, decision: frozenDecision, sentMessageId: delivery.message.id, sentMessageAt: delivery.message.createdAt, now: clock() });
      if (completed.status === "not_active") return { status: "skipped", followupId: f.id };
      return { status: "sent", followupId: f.id, ...(completed.status === "scheduled" ? { nextFollowupId: completed.followupId } : {}) };
    } catch {
      try { await recover(crossedDelivery ? "contextual_delivery_uncertain" : "contextual_runtime_unavailable", crossedDelivery ? "failed" : "retry"); }
      catch { /* A retained processing lease expires to failed; never delegate uncertain I/O to a retrying caller. */ }
      return { status: "failed", followupId: f.id, message: crossedDelivery ? "Delivery requires reconciliation; no automatic retry" : "Contextual runtime unavailable" };
    }
  } };
}
