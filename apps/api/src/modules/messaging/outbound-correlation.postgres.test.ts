import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanonicalStore } from './canonical-store.js';
import { correlateProviderKeysInTransaction } from './outbound-correlation.js';
import { sha, stable } from './canonical-values.js';
import { parseSendIdentity } from './outbound-evidence.js';
const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('explicit official Meta / Evolution bridge correlation', () => {
    let db: PrismaClient;
    const ws: string[] = [];
    const store = createCanonicalStore();
    const tx = <T>(f: (t: any) => Promise<T>) => db.$transaction(f, { isolationLevel: 'ReadCommitted' });
    beforeAll(() => {
        const u = new URL(url!);
        if (u.hostname !== '127.0.0.1' || u.pathname !== '/messaging_test')
            throw Error('fixture DB');
        db = new PrismaClient({ datasources: { db: { url } } });
    });
    afterAll(async () => {
        for (const workspaceId of ws) {
            await db.outboundCorrelation.deleteMany({ where: { workspaceId } });
            await db.channel.deleteMany({ where: { workspaceId } });
            await db.contact.deleteMany({ where: { workspaceId } });
            await db.integrationConfig.deleteMany({ where: { workspaceId } });
        }
        await db.$disconnect();
    });
    async function fixture(conflict = false) {
        const workspaceId = `outbound-3b-correlation-${randomUUID()}`;
        ws.push(workspaceId);
        const channel = await db.channel.create({ data: { workspaceId, provider: 'meta_cloud', providerKey: 'AUTH' } });
        const settings = {
            enabled: true, connectionMode: 'evolution_official', evolutionBaseUrl: 'https://fixture.invalid', evolutionApiKey: 'fixture-only', evolutionInstanceName: 'bridge'
        };
        await db.integrationConfig.create({ data: { workspaceId, provider: 'meta_cloud', mode: 'real', status: 'configured', settings } });
        const bridge: any = {
            workspaceId, channelId: channel.id, provider: 'evolution', channelProvider: 'meta', connectionId: null, sessionName: 'bridge', lifecycleGeneration: 0, mode: 'live', observedAt: '2026-10-01T00:00:00Z'
        };
        const PN = '15550001111@s.whatsapp.net';
        const key: any = {
            identityFormat: 'whatsapp_stanza', nativeId: 'STANZA', rawId: 'STANZA', nativeChatAddress: PN, nativeSenderParticipant: null, chatAddress: PN, senderParticipant: '', direction: 'outbound'
        };
        const event: any = {
            kind: 'message', context: bridge, providerEventId: null, providerEventType: 'message', addressMappings: [], key, content: { type: 'text', body: 'hello', mediaUrl: null, preview: 'hello' }, attachment: {}, media: null, currentRevision: null, pushName: null, source: null, order: { timestampMs: null, sequence: null }
        };
        const target = await store.persist(db, event, { receiptKey: 'bridge' });
        await db.integrationConfig.update({
            where: { workspaceId_provider: { workspaceId, provider: 'meta_cloud' } }, data: {
                settings: {
                    enabled: true, connectionMode: 'direct', phoneNumberId: 'AUTH', wabaId: 'WABA', accessToken: 'fixture-only'
                }
            }
        });
        const official: any = { ...bridge, provider: 'meta_official', phoneNumberId: 'AUTH', sessionName: 'AUTH' };
        const officialKey = parseSendIdentity(official, PN, { messages: [{ id: 'wamid.official' }] })!;
        let fromId: string;
        if (conflict) {
            fromId = (await store.persist(db, { ...event, context: official, key: officialKey }, { receiptKey: 'official' })).observationId;
        }
        else {
            fromId = (await db.canonicalObservation.create({
                data: {
                    workspaceId, channelId: channel.id, channelProvider: 'meta_cloud', provider: 'meta_official', connectionId: null, receiptHash: sha('official'), receiptTuple: ['official'], kind: 'message', eventType: 'message', mode: 'live', sessionName: 'AUTH', lifecycleGeneration: 0, receivedAt: new Date(official.observedAt), sourceOrder: {}, payload: { ...event, context: official, key: officialKey }, state: 'held', reason: 'explicit_correlation_required'
                }
            })).id;
        }
        const certificate = {
            workspaceId, channelId: channel.id, messageId: target.messageId!, conversationId: target.conversationId!, from: { source: official, key: officialKey, observationId: fromId }, to: { source: bridge, key, observationId: target.observationId }
        };
        const payload = { certificate };
        const proof = await db.canonicalObservation.create({
            data: {
                workspaceId, channelId: channel.id, channelProvider: 'meta_cloud', provider: 'meta_official', connectionId: null, receiptHash: sha('certificate'), receiptTuple: ['certificate'], kind: 'provider_key_correlation', eventType: 'certified_mapping', mode: 'live', source: 'authenticated_provider_mapping', sessionName: 'AUTH', lifecycleGeneration: 0, receivedAt: new Date(official.observedAt), sourceOrder: {}, payload: JSON.parse(JSON.stringify(payload)), state: 'certified', resolutionEvidence: { digest: sha(stable(payload)) }
            }
        });
        const input: any = {
            workspaceId, channelId: channel.id, proofObservationId: proof.id, messageId: target.messageId, conversationId: target.conversationId, authorizeOrigin: async () => true, verifyProof: async (t: any, o: any) => {
                const actual = await t.canonicalObservation.findUniqueOrThrow({ where: { id: o.id } });
                const authority = await t.canonicalChat.findUniqueOrThrow({ where: { id: target.chatId } });
                return {
                    certificate: (actual.payload as any).certificate, digest: sha(stable(actual.payload)), authority: {
                        chatId: authority.id, conversationId: authority.operationConversationId, revision: authority.revision
                    }, proofReference: actual.id
                };
            }
        };
        return { workspaceId, official, bridge, officialKey, target, proof, input };
    }
    it('keeps namespaces distinct without a verified persisted proof', async () => { const f = await fixture(); expect((await tx(t => correlateProviderKeysInTransaction(t, { ...f.input, verifyProof: async () => null }))).kind).toBe('unverified'); expect(await db.outboundCorrelation.count({ where: { workspaceId: f.workspaceId } })).toBe(0); });
    it('persists exact certified proof before aliasing the official key to the target UUID', async () => {
        const f = await fixture();
        const r = await tx(t => correlateProviderKeysInTransaction(t, f.input));
        expect(r.kind).toBe('correlated');
        expect(r.messageId).toBe(f.target.messageId);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        const read = await tx(t => store.lookupNativeInTransaction(t, f.official, f.officialKey));
        expect(read).toMatchObject({ kind: 'resolved', originMessageId: f.target.messageId });
        expect((await store.persist(db, {
            ...(await db.canonicalObservation.findUniqueOrThrow({ where: { id: (f.proof.payload as any).certificate.from.observationId } })).payload as any, context: f.official
        }, { receiptKey: 'mirror' })).messageId).toBe(f.target.messageId);
    });
    it('rejects another workspace or a forged source connection in the verified certificate', async () => {
        const f = await fixture();
        expect((await tx(t => correlateProviderKeysInTransaction(t, { ...f.input, workspaceId: 'other' }))).kind).toBe('unverified');
        const bad = await tx(t => correlateProviderKeysInTransaction(t, {
            ...f.input, verifyProof: async (t: any, o: any) => {
                const p = await f.input.verifyProof(t, o);
                return {
                    ...p, certificate: {
                        ...p.certificate, from: { ...p.certificate.from, source: { ...p.certificate.from.source, connectionId: randomUUID() } }
                    }
                };
            }
        }));
        expect(bad.kind).toBe('unverified');
    });
    it('preserves both UUIDs and marks explicit conflicting correlation review', async () => { const f = await fixture(true); const messages = await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: 'asc' } }); const r = await tx(t => correlateProviderKeysInTransaction(t, f.input)); expect(r.kind).toBe('review'); expect(await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { id: 'asc' } })).toEqual(messages); expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(2); expect(await db.outboundCorrelation.findMany({ where: { workspaceId: f.workspaceId } })).toEqual([expect.objectContaining({ state: 'review' })]); });
});
