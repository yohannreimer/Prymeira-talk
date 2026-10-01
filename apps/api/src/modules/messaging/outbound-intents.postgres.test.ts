import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanonicalStore } from './canonical-store.js';
import { parseWahaMessageKey } from './whatsapp-identity.js';
import { createOutboundIntents, type OutboundRequest } from './outbound-intents.js';
import type { SendEvidence } from './outbound-evidence.js';
import type { TrustedMessagingContext } from './normalized-event.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
const PN = '15550001111@s.whatsapp.net';
describe.skipIf(!url)('persistent outbound intents', () => {
    let db: PrismaClient;
    const workspaces: string[] = [];
    const api = createOutboundIntents();
    beforeAll(() => {
        const u = new URL(url!);
        if (u.hostname !== '127.0.0.1' || u.pathname !== '/messaging_test')
            throw Error('test DB only');
        db = new PrismaClient({ datasources: { db: { url } } });
    });
    afterAll(async () => {
        for (const workspaceId of workspaces) {
            await db.outboundCorrelation.deleteMany({ where: { workspaceId } });
            await db.outboundIntent.deleteMany({ where: { workspaceId } });
            await db.channel.deleteMany({ where: { workspaceId } });
            await db.contact.deleteMany({ where: { workspaceId } });
            await db.userProfile.deleteMany({ where: { workspaceId } });
        }
        await db.$disconnect();
    });
    async function fixture() {
        const workspaceId = randomUUID();
        workspaces.push(workspaceId);
        const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
        const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: randomUUID() } });
        const user = await db.userProfile.create({ data: { workspaceId, clerkUserId: randomUUID(), displayName: 'Fixture' } });
        const contact = await db.contact.create({ data: { workspaceId, phone: '15550001111' } });
        const conversation = await db.conversation.create({ data: { workspaceId, channelId: channel.id, contactId: contact.id } });
        const source: TrustedMessagingContext = {
            workspaceId, channelId: channel.id, channelProvider: 'evolution', provider: 'evolution', connectionId: connection.id, sessionName: connection.sessionName, lifecycleGeneration: 0, mode: 'live', observedAt: '2026-10-01T00:00:00Z'
        };
        const request: OutboundRequest = {
            conversationId: conversation.id, destination: PN, origin: { kind: 'human', originId: user.id, actionOrdinal: 0, requestKey: randomUUID() }, actor: { kind: 'user', id: user.id }, message: { type: 'text', body: 'hello', mediaUrl: null, metadata: { local: true } }, preparedMedia: [], domainFences: []
        };
        return { source: source as TrustedMessagingContext, request, conversation, user };
    }
    const tx = <T>(fn: (t: any) => Promise<T>) => db.$transaction(fn, { isolationLevel: 'ReadCommitted' });
    const reserve = (f: any, request = f.request) => tx(t => api.reserveLocalOutboundInTransaction(t, f.source, request, async () => true));
    const begin = (f: any, intentId: string) => tx(t => api.beginDispatchInTransaction(t, f.source, { intentId, authorizeOrigin: async () => true }));
    it('reserves a real outbound UUID in a conversation without inbound identity before any I/O', async () => {
        const f = await fixture();
        const r = await reserve(f);
        expect(r.kind).toBe('reserved');
        const message = await db.message.findUniqueOrThrow({ where: { id: r.intent!.messageId } });
        expect(message).toMatchObject({
            conversationId: f.conversation.id, direction: 'outbound', body: 'hello', providerMessageId: null, providerEventId: null, sentByUserId: f.user.id, status: 'pending', metadata: { local: true }
        });
        expect(r.intent!.state).toBe('prepared');
        expect(await db.canonicalMessageIdentity.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0);
    });
    it('competing reserves return one intent and compare the full immutable request', async () => { const f = await fixture(); const rs = await Promise.all([reserve(f), reserve(f), reserve(f)]); expect(rs.every(r => ['reserved', 'existing'].includes(r.kind))).toBe(true); expect(new Set(rs.map(r => r.intent!.id)).size).toBe(1); const conflict = await reserve(f, { ...f.request, message: { ...f.request.message, body: 'different' } }); expect(conflict.kind).toBe('request_conflict'); expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1); });
    it('rollback persists neither reservation nor message nor authority', async () => { const f = await fixture(); await expect(tx(async (t) => { const r = await api.reserveLocalOutboundInTransaction(t, f.source, f.request, async () => true); expect(r.kind).toBe('reserved'); throw Error('rollback'); })).rejects.toThrow('rollback'); expect(await db.outboundIntent.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0); expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0); });
    it('permits only one dispatcher and orders the canonical conversation lane', async () => { const f = await fixture(); const a = await reserve(f), b = await reserve(f, { ...f.request, origin: { ...f.request.origin, requestKey: randomUUID() } }); expect((await begin(f, b.intent!.id)).kind).toBe('lane_blocked'); const rs = await Promise.all([begin(f, a.intent!.id), begin(f, a.intent!.id)]); expect(rs.map(r => r.kind).sort()).toEqual(['already_crossed_frontier', 'dispatch']); expect(await db.outboundAttempt.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1); expect((await begin(f, b.intent!.id)).kind).toBe('lane_blocked'); });
    it('canceling prepared has no uncertain send while crash after the I/O frontier cannot retry', async () => { const f = await fixture(); const r = await reserve(f); expect((await tx(t => api.cancelPreparedInTransaction(t, { workspaceId: f.source.workspaceId, channelId: f.source.channelId, intentId: r.intent!.id }, async () => true))).kind).toBe('canceled'); expect((await begin(f, r.intent!.id)).kind).toBe('not_prepared'); const a = await reserve(f, { ...f.request, origin: { ...f.request.origin, requestKey: randomUUID() } }); const d = await begin(f, a.intent!.id); expect(d.kind).toBe('dispatch'); expect((await tx(t => api.recoverDispatchInTransaction(t, { workspaceId: f.source.workspaceId, channelId: f.source.channelId, intentId: a.intent!.id }))).kind).toBe('uncertain'); expect((await begin(f, a.intent!.id)).kind).toBe('not_prepared'); });
    it('records acceptance after stale lifecycle and cancellation without resurrecting a domain or allowing a resend', async () => {
        const f = await fixture();
        const r = await reserve(f), d = await begin(f, r.intent!.id);
        await db.channelConnection.update({
            where: { id: f.source.connectionId! }, data: { lifecycleGeneration: 2, sessionName: 'new-session' }
        });
        const evidence: SendEvidence = {
            transport: 'http', status: 200, raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }, bodyState: 'json'
        };
        const result = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'late', evidence
        }));
        expect(result.kind).toBe('recorded');
        expect(result.result!.outcome).toBe('accepted');
        expect(result.operationallyEligible).toBe(false);
        expect(result.intent!.state).toBe('accepted_unbound');
        expect(await db.outboundResult.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1);
        expect(await db.message.findUniqueOrThrow({ where: { id: r.intent!.messageId } })).toMatchObject({ status: 'pending', providerMessageId: null });
    });
    it.each<SendEvidence>([
        { transport: 'http', status: 200, raw: {}, bodyState: 'json' }, { transport: 'timeout', status: null, raw: null, bodyState: 'unavailable' }, { transport: 'http', status: 400, raw: { error: 'generic' }, bodyState: 'json' }
    ])('acceptance without ID and uncertain transport never release a retry %#', async (evidence) => {
        const f = await fixture();
        const r = await reserve(f), d = await begin(f, r.intent!.id);
        const result = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'result', evidence
        }));
        expect(result.kind).toBe('recorded');
        expect(['accepted_unbound', 'uncertain']).toContain(result.intent!.state);
        expect((await begin(f, r.intent!.id)).kind).toBe('not_prepared');
    });
    it('binds only full authenticated response keys to the reserved UUID leaving global IDs null', async () => {
        const f = await fixture();
        const r = await reserve(f), d = await begin(f, r.intent!.id);
        const result = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'result', evidence: {
                transport: 'http', status: 200, raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }, bodyState: 'json'
            }
        }));
        const b = await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }));
        expect(b.kind).toBe('bound');
        expect(b.messageId).toBe(r.intent!.messageId);
        expect(await db.message.findUniqueOrThrow({ where: { id: r.intent!.messageId } })).toMatchObject({
            body: 'hello', metadata: { local: true }, sentByUserId: f.user.id, providerMessageId: null, providerEventId: null, status: 'pending'
        });
    });
    it('does not bind a bare raw response ID', async () => {
        const f = await fixture();
        const r = await reserve(f), d = await begin(f, r.intent!.id);
        const result = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'result', evidence: { transport: 'http', status: 200, raw: { id: 'A' }, bodyState: 'json' }
        }));
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }))).kind).toBe('incomplete_proof');
    });
    const store = createCanonicalStore();
    const echo = (f: any, rawId = 'A', type: any = 'text', body = 'hello', source = f.source): any => ({
        kind: 'message', context: source, providerEventId: null, providerEventType: 'message', addressMappings: [], key: {
            ...parseWahaMessageKey({ id: rawId, remote: f.request.destination, fromMe: true }), nativeId: source.provider === 'waha' ? `true_${f.request.destination}_${rawId}` : rawId
        }, content: {
            type, body, mediaUrl: type === 'text' ? null : 'https://provider.invalid/temporary', preview: body
        }, attachment: {}, media: null, currentRevision: null, pushName: null, source: null, order: { timestampMs: 1700000000000, sequence: null }
    });
    it('holds an early echo durably before creating a second Message and reprocesses the same receipt after exact binding', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const early = await store.persist(db, echo(f), { receiptKey: 'early' });
        expect(early).toMatchObject({ outcome: 'held', messageId: null, allowOperationalEffects: false });
        expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1);
        const original = await db.canonicalObservation.findUniqueOrThrow({ where: { id: early.observationId } });
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'response', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            }
        }));
        await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }));
        const reprocessed = await tx(t => store.reprocessHeldMessageObservationInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, observationId: early.observationId
        }));
        expect(reprocessed).toMatchObject({
            outcome: 'duplicate', messageId: r.intent!.messageId, observationId: original.id, allowOperationalEffects: false
        });
        const after = await db.canonicalObservation.findUniqueOrThrow({ where: { id: original.id } });
        expect(after.payload).toEqual(original.payload);
        expect(after.receiptTuple).toEqual(original.receiptTuple);
        expect(after.receivedAt).toEqual(original.receivedAt);
        expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1);
    });
    it('prepared reservations alone do not hold operator sends', async () => { const f = await fixture(); await reserve(f); const observed = await store.persist(db, echo(f, 'OP'), { receiptKey: 'operator' }); expect(observed.outcome).toBe('created'); expect(observed.allowOperationalEffects).toBe(true); });
    it('unmatched operator facts become eligible once the ambiguity is conclusively bound, without repeated logical effects', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const op = await store.persist(db, echo(f, 'OP', 'text', 'operator'), { receiptKey: 'operator' });
        expect(op.outcome).toBe('held');
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'response', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            }
        }));
        await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }));
        const first = await tx(t => store.reprocessHeldMessageObservationInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, observationId: op.observationId
        }));
        expect(first).toMatchObject({ outcome: 'created', allowOperationalEffects: true, observationId: op.observationId });
        const again = await tx(t => store.reprocessHeldMessageObservationInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, observationId: op.observationId
        }));
        expect(again).toMatchObject({ outcome: 'duplicate', messageId: first.messageId, allowOperationalEffects: false });
    });
    it.each(['audio', 'image'] as const)('preserves local %s presentation through early/sibling/late mirrors', async (type) => {
        const f = await fixture();
        f.request.message = {
            type, body: 'local label', mediaUrl: 'https://own.invalid/artifact', metadata: {
                local: true, transcript: 'prepared transcript', mediaSourceHash: 'own-digest', attachment: { fileName: 'local' }
            }
        };
        const r = await reserve(f), d = await begin(f, r.intent!.id);
        const reserved = await db.message.findUniqueOrThrow({ where: { id: r.intent!.messageId } });
        const sibling = await db.channelConnection.create({
            data: {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, provider: 'waha', sessionName: randomUUID()
            }
        });
        const waha = { ...f.source, provider: 'waha', connectionId: sibling.id, sessionName: sibling.sessionName };
        const a = await store.persist(db, echo(f, 'A', type, 'provider placeholder'), { receiptKey: 'evo' });
        const b = await store.persist(db, echo(f, 'A', type, 'other placeholder', waha), { receiptKey: 'waha' });
        expect(a.outcome).toBe('held');
        expect(b.outcome).toBe('held');
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'response', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            }
        }));
        await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }));
        for (const observationId of [a.observationId, b.observationId]) {
            const replay = await tx(t => store.reprocessHeldMessageObservationInTransaction(t, { workspaceId: f.source.workspaceId, channelId: f.source.channelId, observationId }));
            expect(replay.messageId).toBe(reserved.id);
            expect(replay.allowOperationalEffects).toBe(false);
        }
        expect((await store.persist(db, echo(f, 'A', type, 'later label'), { receiptKey: 'late' })).messageId).toBe(reserved.id);
        expect(await db.message.findUniqueOrThrow({ where: { id: reserved.id } })).toEqual(reserved);
        expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1);
    });
    it.each([false, true])('contradictory accepted full keys force review even when one response already bound (bound=%s)', async (alreadyBound) => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const record = async (id: string, resultKey: string): Promise<any> => tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey, evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id, remoteJid: PN, fromMe: true } }
            }
        }));
        const a = await record('A', 'a');
        if (alreadyBound)
            expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: a.result!.id
            }))).kind).toBe('bound');
        const b = await record('B', 'b');
        expect(b.intent!.state).toBe('review');
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: a.result!.id
        }))).kind).toBe('review');
        expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1);
        expect(await db.outboundResult.count({ where: { workspaceId: f.source.workspaceId } })).toBe(2);
    });
    it('blocks autonomous lane while a held operator fact awaits explicit reprocessing', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const op = await store.persist(db, echo(f, 'OP'), { receiptKey: 'operator' });
        expect(op.outcome).toBe('held');
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'accepted', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            }
        }));
        await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }));
        const next = await reserve(f, { ...f.request, origin: { ...f.request.origin, requestKey: randomUUID() } });
        expect((await begin(f, next.intent!.id)).kind).toBe('held_observations');
    });
    it('does not permit mutation of immutable request, attempt source, raw result or binding evidence', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'accepted', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            }
        }));
        const b: any = await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }));
        await expect(db.outboundIntent.update({ where: { id: r.intent!.id }, data: { request: { changed: true } } })).rejects.toThrow();
        await expect(db.outboundAttempt.update({ where: { id: d.attempt!.id }, data: { source: { changed: true } } })).rejects.toThrow();
        await expect(db.outboundResult.update({ where: { id: result.result!.id }, data: { evidence: { changed: true } } })).rejects.toThrow();
        await expect(db.outboundBinding.update({ where: { id: b.bindingId }, data: { proof: { changed: true } } })).rejects.toThrow();
    });
    it('same-transaction reservations follow a durable sequence independent of timestamp or UUID', async () => {
        const f = await fixture();
        const values: any[] = await tx(async (t) => {
            const a = await api.reserveLocalOutboundInTransaction(t, f.source, f.request, async () => true);
            const b = await api.reserveLocalOutboundInTransaction(t, f.source, {
                ...f.request, origin: { ...f.request.origin, kind: 'attachment_part', parentKind: 'human', part: 1, actionOrdinal: 1 }
            }, async () => true);
            return [a, b];
        });
        expect(values[0].intent!.ordinal).toBeLessThan(values[1].intent!.ordinal);
        expect((await begin(f, values[1].intent!.id)).kind).toBe('lane_blocked');
    });
    it('persists explicit PN/LID response mappings and preserves the native key during binding', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'response', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: '700001@lid', remoteJidAlt: PN, fromMe: true } }
            }
        }));
        const b: any = await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }));
        expect(b.kind).toBe('bound');
        expect(await db.canonicalAddressEvidence.findMany({ where: { workspaceId: f.source.workspaceId } })).toEqual([
            expect.objectContaining({ lid: '700001@lid', pn: PN, role: 'chat', source: 'evolution.remoteJidAlt' })
        ]);
        const lid = await db.canonicalAddressAlias.findFirstOrThrow({ where: { workspaceId: f.source.workspaceId, address: '700001@lid' } }), pn = await db.canonicalAddressAlias.findFirstOrThrow({ where: { workspaceId: f.source.workspaceId, address: PN } });
        expect(lid.addressId).toBe(pn.addressId);
        const obs = await store.persist(db, {
            ...echo(f), key: { ...echo(f).key, chatAddress: '700001@lid', nativeChatAddress: '700001@lid' }, addressMappings: [{ role: 'chat', lid: '700001@lid', pn: PN, source: 'evolution.remoteJidAlt' }]
        }, { receiptKey: 'echo-lid' });
        expect(obs.messageId).toBe(r.intent!.messageId);
    });
    it('requires an explicit own group participant and never infers one from the verified phone number', async () => {
        const f = await fixture();
        const group = '120000-100@g.us';
        await db.contact.update({ where: { id: f.conversation.contactId }, data: { phone: group, isGroup: true } });
        f.request.destination = group;
        const r = await reserve(f), d = await begin(f, r.intent!.id);
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'response', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'G', remoteJid: group, fromMe: true }, verifiedPhoneNumber: '15550001111' }
            }
        }));
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id
        }))).kind).toBe('incomplete_proof');
        expect(await db.canonicalMessageIdentity.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0);
    });
    it('does not dispatch after the reserved message immutable content or actor changes', async () => { const f = await fixture(), r = await reserve(f); await db.message.update({ where: { id: r.intent!.messageId }, data: { body: 'changed' } }); expect((await begin(f, r.intent!.id)).kind).toBe('existing_message_conflict'); expect(await db.outboundAttempt.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0); });
    it('permission callbacks remain origin scoped on idempotent retries and forbidden origins leave no writes', async () => {
        const f = await fixture(), r = await reserve(f);
        let calls = 0;
        const retry: any = await tx(t => api.reserveLocalOutboundInTransaction(t, f.source, f.request, async (_t, origin) => { calls++; expect(origin.conversationId).toBe(f.conversation.id); return false; }));
        expect(retry.kind).toBe('forbidden_origin');
        expect(calls).toBe(1);
        const outside = {
            ...f.request, conversationId: randomUUID(), origin: { ...f.request.origin, requestKey: randomUUID() }
        };
        expect((await reserve(f, outside)).kind).toBe('forbidden_origin');
        expect(await db.outboundIntent.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1);
        expect(r.intent!.id).toBeDefined();
    });
    it('can bind a captured accepted native hint only through a persisted authenticated exact lookup, never a different key', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'response', evidence: { transport: 'http', status: 200, bodyState: 'json', raw: { id: 'A' } }
        }));
        const key = echo(f).key;
        const observation = await db.canonicalObservation.create({
            data: {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, channelProvider: 'evolution', provider: 'evolution', connectionProvider: 'evolution', connectionId: f.source.connectionId, receiptHash: '0'.repeat(64), receiptTuple: ['exact-lookup'], kind: 'provider_exact_lookup', eventType: 'exact_lookup', mode: 'live', source: 'authenticated_exact_lookup', sessionName: f.source.sessionName, lifecycleGeneration: 0, receivedAt: new Date(f.source.observedAt), sourceOrder: {}, payload: {
                    key, context: f.source, lookup: { nativeId: 'A', verifiedKey: key, response: { key: { id: 'A', remoteJid: PN, fromMe: true } } }
                }, state: 'certified'
            }
        });
        const input: any = {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id, lookupObservationId: observation.id
        };
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, input))).kind).toBe('bound');
        expect(await db.message.findUniqueOrThrow({ where: { id: r.intent!.messageId } })).toMatchObject({ providerMessageId: null, providerEventId: null });
    });
    it.each([false, true])('accepted native hints cannot hide a different incomplete key (bound=%s)', async (bound) => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const recordResult = (raw: unknown, resultKey: string): Promise<any> => tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey, evidence: { transport: 'http', status: 200, bodyState: 'json', raw }
        }));
        const a = await recordResult({ key: { id: 'A', remoteJid: PN, fromMe: true } }, 'a');
        if (bound)
            await tx(t => api.bindLocalOutboundInTransaction(t, {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: a.result!.id
            }));
        const b = await recordResult({ id: 'B', _data: { id: 'B' } }, 'b');
        expect(b.intent!.state).toBe('review');
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: a.result!.id
        }))).kind).toBe('review');
    });
    it.each(['contradictory_response', 'different_native', 'wrong_scope', 'wrong_connection', 'wrong_session'])('exact lookup does not bind invalid persisted proof: %s', async (failure) => {
        const f = await fixture(), group = '120000-100@g.us', id = `true_${group}_MSG_777@lid`;
        await db.contact.update({ where: { id: f.conversation.contactId }, data: { phone: group, isGroup: true } });
        await db.channelConnection.update({ where: { id: f.source.connectionId! }, data: { provider: 'waha' } });
        f.source = {
            ...f.source, provider: 'waha', channelProvider: 'evolution', connectionId: f.source.connectionId!
        };
        f.request.destination = group;
        const r = await reserve(f), d = await begin(f, r.intent!.id);
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'accepted', evidence: { transport: 'http', status: 200, bodyState: 'json', raw: { id, _data: { id: { id: 'MSG' } } } }
        }));
        const key = parseWahaMessageKey(id, '777@lid');
        const response: any = { id, fromMe: true, to: group, participant: '777@lid', _data: { id, participant: '777@lid' } };
        if (failure === 'contradictory_response')
            response._data.participant = '888@lid';
        const context = {
            ...f.source, ...(failure === 'wrong_scope' ? { workspaceId: 'outside' } : {}), ...(failure === 'wrong_connection' ? { connectionId: randomUUID() } : {}), ...(failure === 'wrong_session' ? { sessionName: 'outside' } : {})
        };
        const observation = await db.canonicalObservation.create({
            data: {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, channelProvider: 'evolution', provider: 'waha', connectionProvider: 'waha', connectionId: f.source.connectionId, receiptHash: '0'.repeat(64), receiptTuple: ['lookup'], kind: 'provider_exact_lookup', eventType: 'lookup', mode: 'live', source: 'authenticated_exact_lookup', sessionName: f.source.sessionName, lifecycleGeneration: 0, receivedAt: new Date(), sourceOrder: {}, payload: JSON.parse(JSON.stringify({
                    key, context, lookup: { nativeId: failure === 'different_native' ? 'other' : id, verifiedKey: key, response }
                })), state: 'certified'
            }
        });
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result!.id, lookupObservationId: observation.id
        }))).kind).toBe('incomplete_proof');
    });
    it('late operational eligibility also requires a current origin permission check', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id);
        const input = {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'accepted', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            } as SendEvidence
        };
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, input));
        expect(result.operationallyEligible).toBe(false);
        const authorized: any = await tx(t => api.recordDispatchResultInTransaction(t, { ...input, authorizeOrigin: async () => true }));
        expect(authorized.operationallyEligible).toBe(true);
        const denied: any = await tx(t => api.recordDispatchResultInTransaction(t, { ...input, authorizeOrigin: async () => false }));
        expect(denied.operationallyEligible).toBe(false);
        expect(await db.outboundResult.count({ where: { workspaceId: f.source.workspaceId } })).toBe(1);
    });
    it('a native identity collision preserves both UUIDs and requires review', async () => {
        const f = await fixture(), r = await reserve(f);
        const operator = await store.persist(db, echo(f), { receiptKey: 'operator-before-dispatch' });
        expect(operator.outcome).toBe('created');
        const d = await begin(f, r.intent!.id);
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'accepted', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            }
        }));
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result.id
        }))).kind).toBe('review');
        expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(2);
        expect(await db.message.findUnique({ where: { id: operator.messageId! } })).not.toBeNull();
        expect(await db.message.findUnique({ where: { id: r.intent!.messageId } })).not.toBeNull();
    });
    it('full request conflicts include actor, timestamps and prepared media descriptors', async () => {
        const f = await fixture();
        await reserve(f);
        for (const change of [
            { actor: { kind: 'agent', id: f.user.id } }, { message: { ...f.request.message, createdAt: '2026-09-30T12:00:00Z' } }, {
                preparedMedia: [
                    {
                        reference: 'own:artifact', digest: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 1, kind: 'image'
                    }
                ]
            }
        ]) {
            const result = await reserve(f, { ...f.request, ...change });
            expect(['request_conflict', 'forbidden_origin']).toContain(result.kind);
        }
    });
    it('hash buckets never substitute for full identity and identical-looking texts remain distinct', async () => {
        const f = await fixture(), collision = createOutboundIntents({ hash: () => '0'.repeat(64) });
        const reserveOne = (request: OutboundRequest) => tx(t => collision.reserveLocalOutboundInTransaction(t, f.source, request, async () => true));
        for (const id of ['A', 'B']) {
            const r: any = await reserveOne({ ...f.request, origin: { ...f.request.origin, requestKey: id } });
            const d: any = await tx(t => collision.beginDispatchInTransaction(t, f.source, { intentId: r.intent.id, authorizeOrigin: async () => true }));
            const result: any = await tx(t => collision.recordDispatchResultInTransaction(t, {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt.token, resultKey: id, evidence: {
                    transport: 'http', status: 200, bodyState: 'json', raw: { key: { id, remoteJid: PN, fromMe: true } }
                }
            }));
            expect((await tx(t => collision.bindLocalOutboundInTransaction(t, {
                workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt.token, resultId: result.result.id
            }))).kind).toBe('bound');
        }
        const identities = await db.canonicalMessageIdentity.findMany({ where: { workspaceId: f.source.workspaceId } });
        expect(identities).toHaveLength(2);
        expect(new Set(identities.map(i => i.messageId)).size).toBe(2);
        expect(identities.every(i => i.tupleHash === '0'.repeat(64))).toBe(true);
    });
    it('stale authority and source session cannot cross the I/O frontier', async () => {
        const f = await fixture(), r = await reserve(f);
        await db.canonicalChat.update({ where: { id: r.intent!.chatId }, data: { revision: { increment: 1 } } });
        expect((await begin(f, r.intent!.id)).kind).toBe('stale_authority');
        expect((await tx(t => api.recertifyPreparedOutboundInTransaction(t, f.source, { intentId: r.intent!.id, domainFences: [], authorizeOrigin: async () => true }))).kind).toBe('recertified');
        await db.channelConnection.update({ where: { id: f.source.connectionId! }, data: { sessionName: 'changed', lifecycleGeneration: 2 } });
        await expect(begin(f, r.intent!.id)).rejects.toThrow();
        expect(await db.outboundAttempt.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0);
    });
    it('root merges preserve reservation order and require explicit current authority recertification', async () => {
        const f = await fixture(), a = await reserve(f), lid = '700001@lid';
        await db.contact.update({ where: { id: f.conversation.contactId }, data: { phone: lid } });
        const b = await reserve(f, { ...f.request, destination: lid, origin: { ...f.request.origin, requestKey: 'second' } });
        expect(b.kind).toBe('reserved');
        expect(a.intent!.chatId).not.toBe(b.intent!.chatId);
        const event = echo(f, 'IN');
        event.key.direction = 'inbound';
        event.content.body = 'inbound';
        event.addressMappings = [{ role: 'chat', lid, pn: PN, source: 'evolution.remoteJidAlt' }];
        expect((await store.persist(db, event, { receiptKey: 'explicit-merge' })).outcome).toBe('created');
        const redirected = await db.canonicalChat.findFirstOrThrow({ where: { workspaceId: f.source.workspaceId, state: 'redirected' } });
        const displaced = [a, b].find(r => r.intent!.chatId === redirected.id)!;
        expect((await begin(f, displaced.intent!.id)).kind).toBe('stale_authority');
        for (const reservation of [a, b])
            expect((await tx(t => api.recertifyPreparedOutboundInTransaction(t, f.source, { intentId: reservation.intent!.id, domainFences: [], authorizeOrigin: async () => true }))).kind).toBe('recertified');
        expect((await begin(f, b.intent!.id)).kind).toBe('lane_blocked');
        expect((await begin(f, a.intent!.id)).kind).toBe('dispatch');
        expect((await begin(f, b.intent!.id)).kind).toBe('lane_blocked');
    });
    it('rejects invalid attachment occurrence and binary prepared descriptors before persistent reservation', async () => {
        const f = await fixture();
        await expect(reserve(f, {
            ...f.request, origin: { ...f.request.origin, kind: 'attachment_part', parentKind: 'human', part: -1 }
        })).rejects.toThrow('Invalid outbound request');
        await expect(reserve(f, {
            ...f.request, preparedMedia: [
                {
                    reference: 'own:artifact', digest: 'a'.repeat(64), mimeType: 'audio/ogg', sizeBytes: 2, kind: 'audio', binary: Buffer.from('xx')
                }
            ]
        })).rejects.toThrow('Invalid prepared media descriptor');
        expect(await db.message.count({ where: { workspaceId: f.source.workspaceId } })).toBe(0);
    });
    it('stale late binding conserves the UUID but active reads need explicit current-generation recertification', async () => {
        const f = await fixture(), r = await reserve(f), d = await begin(f, r.intent!.id), early = await store.persist(db, echo(f), { receiptKey: 'early-old-generation' });
        await db.channelConnection.update({ where: { id: f.source.connectionId! }, data: { lifecycleGeneration: 2 } });
        const result: any = await tx(t => api.recordDispatchResultInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultKey: 'late', evidence: {
                transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'A', remoteJid: PN, fromMe: true } }
            }
        }));
        expect((await tx(t => api.bindLocalOutboundInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, token: d.attempt!.token, resultId: result.result.id
        }))).kind).toBe('bound');
        const replay = await tx(t => store.reprocessHeldMessageObservationInTransaction(t, {
            workspaceId: f.source.workspaceId, channelId: f.source.channelId, observationId: early.observationId
        }));
        expect(replay).toMatchObject({ messageId: r.intent!.messageId, allowOperationalEffects: false });
        const current = { ...f.source, lifecycleGeneration: 2 };
        expect((await tx(t => store.lookupNativeInTransaction(t, current, echo(f).key))).kind).toBe('stale_source');
        expect((await store.persist(db, echo(f, 'A', 'text', 'hello', current), { receiptKey: 'current-certified-echo' })).messageId).toBe(r.intent!.messageId);
        expect((await tx(t => store.lookupNativeInTransaction(t, current, echo(f).key))).kind).toBe('resolved');
    });
    it('competing cancellation and dispatch serialize at the persisted I/O frontier', async () => {
        const f = await fixture(), r = await reserve(f);
        const [canceled, dispatch] = await Promise.all([
            tx(t => api.cancelPreparedInTransaction(t, { workspaceId: f.source.workspaceId, channelId: f.source.channelId, intentId: r.intent!.id }, async () => true)), begin(f, r.intent!.id)
        ]);
        const count = await db.outboundAttempt.count({ where: { workspaceId: f.source.workspaceId } });
        if (canceled.kind === 'canceled') {
            expect(dispatch.kind).toBe('not_prepared');
            expect(count).toBe(0);
        }
        else {
            expect(canceled.kind).toBe('not_prepared');
            expect(dispatch.kind).toBe('dispatch');
            expect(count).toBe(1);
        }
    });
});
