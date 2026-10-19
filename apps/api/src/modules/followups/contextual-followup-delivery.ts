import type { PrismaClient } from "@prisma/client";
import type { SendTextResult } from "../evolution/evolution.client.js";
import { deriveTrustedMessagingContext } from "../messaging/canonical-source.js";
import { captureOutboundDomainFenceInTransaction, type OutboundDomainFence } from "../messaging/outbound-fences.js";
import { createOutboundIntents, type AuthorizeOutboundOrigin } from "../messaging/outbound-intents.js";
import { normalizeChatAddress, record } from "../messaging/whatsapp-identity.js";
import { createCanonicalStore } from "../messaging/canonical-store.js";
import { enterCanonicalWorkspaceTransaction, enterCanonicalTransaction } from "../messaging/canonical-boundary.js";

export class ContextualFollowupBlocked extends Error {
  constructor(message: string) { super(message); this.name = "ContextualFollowupBlocked"; }
}

/** The selected physical connection is fixed before crossing the existing durable frontier. */
export async function sendCanonicalFollowupText(input: {
  prisma: PrismaClient; workspaceId: string; channelId: string; messageId: string; connectionId: string;
  provider: "evolution" | "waha"; text: string; send: () => Promise<SendTextResult>;
}): Promise<SendTextResult> {
  const api = createOutboundIntents(), scope = { workspaceId: input.workspaceId, channelId: input.channelId };
  const authorize: AuthorizeOutboundOrigin = async (tx, request) => {
    if (request.origin.kind !== "followup" || request.origin.originId !== input.messageId || request.messageId !== input.messageId) return false;
    const f = await tx.conversationFollowup.findFirst({ where: { workspaceId: input.workspaceId, id: input.messageId, conversationId: request.conversationId } });
    const actor = record(record(record(f?.decision).contextualApproval).actor);
    return !!f && actor.kind === request.actor.kind && actor.id === request.actor.id;
  };
  let dispatch;
  try {
    dispatch = await input.prisma.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
      const source = await deriveTrustedMessagingContext(tx, { ...scope, authenticatedSource: { provider: input.provider, connectionId: input.connectionId }, mode: "live", observedAt: new Date().toISOString() });
      await enterCanonicalTransaction(tx, source);
      const f = await tx.conversationFollowup.findFirstOrThrow({ where: { workspaceId: input.workspaceId, id: input.messageId } });
      const message = await tx.message.findFirstOrThrow({ where: { workspaceId: input.workspaceId, id: f.id, conversationId: f.conversationId, direction: "outbound", status: "pending", type: "text" } });
      const conversation = await tx.conversation.findFirstOrThrow({ where: { ...scope, id: f.conversationId }, include: { contact: true } });
      const actor = record(record(f.decision).contextualApproval).actor as { kind: "user" | "agent"; id: string };
      if (!actor || !["user", "agent"].includes(actor.kind) || !actor.id || message.body !== input.text) throw new Error("Frozen approval changed");
      const destination = normalizeChatAddress(`${conversation.contact.phone}@s.whatsapp.net`);
      if (!destination) throw new Error("Invalid follow-up destination");
      const identities: Array<[OutboundDomainFence["kind"], string]> = [["conversation", conversation.id], ["contextual_followup", f.id], ["contextual_agent", f.agentId], ["contextual_channel", conversation.channelId]];
      if (f.sessionId) identities.push(["contextual_session", f.sessionId]);
      const fences: OutboundDomainFence[] = [];
      for (const [kind, id] of identities) {
        const fence = await captureOutboundDomainFenceInTransaction(tx, input.workspaceId, kind, id);
        if (!fence) throw new Error(`Missing contextual fence: ${kind}`);
        fences.push(fence);
      }
      const reserved = await api.reserveLocalOutboundInTransaction(tx, source, { conversationId: conversation.id, destination, existingMessageId: message.id,
        origin: { kind: "followup", originId: f.id, actionOrdinal: 0, requestKey: f.id }, actor,
        message: { type: "text", body: message.body, mediaUrl: null, metadata: message.metadata as object }, preparedMedia: [], domainFences: fences }, authorize);
      if (reserved.kind !== "reserved" && reserved.kind !== "existing") throw new Error(`Follow-up reserve blocked: ${reserved.kind}`);
      const started = await api.beginDispatchInTransaction(tx, source, { intentId: reserved.intent.id, authorizeOrigin: authorize });
      if (started.kind !== "dispatch") throw new Error(`Follow-up dispatch blocked: ${started.kind}`);
      return started;
    }, { timeout: 15_000 });
  } catch (error) { throw new ContextualFollowupBlocked(error instanceof Error ? error.message : "Canonical follow-up unavailable"); }
  let sent: SendTextResult;
  try { sent = await input.send(); }
  catch (error) {
    await input.prisma.$transaction(tx => api.recordDispatchResultInTransaction(tx, { ...scope, token: dispatch.attempt.token, resultKey: "provider_response",
      evidence: { transport: "transport_error", status: null, bodyState: "unavailable", raw: null } }));
    throw error;
  }
  const bound = await input.prisma.$transaction(async tx => {
    const result = await api.recordDispatchResultInTransaction(tx, { ...scope, token: dispatch.attempt.token, resultKey: "provider_response",
      evidence: { transport: "http", status: 200, bodyState: "json", raw: sent.raw }, authorizeOrigin: authorize });
    if (result.kind !== "recorded" && result.kind !== "existing") throw new Error(`Follow-up result blocked: ${result.kind}`);
    const binding = await api.bindLocalOutboundInTransaction(tx, { ...scope, token: dispatch.attempt.token, resultId: result.result.id });
    if (binding.kind === "bound") {
      const store = createCanonicalStore();
      for (const observation of await tx.canonicalObservation.findMany({ where: { ...scope, state: "held", reason: "outbound_dispatch_ambiguity", resolutionEvidence: { path: ["intentIds"], array_contains: [dispatch.attempt.intentId] } } })) {
        await store.reprocessHeldMessageObservationInTransaction(tx, { ...scope, observationId: observation.id });
      }
    }
    return binding;
  }, { timeout: 15_000 });
  if (bound.kind !== "bound") throw new Error(`Follow-up binding requires review: ${bound.kind}`);
  return { ...sent, localMessageId: dispatch.messageId };
}
