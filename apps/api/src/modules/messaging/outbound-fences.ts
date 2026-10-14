import { DEFAULT_FOLLOWUP_PROCESSING_LEASE_MS } from '../followups/conversation-followups.service.js';
import { readAssistantSettings } from '../assistant/assistant-policy.js';
import { autonomousAgentAllowed, validateProspectingAgent } from '../prospecting/prospecting-policy.js';
import { AGENT_REPLY_LEASE_MS } from '../agents/agent-reply-claim.js';
import { Prisma } from '@prisma/client';
import { enterCanonicalWorkspaceTransaction } from './canonical-boundary.js';
import { equal, json, sha } from './canonical-values.js';
import { normalizeChatAddress, record } from './whatsapp-identity.js';
import type { OutboundRequest } from './outbound-intents.js';
type Tx = Prisma.TransactionClient;
// The whitelist is part of the contract: no caller chooses which mandatory fields
// constitute freshness. Every snapshot compares the complete selected record.
const specs = {
    conversation: {
        table: 'conversations', fields: [
            'id', 'channel_id', 'contact_id', 'status', 'assigned_user_id', 'department_id', 'ai_control_status', 'ai_control_updated_at', 'active_agent_session_id', 'updated_at'
        ]
    },
    agent: {
        table: 'ai_agents', fields: [
            'id', 'status', 'type', 'allowed_actions', 'behavior_config', 'handoff_config', 'limits_config', 'updated_at'
        ]
    },
    session: {
        table: 'ai_agent_sessions', fields: [
            'id', 'conversation_id', 'agent_id', 'status', 'prospecting_generation', 'source_campaign_id', 'source_recipient_id', 'first_response_message_id', 'first_response_at', 'message_count', 'last_run_at', 'handoff_reason', 'handoff_action_completed_at', 'metadata', 'updated_at'
        ]
    },
    agent_reply: {
        table: 'ai_agent_pending_replies', fields: [
            'id', 'conversation_id', 'agent_id', 'session_id', 'last_message_id', 'claim_token', 'prospecting_generation', 'status', 'scheduled_at', 'locked_at', 'attempts', 'instruction', 'updated_at'
        ]
    },
    followup: {
        table: 'conversation_followups', fields: [
            'id', 'conversation_id', 'agent_id', 'session_id', 'kind', 'status', 'active_key', 'step_index', 'anchor_message_id', 'anchor_message_at', 'anchor_ingested_at', 'scheduled_at', 'locked_at', 'attempts', 'final_body', 'cancelled_at', 'sent_at', 'updated_at'
        ]
    },
    campaign: {
        table: 'campaigns', fields: [
            'id', 'status', 'channel_id', 'cadence', 'scheduled_at', 'activation_key', 'mode', 'message_body', 'templates', 'prospecting_agent_id', 'updated_at'
        ]
    },
    campaign_recipient: {
        table: 'campaign_recipients', fields: [
            'id', 'campaign_id', 'contact_id', 'channel_id', 'status', 'lease_token', 'lease_expires_at', 'verified_at', 'scheduled_at', 'phone_snapshot', 'contact_snapshot', 'sequence_number', 'gap_seconds', 'pause_seconds', 'provider_message_id', 'result', 'updated_at'
        ]
    },
    campaign_throttle: {
        table: 'campaign_channel_throttles', fields: ['channel_id', 'next_available_at', 'attempts_since_pause', 'updated_at']
    },
    prospecting_reservation: {
        table: 'campaign_prospecting_reservations', fields: [
            'id', 'channel_id', 'conversation_id', 'contact_id', 'campaign_id', 'recipient_id', 'agent_id', 'generation', 'status', 'dispatch_intent_at', 'confirmed_at', 'updated_at'
        ]
    },
    assistant_send: {
        table: 'assistant_suggestion_sends', fields: [
            'id', 'suggestion_id', 'request_key', 'message_id', 'actor_user_id', 'body_hash', 'final_body', 'status', 'updated_at'
        ]
    },
    assistant_suggestion: {
        table: 'assistant_suggestions', fields: [
            'id', 'conversation_id', 'agent_id', 'actor_user_id', 'revision', 'context_key', 'agent_hash', 'body', 'created_at'
        ]
    },
    assistant_state: {
        table: 'assistant_conversation_states', fields: [
            'id', 'conversation_id', 'revision', 'lease_token', 'lease_until', 'status', 'last_message_id', 'requested_by_id', 'updated_at'
        ]
    },
    automation_run: {
        table: 'automation_runs', fields: ['id', 'rule_id', 'event_key', 'status', 'input', 'result', 'updated_at']
    },
    automation_rule: {
        table: 'automation_rules', fields: ['id', 'status', 'trigger', 'conditions', 'actions', 'updated_at']
    },
} as const;
export type OutboundFenceKind = keyof typeof specs;
export type OutboundDomainFence = {
    [K in OutboundFenceKind]: {
        kind: K;
        id: string;
        expected: Prisma.InputJsonObject;
    };
}[OutboundFenceKind];
function known(kind: string): kind is OutboundFenceKind { return Object.hasOwn(specs, kind); }
export async function captureOutboundDomainFenceInTransaction(tx: Tx, workspaceId: string, kind: OutboundFenceKind, id: string): Promise<OutboundDomainFence | null> {
    await enterCanonicalWorkspaceTransaction(tx, workspaceId);
    if (!known(kind))
        throw Error('Unsupported domain fence');
    const spec = specs[kind];
    const rows = await tx.$queryRaw<Array<{
        value: Prisma.JsonObject;
    }>>(Prisma.sql `SELECT to_jsonb(t) AS value FROM ${Prisma.raw(spec.table)} t WHERE workspace_id=${workspaceId} AND ${Prisma.raw(kind === 'campaign_throttle' ? 'channel_id' : 'id')}=${id}::uuid FOR SHARE`);
    if (!rows[0])
        return null;
    const expected = Object.fromEntries(spec.fields.map(field => [field, rows[0]!.value[field] ?? null]));
    return { kind, id, expected: json(expected) as Prisma.InputJsonObject };
}
/** Snapshot equality is necessary but insufficient: origin linkage, status, lease,
 * cancellation, generation, current control and frozen request are also checked. */
export async function verifyOutboundDomainInTransaction(tx: Tx, scope: {
    workspaceId: string;
    channelId: string;
}, request: OutboundRequest): Promise<'valid' | 'domain_proof_required' | 'stale_domain'> {
    await enterCanonicalWorkspaceTransaction(tx, scope.workspaceId);
    const origin = request.origin, kind = origin.kind === 'attachment_part' ? origin.parentKind : origin.kind;
    if (kind === 'human')
        return request.actor.kind === 'user' && origin.originId === request.actor.id ? 'valid' : 'stale_domain';
    const required: Record<string, OutboundFenceKind[]> = {
        agent_reply: ['conversation', 'agent_reply', 'agent', 'session'], automation_node: ['conversation', 'automation_run', 'automation_rule'], campaign_recipient: ['conversation', 'campaign_recipient', 'campaign'], prospecting_delivery: ['conversation', 'prospecting_reservation', 'agent', 'session'], assistant_send: ['conversation', 'assistant_send', 'assistant_suggestion', 'assistant_state'], followup: ['conversation', 'followup', 'agent']
    };
    const fences = request.domainFences;
    if (!Array.isArray(fences) || fences.some(f => !f || !known(f.kind)) || !required[kind] || required[kind]!.some(k => fences.filter(f => f.kind === k).length !== 1))
        return 'domain_proof_required';
    const byKind = new Map<OutboundFenceKind, Prisma.JsonObject>();
    for (const f of fences) {
        const spec = specs[f.kind as OutboundFenceKind], expected = record(f.expected);
        if (!equal(Object.keys(expected).sort(), [...spec.fields].sort()))
            return 'domain_proof_required';
        const current = await captureOutboundDomainFenceInTransaction(tx, scope.workspaceId, f.kind as OutboundFenceKind, f.id);
        if (!current || !equal(current.expected, f.expected))
            return 'stale_domain';
        byKind.set(f.kind as OutboundFenceKind, current.expected as Prisma.JsonObject);
    }
    const row = (k: OutboundFenceKind) => byKind.get(k) ?? {};
    const conv = row('conversation'), session = row('session'), agent = row('agent');
    const now = (await tx.$queryRaw<Array<{
        now: Date;
    }>> `SELECT clock_timestamp() AS now`)[0]!.now.getTime();
    const time = (value: unknown) => typeof value === 'string' ? Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`) : NaN;
    const beforeNow = (value: unknown) => Number.isFinite(time(value)) && time(value) <= now;
    const later = (value: unknown) => Number.isFinite(time(value)) && time(value) > now;
    if (conv.id !== request.conversationId || conv.channel_id !== scope.channelId)
        return 'stale_domain';
    const autonomous = kind === 'agent_reply' || kind === 'prospecting_delivery' || (kind === 'followup' && request.actor.kind === 'agent') || kind === 'automation_node';
    if (autonomous && (conv.ai_control_status !== 'agent_allowed' || conv.status === 'closed'))
        return 'stale_domain';
    if (['agent_reply', 'prospecting_delivery', 'followup'].includes(kind)) {
        if (agent.id !== request.actor.id && request.actor.kind === 'agent')
            return 'stale_domain';
        if (agent.status !== 'active')
            return 'stale_domain';
        const humanFollowup = kind === 'followup' && request.actor.kind === 'user' && row('followup').kind === 'human_commercial';
        if (humanFollowup && row('followup').session_id === null) {
            if (conv.active_agent_session_id !== null || byKind.has('session'))
                return 'stale_domain';
            const channel = await tx.channel.findFirst({ where: { workspaceId: scope.workspaceId, id: scope.channelId } });
            const configured = readAssistantSettings(channel?.encryptedConfig);
            if (configured.mode === 'disabled' || configured.agentId !== agent.id)
                return 'stale_domain';
        }
        else {
            if (!byKind.has('session'))
                return 'domain_proof_required';
            const allowed = humanFollowup ? ['active', 'paused_by_human', 'handoff_requested'] : ['active'];
            if (!allowed.includes(String(session.status)) || session.agent_id !== agent.id || session.conversation_id !== request.conversationId
                || (humanFollowup ? conv.active_agent_session_id !== null && conv.active_agent_session_id !== session.id : conv.active_agent_session_id !== session.id))
                return 'stale_domain';
        }
    }
    if (['agent_reply', 'prospecting_delivery'].includes(kind) || (kind === 'followup' && request.actor.kind === 'agent')) {
        const channel = await tx.channel.findFirst({ where: { workspaceId: scope.workspaceId, id: scope.channelId } });
        if (request.actor.kind !== 'agent' || !await autonomousAgentAllowed(tx, {
            workspaceId: scope.workspaceId, conversationId: request.conversationId, agentId: request.actor.id, sessionId: String(session.id), expectedGeneration: typeof session.prospecting_generation === 'string' ? session.prospecting_generation : null, channelConfig: channel?.encryptedConfig, aiControlStatus: String(conv.ai_control_status)
        }))
            return 'stale_domain';
    }
    if (kind === 'agent_reply') {
        const p = row('agent_reply');
        if (p.id !== origin.originId || p.conversation_id !== request.conversationId || p.agent_id !== agent.id || p.session_id !== (session.id ?? null) || p.status !== 'processing' || !p.claim_token || !p.locked_at || !beforeNow(p.scheduled_at) || time(p.locked_at) <= now - AGENT_REPLY_LEASE_MS || p.prospecting_generation !== session.prospecting_generation)
            return 'stale_domain';
        if (origin.kind === 'attachment_part' && (!Number.isSafeInteger(origin.part) || origin.part < 0))
            return 'stale_domain';
    }
    if (kind === 'followup') {
        // 3C must freeze selected final_body and the reserved Message body before the frontier.
        const p = row('followup');
        if (p.id !== origin.originId || p.conversation_id !== request.conversationId || p.agent_id !== agent.id || p.session_id !== (session.id ?? null) || p.status !== 'processing' || !p.locked_at || time(p.locked_at) <= now - DEFAULT_FOLLOWUP_PROCESSING_LEASE_MS || p.cancelled_at || p.sent_at || !p.active_key || !beforeNow(p.scheduled_at) || request.existingMessageId !== p.id || p.final_body !== request.message.body)
            return 'stale_domain';
        const anchor = await tx.message.findFirst({
            where: {
                workspaceId: scope.workspaceId, conversationId: request.conversationId, id: String(p.anchor_message_id), direction: 'inbound'
            }
        });
        if (!anchor || !anchor.ingestedAt || anchor.createdAt.getTime() !== time(p.anchor_message_at) || anchor.ingestedAt.getTime() !== time(p.anchor_ingested_at))
            return 'stale_domain';
        const newer = await tx.message.findFirst({
            where: {
                workspaceId: scope.workspaceId, conversationId: request.conversationId, id: { not: request.existingMessageId }, ingestedAt: { gt: anchor.ingestedAt }, OR: [{ direction: 'inbound' }, { direction: 'outbound', status: { notIn: ['pending', 'failed'] } }]
            }
        });
        if (newer)
            return 'stale_domain';
    }
    if (kind === 'campaign_recipient') {
        const p = row('campaign_recipient'), c = row('campaign');
        if (p.id !== origin.originId || p.campaign_id !== c.id || p.channel_id !== scope.channelId || c.channel_id !== scope.channelId || p.contact_id !== conv.contact_id || p.status !== 'in_flight' || !p.lease_token || !later(p.lease_expires_at) || !p.verified_at || !['scheduled', 'sending'].includes(String(c.status)) || p.provider_message_id)
            return 'stale_domain';
        if (c.prospecting_agent_id !== null) {
            // The campaign's first send precedes session activation. A verified
            // sending reservation is mandatory; an active session must not be invented.
            if (!byKind.has('agent') || !byKind.has('prospecting_reservation'))
                return 'domain_proof_required';
            const reservation = row('prospecting_reservation');
            if (agent.id !== c.prospecting_agent_id || reservation.agent_id !== agent.id
                || reservation.campaign_id !== c.id || reservation.recipient_id !== p.id
                || reservation.channel_id !== scope.channelId || reservation.contact_id !== conv.contact_id
                || reservation.conversation_id !== request.conversationId || !reservation.generation
                || reservation.status !== 'sending' || !reservation.dispatch_intent_at || reservation.confirmed_at
                || conv.ai_control_status !== 'agent_allowed' || conv.assigned_user_id || conv.active_agent_session_id
                || conv.status === 'closed')
                return 'stale_domain';
            if (await tx.aiAgentSession.count({
                where: { workspaceId: scope.workspaceId, conversationId: request.conversationId, status: 'active' }
            }))
                return 'stale_domain';
            const contact = await tx.contact.findFirst({ where: { workspaceId: scope.workspaceId, id: String(conv.contact_id) } });
            if (!contact || contact.isGroup || contact.phone.endsWith('@g.us'))
                return 'stale_domain';
            try {
                await validateProspectingAgent(tx, scope.workspaceId, String(agent.id), scope.channelId);
            }
            catch (error) {
                if (!(error instanceof Error) || !error.message.startsWith('PROSPECTING_UNAVAILABLE:'))
                    throw error;
                return 'stale_domain';
            }
        }
        const phone = String(p.phone_snapshot ?? '');
        if (normalizeChatAddress(phone.includes('@') ? phone : `${phone}@s.whatsapp.net`) !== request.destination)
            return 'stale_domain';
        const throttle = await tx.campaignChannelThrottle.findUnique({ where: { workspaceId_channelId: scope } });
        if (throttle && (!byKind.has('campaign_throttle') || row('campaign_throttle').channel_id !== scope.channelId))
            return 'domain_proof_required';
        if (throttle?.nextAvailableAt && throttle.nextAvailableAt.getTime() > now)
            return 'stale_domain';
    }
    if (kind === 'prospecting_delivery') {
        const p = row('prospecting_reservation');
        if (p.id !== origin.originId || p.channel_id !== scope.channelId || p.conversation_id !== request.conversationId || p.contact_id !== conv.contact_id || p.agent_id !== agent.id || p.generation !== session.prospecting_generation || p.status !== 'confirmed' || !p.confirmed_at || !p.dispatch_intent_at)
            return 'stale_domain';
        const metadata = record(request.message.metadata);
        if (metadata.agentId !== agent.id || metadata.prospectingGeneration !== p.generation)
            return 'stale_domain';
    }
    if (kind === 'assistant_send') {
        const send = row('assistant_send'), suggestion = row('assistant_suggestion'), state = row('assistant_state');
        if (send.id !== origin.originId || send.request_key !== origin.requestKey || send.suggestion_id !== suggestion.id || send.message_id !== request.existingMessageId || send.actor_user_id !== request.actor.id || request.actor.kind !== 'user' || send.final_body !== request.message.body || send.body_hash !== sha(JSON.stringify(request.message.body)) || send.status !== 'pending' || suggestion.conversation_id !== request.conversationId || state.conversation_id !== request.conversationId || !['ready', 'sent'].includes(String(state.status)))
            return 'stale_domain';
    }
    if (kind === 'automation_node') {
        if (origin.kind !== 'automation_node' || request.actor.kind !== 'automation' || !Number.isSafeInteger(origin.occurrence) || origin.occurrence < 0)
            return 'stale_domain';
        const run = row('automation_run'), rule = row('automation_rule');
        if (run.id !== origin.originId || run.rule_id !== rule.id || rule.status !== 'enabled' || !['running', 'processing'].includes(String(run.status)) || request.actor.id !== rule.id)
            return 'stale_domain';
        const frozen = record(run.input).outboundNodes;
        if (!Array.isArray(frozen) || frozen.filter(n => { const node = record(n); return node.nodeId === origin.nodeId && node.occurrence === origin.occurrence && node.requestKey === origin.requestKey && equal(node.frozenNode, origin.frozenNode); }).length !== 1)
            return 'stale_domain';
    }
    return 'valid';
}
/** Only lease ownership and authoritative cadence progression may be refreshed.
 * Frozen origin/context/generation/content fields must remain exactly equal. */
export function compatiblePreparedRecertification(previous: OutboundDomainFence[], current: OutboundDomainFence[]) {
    const refreshable: Partial<Record<OutboundFenceKind, readonly string[]>> = {
        agent_reply: ['claim_token', 'locked_at', 'attempts', 'updated_at'],
        followup: ['locked_at', 'attempts', 'updated_at'],
        campaign_recipient: ['lease_token', 'lease_expires_at', 'verified_at', 'updated_at'],
        campaign_throttle: ['next_available_at', 'attempts_since_pause', 'updated_at'],
        assistant_state: ['lease_token', 'lease_until', 'updated_at'],
    };
    if (previous.some(p => current.filter(c => c.kind === p.kind && c.id === p.id).length !== 1))
        return false;
    if (current.some(c => !previous.some(p => p.kind === c.kind && p.id === c.id) && c.kind !== 'campaign_throttle'))
        return false;
    return previous.every(p => { const c = current.find(c => c.kind === p.kind && c.id === p.id)!; const ignored = refreshable[p.kind] ?? []; const semantic = (v: Prisma.InputJsonObject) => Object.fromEntries(Object.entries(v).filter(([key]) => !ignored.includes(key))); return equal(semantic(p.expected), semantic(c.expected)); });
}
