import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha } from './canonical-values.js';
import { createOutboundIntents } from './outbound-intents.js';
import { captureOutboundDomainFenceInTransaction as capture, type OutboundFenceKind } from './outbound-fences.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('DB authoritative outbound domain fences', () => {
    let db: PrismaClient;
    const ws: string[] = [];
    const api = createOutboundIntents();
    const tx = <T>(fn: (t: any) => Promise<T>) => db.$transaction(fn, { isolationLevel: 'ReadCommitted' });
    beforeAll(() => {
        const u = new URL(url!);
        if (u.hostname !== '127.0.0.1' || u.pathname !== '/messaging_test')
            throw Error('fixture DB');
        db = new PrismaClient({ datasources: { db: { url } } });
    });
    afterAll(async () => {
        for (const workspaceId of ws) {
            await db.outboundIntent.deleteMany({ where: { workspaceId } });
            await db.campaignProspectingReservation.deleteMany({ where: { workspaceId } });
            await db.campaign.deleteMany({ where: { workspaceId } });
            await db.automationRule.deleteMany({ where: { workspaceId } });
            await db.assistantSuggestionSend.deleteMany({ where: { workspaceId } });
            await db.assistantConversationState.deleteMany({ where: { workspaceId } });
            await db.assistantSuggestion.deleteMany({ where: { workspaceId } });
            await db.conversationFollowup.deleteMany({ where: { workspaceId } });
            await db.channel.deleteMany({ where: { workspaceId } });
            await db.aiAgent.deleteMany({ where: { workspaceId } });
            await db.contact.deleteMany({ where: { workspaceId } });
            await db.userProfile.deleteMany({ where: { workspaceId } });
            await db.workspaceMirror.deleteMany({ where: { workspaceId } });
        }
        await db.$disconnect();
    });
    async function fixture() {
        const workspaceId = `outbound-3b-fence-${randomUUID()}`;
        ws.push(workspaceId);
        const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
        const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: randomUUID() } });
        const contact = await db.contact.create({ data: { workspaceId, phone: '15550001111' } });
        const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
        const user = await db.userProfile.create({ data: { workspaceId, clerkUserId: randomUUID(), displayName: 'Fixture' } });
        const agent = await db.aiAgent.create({ data: { workspaceId, name: 'Fixture', systemPrompt: 'Fixture', status: 'active' } });
        const session = await db.aiAgentSession.create({ data: { workspaceId, conversationId: conversation.id, agentId: agent.id } });
        await db.conversation.update({ where: { id: conversation.id }, data: { activeAgentSessionId: session.id } });
        const source: any = {
            workspaceId, channelId: channel.id, channelProvider: 'evolution', provider: 'evolution', connectionId: connection.id, sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: '2026-10-01T00:00:00Z'
        };
        const request: any = {
            conversationId: conversation.id, destination: '15550001111@s.whatsapp.net', origin: { kind: 'human', originId: user.id, actionOrdinal: 0, requestKey: randomUUID() }, actor: { kind: 'user', id: user.id }, message: { type: 'text', body: 'hello', mediaUrl: null, metadata: { local: true } }, preparedMedia: [], domainFences: []
        };
        return { source, request, conversation, contact, agent, user, session };
    }
    async function fences(f: any, pairs: [
        OutboundFenceKind,
        string
    ][]) {
        const list = [];
        for (const [k, id] of pairs) {
            const value = await tx(t => capture(t, f.source.workspaceId, k, id));
            if (!value)
                throw Error("fixture fence missing");
            list.push(value);
        }
        return list;
    }
    async function reserve(f: any) { return tx(t => api.reserveLocalOutboundInTransaction(t, f.source, f.request, async () => true)) as Promise<any>; }
    async function begin(f: any, id: string) { return tx(t => api.beginDispatchInTransaction(t, f.source, { intentId: id, authorizeOrigin: async () => true })) as Promise<any>; }
    it('captures concrete scoped DB snapshots rather than caller booleans', async () => {
        const f = await fixture();
        const a = await tx(t => capture(t, f.source.workspaceId, 'conversation', f.conversation.id));
        expect(a).toMatchObject({
            kind: 'conversation', id: f.conversation.id, expected: { channel_id: f.source.channelId, active_agent_session_id: f.session.id }
        });
        expect(await tx(t => capture(t, 'another-workspace', 'conversation', f.conversation.id))).toBeNull();
    });
    it('campaign lease expiration and cancellation block dispatch; a late response still records acceptance', async () => {
        const f = await fixture();
        const campaign = await db.campaign.create({
            data: {
                workspaceId: f.source.workspaceId, name: 'fixture', messageBody: 'hello', status: 'sending', channelId: f.source.channelId
            }
        });
        const recipient = await db.campaignRecipient.create({
            data: {
                workspaceId: f.source.workspaceId, campaignId: campaign.id, contactId: f.contact.id, status: 'in_flight', channelId: f.source.channelId, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000), phoneSnapshot: '15550001111', contactSnapshot: { frozen: true }, verifiedAt: new Date()
            }
        });
        f.request.origin = { ...f.request.origin, kind: 'campaign_recipient', originId: recipient.id };
        f.request.actor = { kind: 'automation', id: campaign.id };
        f.request.domainFences = await fences(f, [
            ['campaign_recipient', recipient.id], ['campaign', campaign.id], ['conversation', f.conversation.id]
        ]);
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        await db.campaignRecipient.update({ where: { id: recipient.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
        expect((await begin(f, r.intent.id)).kind).toBe('stale_domain');
        expect(await db.outboundAttempt.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0);
    });
    it('partial or unrelated snapshots never authorize another origin', async () => { const f = await fixture(); f.request.origin = { ...f.request.origin, kind: 'campaign_recipient', originId: randomUUID() }; f.request.domainFences = [{ kind: 'conversation', id: f.conversation.id, expected: { ai_control_status: 'ai_active' } }]; expect((await reserve(f)).kind).toBe('domain_proof_required'); });
    it('assistant existing UUID and suggestion/send FKs remain intact through local binding', async () => {
        const f = await fixture();
        const message = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'outbound', type: 'text', body: 'hello', status: 'pending', sentByUserId: f.user.id, metadata: { local: true }
            }
        });
        const suggestion = await db.assistantSuggestion.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, agentId: f.agent.id, actorUserId: f.user.id, revision: 1, contextKey: 'frozen', agentHash: 'hash', body: 'hello'
            }
        });
        const send = await db.assistantSuggestionSend.create({
            data: {
                workspaceId: f.source.workspaceId, requestKey: randomUUID(), suggestionId: suggestion.id, bodyHash: sha(JSON.stringify('hello')), finalBody: 'hello', actorUserId: f.user.id, messageId: message.id
            }
        });
        const state = await db.assistantConversationState.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, status: 'sent', revision: 2, firstPendingAt: new Date()
            }
        });
        f.request.origin = { ...f.request.origin, kind: 'assistant_send', originId: send.id, requestKey: send.requestKey };
        f.request.existingMessageId = message.id;
        f.request.domainFences = await fences(f, [
            ['assistant_send', send.id], ['assistant_suggestion', suggestion.id], ['assistant_state', state.id], ['conversation', f.conversation.id]
        ]);
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        expect(r.intent.messageId).toBe(message.id);
        const d = await begin(f, r.intent.id);
        expect(d.kind).toBe('dispatch');
        await db.assistantSuggestionSend.update({ where: { id: send.id }, data: { status: 'uncertain' } });
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt.token, resultKey: 'late', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: f.request.destination, fromMe: true } }
            }
        }));
        expect(result.operationallyEligible).toBe(false);
        const b = await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt.token, resultId: result.result.id
        }));
        expect(b.kind).toBe('bound');
        expect(await db.message.findUniqueOrThrow({ where: { id: message.id } })).toEqual(message);
        expect(await db.assistantSuggestionSend.findUniqueOrThrow({ where: { id: send.id } })).toMatchObject({ messageId: message.id, suggestionId: suggestion.id, status: 'uncertain' });
    });
    it('followup UUID equals the preserved outbound Message UUID and canceled fences cannot send', async () => {
        const f = await fixture();
        const anchor = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'inbound', type: 'text', body: 'anchor'
            }
        });
        const followup = await db.conversationFollowup.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, agentId: f.agent.id, sessionId: f.session.id, kind: 'qualification', status: 'processing', activeKey: 'fixture', anchorMessageId: anchor.id, anchorMessageAt: anchor.createdAt, anchorIngestedAt: anchor.ingestedAt!, scheduledAt: new Date(Date.now() - 1000), lockedAt: new Date(), finalBody: 'hello'
            }
        });
        const message = await db.message.create({
            data: {
                id: followup.id, workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'outbound', type: 'text', body: 'hello', status: 'pending', metadata: { local: true }
            }
        });
        f.request.actor = { kind: 'agent', id: f.agent.id };
        f.request.origin = { ...f.request.origin, kind: 'followup', originId: followup.id };
        f.request.existingMessageId = message.id;
        f.request.domainFences = await fences(f, [
            ['followup', followup.id], ['agent', f.agent.id], ['session', f.session.id], ['conversation', f.conversation.id]
        ]);
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        expect(r.intent.messageId).toBe(followup.id);
        await db.conversationFollowup.update({ where: { id: followup.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
        expect((await begin(f, r.intent.id)).kind).toBe('stale_domain');
        expect(await db.message.findUniqueOrThrow({ where: { id: message.id } })).toEqual(message);
    });
    it('agent reply claim expiry is authoritative even when the caller supplies a fresh snapshot', async () => {
        const f = await fixture();
        const anchor = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'inbound', type: 'text', body: 'anchor'
            }
        });
        const reply = await db.aiAgentPendingReply.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, agentId: f.agent.id, sessionId: f.session.id, lastMessageId: anchor.id, status: 'processing', claimToken: randomUUID(), lockedAt: new Date(Date.now() - 6 * 60000), scheduledAt: new Date(Date.now() - 7 * 60000)
            }
        });
        f.request.origin = { ...f.request.origin, kind: 'agent_reply', originId: reply.id };
        f.request.actor = { kind: 'agent', id: f.agent.id };
        f.request.domainFences = await fences(f, [
            ['conversation', f.conversation.id], ['agent', f.agent.id], ['session', f.session.id], ['agent_reply', reply.id]
        ]);
        expect((await reserve(f)).kind).toBe('stale_domain');
        await db.aiAgentPendingReply.update({ where: { id: reply.id }, data: { lockedAt: new Date(), claimToken: randomUUID() } });
        f.request.domainFences = await fences(f, [
            ['conversation', f.conversation.id], ['agent', f.agent.id], ['session', f.session.id], ['agent_reply', reply.id]
        ]);
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        await db.conversation.update({ where: { id: f.conversation.id }, data: { aiControlStatus: 'human_controlled' } });
        expect((await begin(f, r.intent.id)).kind).toBe('stale_domain');
    });
    it('automation occurrence must equal the frozen run/node occurrence and cannot dispatch after disabling the rule', async () => {
        const f = await fixture();
        const frozenNode = { type: 'send_text', text: 'hello' }, nodeId = 'send-1', requestKey = randomUUID();
        const rule = await db.automationRule.create({
            data: {
                workspaceId: f.source.workspaceId, name: 'fixture', status: 'enabled', trigger: 'inbound', actions: [frozenNode]
            }
        });
        const run = await db.automationRun.create({
            data: {
                workspaceId: f.source.workspaceId, ruleId: rule.id, eventKey: 'fixture', status: 'running', input: { outboundNodes: [{ nodeId, occurrence: 1, requestKey, frozenNode }] }
            }
        });
        f.request.origin = {
            kind: 'automation_node', originId: run.id, actionOrdinal: 0, requestKey, nodeId, occurrence: 2, frozenNode
        };
        f.request.actor = { kind: 'automation', id: rule.id };
        f.request.domainFences = await fences(f, [['conversation', f.conversation.id], ['automation_rule', rule.id], ['automation_run', run.id]]);
        expect((await reserve(f)).kind).toBe('stale_domain');
        f.request.origin.occurrence = 1;
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        await db.automationRule.update({ where: { id: rule.id }, data: { status: 'disabled' } });
        expect((await begin(f, r.intent.id)).kind).toBe('stale_domain');
    });
    it('prospecting existing Message UUID requires the current module, generation and confirmed session provenance', async () => {
        const f = await fixture();
        const generation = randomUUID();
        const campaign = await db.campaign.create({
            data: {
                workspaceId: f.source.workspaceId, name: 'fixture', messageBody: 'hello', status: 'completed', channelId: f.source.channelId
            }
        });
        const recipient = await db.campaignRecipient.create({
            data: {
                workspaceId: f.source.workspaceId, campaignId: campaign.id, contactId: f.contact.id, status: 'sent', channelId: f.source.channelId
            }
        });
        const inbound = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'inbound', type: 'text', body: 'reply'
            }
        });
        await db.aiAgent.update({
            where: { id: f.agent.id }, data: { type: 'prospecting', handoffConfig: { prospectingGoal: 'fixture' } }
        });
        await db.aiAgentSession.update({
            where: { id: f.session.id }, data: {
                prospectingGeneration: generation, sourceCampaignId: campaign.id, sourceRecipientId: recipient.id, firstResponseMessageId: inbound.id, firstResponseAt: new Date()
            }
        });
        const reservation = await db.campaignProspectingReservation.create({
            data: {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, conversationId: f.conversation.id, contactId: f.contact.id, campaignId: campaign.id, recipientId: recipient.id, agentId: f.agent.id, generation, status: 'confirmed', dispatchStartedAt: new Date(), dispatchIntentAt: new Date(), confirmedAt: new Date()
            }
        });
        const metadata = {
            source: 'ai_agent', agentId: f.agent.id, prospectingGeneration: generation, prospectingDispatch: 'prepared'
        };
        const message = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'outbound', type: 'text', body: 'hello', metadata, status: 'pending'
            }
        });
        f.request.origin = { ...f.request.origin, kind: 'prospecting_delivery', originId: reservation.id };
        f.request.actor = { kind: 'agent', id: f.agent.id };
        f.request.existingMessageId = message.id;
        f.request.message.metadata = metadata;
        f.request.domainFences = await fences(f, [
            ['conversation', f.conversation.id], ['agent', f.agent.id], ['session', f.session.id], ['prospecting_reservation', reservation.id]
        ]);
        expect((await reserve(f)).kind).toBe('stale_domain');
        await db.workspaceMirror.create({ data: { workspaceId: f.source.workspaceId, limits: { modules: { campaignProspecting: true } } } });
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        expect(r.intent.messageId).toBe(message.id);
        await db.aiAgentSession.update({ where: { id: f.session.id }, data: { prospectingGeneration: randomUUID() } });
        expect((await begin(f, r.intent.id)).kind).toBe('stale_domain');
        expect(await db.message.findUniqueOrThrow({ where: { id: message.id } })).toEqual(message);
    });
    it('recertifies only pre-I/O followup lease fences while preserving request, Message UUID and all domain links', async () => {
        const f = await fixture();
        const anchor = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'inbound', type: 'text', body: 'anchor'
            }
        });
        const followup = await db.conversationFollowup.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, agentId: f.agent.id, sessionId: f.session.id, kind: 'qualification', status: 'processing', activeKey: 'active', anchorMessageId: anchor.id, anchorMessageAt: anchor.createdAt, anchorIngestedAt: anchor.ingestedAt!, scheduledAt: new Date(Date.now() - 1000), lockedAt: new Date(), finalBody: 'hello'
            }
        });
        const message = await db.message.create({
            data: {
                id: followup.id, workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'outbound', type: 'text', body: 'hello', status: 'pending', metadata: { local: true }
            }
        });
        f.request.actor = { kind: 'agent', id: f.agent.id };
        f.request.origin = { ...f.request.origin, kind: 'followup', originId: followup.id };
        f.request.existingMessageId = message.id;
        f.request.domainFences = await fences(f, [
            ['followup', followup.id], ['agent', f.agent.id], ['session', f.session.id], ['conversation', f.conversation.id]
        ]);
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        const initial = r.intent.request;
        await db.conversationFollowup.update({ where: { id: followup.id }, data: { lockedAt: new Date(Date.now() + 1), attempts: 1 } });
        expect((await begin(f, r.intent.id)).kind).toBe('stale_domain');
        const refreshed = await fences(f, [
            ['followup', followup.id], ['agent', f.agent.id], ['session', f.session.id], ['conversation', f.conversation.id]
        ]);
        const recert = await tx(t => api.recertifyPreparedOutboundInTransaction(t, f.source, { intentId: r.intent.id, domainFences: refreshed, authorizeOrigin: async () => true }));
        expect(recert.kind).toBe('recertified');
        const dispatched = await begin(f, r.intent.id);
        expect(dispatched.kind).toBe('dispatch');
        expect(dispatched.messageId).toBe(followup.id);
        expect((await db.outboundIntent.findUniqueOrThrow({ where: { id: r.intent.id } })).request).toEqual(initial);
        expect(await db.message.findUniqueOrThrow({ where: { id: message.id } })).toEqual(message);
        expect((await tx(t => api.recertifyPreparedOutboundInTransaction(t, f.source, { intentId: r.intent.id, domainFences: refreshed, authorizeOrigin: async () => true }))).kind).toBe('not_prepared');
    });
    it.each([true, false])('manual human-commercial followup preserves legitimate session context (session=%s)', async (hasSession) => {
        const f = await fixture();
        await db.conversation.update({
            where: { id: f.conversation.id }, data: { aiControlStatus: 'human_controlled', activeAgentSessionId: hasSession ? f.session.id : null }
        });
        await db.aiAgentSession.update({ where: { id: f.session.id }, data: { status: 'paused_by_human' } });
        if (!hasSession)
            await db.channel.update({
                where: { id: f.source.channelId }, data: { encryptedConfig: { assistant: { mode: 'on_demand', agentId: f.agent.id } } }
            });
        const anchor = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'inbound', type: 'text', body: 'anchor'
            }
        });
        const followup = await db.conversationFollowup.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, agentId: f.agent.id, sessionId: hasSession ? f.session.id : null, kind: 'human_commercial', status: 'processing', activeKey: 'active', anchorMessageId: anchor.id, anchorMessageAt: anchor.createdAt, anchorIngestedAt: anchor.ingestedAt!, scheduledAt: new Date(Date.now() - 1000), lockedAt: new Date(), finalBody: 'hello'
            }
        });
        await db.message.create({
            data: {
                id: followup.id, workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'outbound', type: 'text', body: 'hello', status: 'pending', sentByUserId: f.user.id, metadata: { local: true }
            }
        });
        f.request.origin = { ...f.request.origin, kind: 'followup', originId: followup.id };
        f.request.existingMessageId = followup.id;
        const pairs: [
            OutboundFenceKind,
            string
        ][] = [['followup', followup.id], ['agent', f.agent.id], ['conversation', f.conversation.id]];
        if (hasSession)
            pairs.push(['session', f.session.id]);
        f.request.domainFences = await fences(f, pairs);
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        const changed = await db.conversationFollowup.update({
            where: { id: followup.id }, data: { lockedAt: new Date(Date.now() + 1), anchorMessageAt: new Date(anchor.createdAt.getTime() + 1) }
        });
        const refreshed = await fences(f, pairs);
        expect((await tx(t => api.recertifyPreparedOutboundInTransaction(t, f.source, { intentId: r.intent.id, domainFences: refreshed, authorizeOrigin: async () => true }))).kind).toBe('stale_request_context');
        await db.conversationFollowup.update({
            where: { id: followup.id }, data: { anchorMessageAt: anchor.createdAt, lockedAt: new Date(changed.lockedAt!.getTime() + 1) }
        });
        f.request.domainFences = await fences(f, pairs);
        expect((await tx(t => api.recertifyPreparedOutboundInTransaction(t, f.source, { intentId: r.intent.id, domainFences: f.request.domainFences, authorizeOrigin: async () => true }))).kind).toBe('recertified');
        expect((await begin(f, r.intent.id)).kind).toBe('dispatch');
        await db.conversationFollowup.update({ where: { id: followup.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
        expect((await begin(f, r.intent.id)).kind).toBe('already_crossed_frontier');
    });
    it('followup expired ownership and newer inbound facts remain ineligible with freshly captured snapshots', async () => {
        const f = await fixture(), anchor = await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'inbound', type: 'text', body: 'anchor'
            }
        });
        const followup = await db.conversationFollowup.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, agentId: f.agent.id, sessionId: f.session.id, kind: 'qualification', status: 'processing', activeKey: 'active', anchorMessageId: anchor.id, anchorMessageAt: anchor.createdAt, anchorIngestedAt: anchor.ingestedAt!, scheduledAt: new Date(Date.now() - 1000), lockedAt: new Date(Date.now() - 11 * 60000), finalBody: 'hello'
            }
        });
        await db.message.create({
            data: {
                id: followup.id, workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'outbound', type: 'text', body: 'hello', status: 'pending', metadata: { local: true }
            }
        });
        f.request.actor = { kind: 'agent', id: f.agent.id };
        f.request.origin = { ...f.request.origin, kind: 'followup', originId: followup.id };
        f.request.existingMessageId = followup.id;
        const pairs: [
            OutboundFenceKind,
            string
        ][] = [
            ['followup', followup.id], ['agent', f.agent.id], ['session', f.session.id], ['conversation', f.conversation.id]
        ];
        f.request.domainFences = await fences(f, pairs);
        expect((await reserve(f)).kind).toBe('stale_domain');
        await db.conversationFollowup.update({ where: { id: followup.id }, data: { lockedAt: new Date() } });
        await db.message.create({
            data: {
                workspaceId: f.source.workspaceId, conversationId: f.conversation.id, direction: 'inbound', type: 'text', body: 'new reply', ingestedAt: new Date(anchor.ingestedAt!.getTime() + 1000)
            }
        });
        f.request.domainFences = await fences(f, pairs);
        expect((await reserve(f)).kind).toBe('stale_domain');
    });
    it('first prospecting campaign dispatch requires the current reservation generation and module without an invented session', async () => {
        const f = await fixture();
        await db.conversation.update({ where: { id: f.conversation.id }, data: { activeAgentSessionId: null } });
        await db.aiAgentSession.update({ where: { id: f.session.id }, data: { status: 'closed' } });
        await db.aiAgent.update({
            where: { id: f.agent.id }, data: { type: 'prospecting', handoffConfig: { prospectingGoal: 'fixture goal' } }
        });
        const campaign = await db.campaign.create({
            data: {
                workspaceId: f.source.workspaceId, name: 'fixture', mode: 'real', prospectingAgentId: f.agent.id, messageBody: 'hello', status: 'sending', channelId: f.source.channelId
            }
        });
        const recipient = await db.campaignRecipient.create({
            data: {
                workspaceId: f.source.workspaceId, campaignId: campaign.id, contactId: f.contact.id, status: 'in_flight', channelId: f.source.channelId, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000), phoneSnapshot: '15550001111', contactSnapshot: { frozen: true }, verifiedAt: new Date()
            }
        });
        const reservation = await db.campaignProspectingReservation.create({
            data: {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, conversationId: f.conversation.id, contactId: f.contact.id, campaignId: campaign.id, recipientId: recipient.id, agentId: f.agent.id, status: 'sending', dispatchStartedAt: new Date(), dispatchIntentAt: new Date()
            }
        });
        f.request.origin = { ...f.request.origin, kind: 'campaign_recipient', originId: recipient.id };
        f.request.actor = { kind: 'automation', id: campaign.id };
        const basic: [
            OutboundFenceKind,
            string
        ][] = [
            ['campaign', campaign.id], ['campaign_recipient', recipient.id], ['conversation', f.conversation.id]
        ];
        f.request.domainFences = await fences(f, basic);
        expect((await reserve(f)).kind).toBe('domain_proof_required');
        const full: [
            OutboundFenceKind,
            string
        ][] = [...basic, ['agent', f.agent.id], ['prospecting_reservation', reservation.id]];
        f.request.domainFences = await fences(f, full);
        expect((await reserve(f)).kind).toBe('stale_domain');
        await db.workspaceMirror.create({ data: { workspaceId: f.source.workspaceId, limits: { modules: { campaignProspecting: true } } } });
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        await db.campaignProspectingReservation.update({ where: { id: reservation.id }, data: { generation: randomUUID() } });
        expect((await begin(f, r.intent.id)).kind).toBe('stale_domain');
        f.request.domainFences = await fences(f, full);
        expect((await tx(t => api.recertifyPreparedOutboundInTransaction(t, f.source, { intentId: r.intent.id, domainFences: f.request.domainFences, authorizeOrigin: async () => true }))).kind).toBe('stale_request_context');
    });
});
