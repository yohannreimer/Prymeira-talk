import { randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import amqp, { type ChannelModel } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanonicalStore } from '../messaging/canonical-store.js';
import { normalizeReceipt } from './normalization.js';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { captureOutboundDomainFenceInTransaction } from '../messaging/outbound-fences.js';
import { createOutboundIntents } from '../messaging/outbound-intents.js';
import { IngressApplicationService } from './application.js';
import { IngressJournal } from './journal.js';
import { IngressPrivateStore } from './private-store.js';
import { ConfirmedIngressPublisher, transportTopology } from './broker.js';
import { createIngressHttp } from './http.js';
import { readIngressEnvironment } from './runtime.js';
import { IngressTransportConsumer } from './consumer.js';
import { createEffectRunner } from './effect-runner.js';
import { createMediaPrepareHandler } from './media-prepare-handler.js';
import { createEffectHandlers } from './effect-handlers.js';
import { buildApp } from '../../test/build-app.js';
import { createMessageMediaService } from '../conversations/message-media.js';
import { join } from 'node:path';
import http from 'node:http';
const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL, brokerUrl = process.env.INGRESS_TEST_AMQP_URL;
const peer = '15550001111@s.whatsapp.net', secret = 'application-fixture-only';
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
    const end = Date.now() + 15000;
    while (true) {
        const value = await read();
        if (predicate(value))
            return value;
        if (Date.now() > end)
            throw new Error('durable state timeout');
        await new Promise(r => setTimeout(r, 20));
    }
}
describe.skipIf(!databaseUrl || !brokerUrl)('stage 1B canonical application with real PostgreSQL/Rabbit', () => {
    let db: PrismaClient, journal: IngressJournal, service: IngressApplicationService, root: string, admin: ChannelModel;
    const workspaces: string[] = [], namespaces: string[] = [], publishers: ConfirmedIngressPublisher[] = [], consumers: IngressTransportConsumer[] = [], children: ChildProcess[] = [];
    const apps: ReturnType<typeof createIngressHttp>[] = [];
    beforeAll(async () => {
        readIngressEnvironment({ INGRESS_TRANSPORT_STAGE: 'isolated-1b', DATABASE_URL: databaseUrl, INGRESS_AMQP_URL: brokerUrl, INGRESS_NAMESPACE: 'talk.isolated.application_test', INGRESS_WORKSPACE_ALLOWLIST: 'fixture', INGRESS_PRIVATE_ROOT: '/private/tmp/unused' });
        db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
        root = await mkdtemp('/private/tmp/talk-application-');
        const files = new IngressPrivateStore(root);
        await files.initialize();
        journal = new IngressJournal(db, files);
        service = new IngressApplicationService(journal);
        admin = await amqp.connect(brokerUrl!);
    });
    afterAll(async () => {
        for (const child of children) {
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                await until(async () => child.exitCode, v => v !== null);
            }
        }
        for (const consumer of consumers)
            await consumer.close();
        for (const app of apps)
            await app.close();
        for (const publisher of publishers)
            await publisher.close();
        const ch = await admin.createChannel();
        for (const namespace of namespaces) {
            const t = transportTopology(namespace);
            for (const q of [t.incoming, t.retry, t.dead])
                await ch.deleteQueue(q);
            await ch.deleteExchange(namespace);
        }
        await ch.close();
        await admin.close();
        await db.ingressReceipt.deleteMany({ where: { workspaceId: { in: workspaces } } });
        // Own fixtures only; dependency-safe deletes preserve other suites/resources.
        await db.outboundIntent.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.contact.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.integrationConfig.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.campaign.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.aiAgent.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.department.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.userProfile.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.automationRule.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.$disconnect();
        await rm(root, { recursive: true, force: true });
    }, 30000);
    async function fixture(pairing = true) {
        const workspaceId = randomUUID(), namespace = `talk.isolated.${randomUUID()}`;
        workspaces.push(workspaceId);
        namespaces.push(namespace);
        const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
        const evo = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, ...(pairing ? { verifiedPhoneNumber: '15550008888' } : {}) } });
        const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: randomUUID(), ...(pairing ? { verifiedPhoneNumber: '15550008888', lastHealthyAt: new Date('2026-10-01T00:00:00Z') } : {}) } });
        const publisher = await ConfirmedIngressPublisher.connect(brokerUrl!, namespace);
        publishers.push(publisher);
        const app = createIngressHttp({ db, journal, publisher: () => publisher, evolutionSecret: secret, wahaSecret: secret, workspaceAllowlist: new Set([workspaceId]) });
        apps.push(app);
        async function send(provider: 'evolution' | 'waha' = 'evolution', data: Record<string, unknown> = {}, eventName?: string) {
            const input = provider === 'evolution' ? { event: eventName ?? 'MESSAGES_UPSERT', instance: evo.sessionName, data: { key: { id: 'same-stanza', remoteJid: peer, fromMe: false }, message: { conversation: 'hello' }, messageTimestamp: 1700000000, ...data } }
                : { id: randomUUID(), event: eventName ?? 'message.any', session: waha.sessionName, payload: { id: `false_${peer}_same-stanza`, from: peer, fromMe: false, body: 'hello', timestamp: 1700000000, ...data } };
            const headers = provider === 'evolution' ? { 'x-prymeira-talk-secret': secret } : { 'x-webhook-hmac': createHmac('sha512', secret).update(JSON.stringify(input)).digest('hex'), 'x-webhook-hmac-algorithm': 'sha512' };
            const result = await app.inject({ method: 'POST', url: `/webhooks/${provider}/${workspaceId}`, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(input) });
            expect(result.statusCode).toBe(202);
            return result.json().receiptId as string;
        }
        return { workspaceId, namespace, channel, evo, waha, publisher, app, send };
    }
    async function stage(f: Awaited<ReturnType<typeof fixture>>, input: unknown, mode: 'live' | 'history' | 'recovered_live' = 'live') {
        const source = await db.$transaction(async (tx) => { await enterCanonicalWorkspaceTransaction(tx, f.workspaceId); return deriveTrustedMessagingContext(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, authenticatedSource: { provider: 'evolution', connectionId: f.evo.id }, mode, observedAt: '2026-10-01T00:00:00Z' }); });
        return journal.stage({ transportNamespace: f.namespace, source, raw: Buffer.from(JSON.stringify(input)), payload: normalizeReceipt(source, input), authentication: 'evolution_constant_time_secret', reauthenticate: async () => { } });
    }
    async function failInsert(table: string, workspaceId: string, run: () => Promise<void>, position?: number) {
        if (!['ingress_effects', 'messages', 'ingress_event_progress', 'contacts', 'assistant_conversation_states'].includes(table))
            throw Error('fixture table');
        const name = 'stage1b_fault_' + randomUUID().replaceAll('-', '');
        // A real PostgreSQL failure, scoped to this fixture. It exercises transaction rollback.
        await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${workspaceId}' ${position === undefined ? '' : `AND NEW.event_index = ${position}`} THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$`);
        await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE ${table === 'contacts' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        try {
            await run();
        }
        finally {
            await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON ${table}`);
            await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
        }
    }
    it.each(['evo-outer', 'evo-alt', 'evo-data-alt', 'waha-author', 'waha-participant', 'waha-key', 'waha-native', 'waha-chat', 'waha-direction', 'waha-stanza', 'waha-ack', 'waha-edit', 'waha-revoke'] as const)('conserves contradictory authenticated declarations without identity/hooks: %s', async (variant) => {
        const f = await fixture(), group = '123-456@g.us', a = '15550003333@s.whatsapp.net', b = '15550004444@s.whatsapp.net';
        const provider = variant.startsWith('evo') ? 'evolution' : 'waha';
        const signal = variant === 'waha-ack' ? 'message.ack.group' : variant === 'waha-edit' ? 'message.edited' : variant === 'waha-revoke' ? 'message.revoked' : undefined;
        const data = provider === 'evolution' ? { key: { id: 'contradiction', remoteJid: group, fromMe: false, participant: a, ...(variant === 'evo-alt' ? { participantAlt: b } : {}) }, ...(variant === 'evo-outer' ? { participant: b } : variant === 'evo-data-alt' ? { participantAlt: b } : {}), message: { conversation: 'held' } }
            : { id: `false_${group}_contradiction_${a}`, from: group, participant: a, ack: 3, body: 'held', _data: { author: variant === 'waha-author' || signal ? b : a, ...(variant === 'waha-participant' ? { participant: b } : {}), ...(variant === 'waha-key' || variant === 'waha-native' || variant === 'waha-chat' || variant === 'waha-stanza' ? { id: { id: variant === 'waha-stanza' ? 'OTHER' : 'contradiction', remote: variant === 'waha-chat' ? '888-999@g.us' : group, fromMe: false, participant: variant === 'waha-key' ? b : a, ...(variant === 'waha-native' ? { _serialized: `false_${group}_contradiction_${b}` } : {}) } } : {}), ...(variant === 'waha-direction' ? { fromMe: true } : {}), ...(signal === 'message.revoked' ? { refId: 'original' } : signal === 'message.edited' ? { msg: { body: 'edit' } } : {}) } };
        const id = await f.send(provider, data, signal);
        await service.apply(id);
        await service.apply(id);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: id } })).toMatchObject({ state: 'held', reason: expect.stringMatching(/^contradictory_/), messageId: null, observationId: null, actionId: null });
        expect(await db.ingressApplication.findUnique({ where: { receiptId: id } })).toMatchObject({ state: 'held', appliedAt: null });
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        expect(await db.contact.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    });
    it.each(['evo-status', 'evo-edit', 'evo-delete', 'waha-status', 'waha-edit', 'waha-delete'] as const)('contradictory signal cannot alter an existing canonical message: %s', async (variant) => {
        const f = await fixture(), group = '123-456@g.us', a = '15550003333@s.whatsapp.net', b = '15550004444@s.whatsapp.net';
        await service.apply(await f.send('evolution', { key: { id: 'original', remoteJid: group, fromMe: false, participant: a }, message: { conversation: 'original' } }));
        const original = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } }), effects = await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } });
        const key = { id: 'original', remoteJid: group, fromMe: false, participant: a }, native = `false_${group}_original_${a}`;
        const provider = variant.startsWith('evo') ? 'evolution' : 'waha';
        const name = variant === 'evo-status' ? 'MESSAGES_UPDATE' : variant === 'evo-delete' ? 'MESSAGES_DELETE' : variant === 'evo-edit' ? 'MESSAGES_EDITED' : variant === 'waha-status' ? 'message.ack.group' : variant === 'waha-delete' ? 'message.revoked' : 'message.edited';
        const data = provider === 'evolution' ? { key, participant: b, status: 'READ', message: { conversation: 'corrupted' } } : { id: native, from: group, participant: a, ack: 3, body: 'corrupted', _data: { id: native, author: b, refId: native, msg: { body: 'corrupted' } } };
        const id = await f.send(provider, data, name);
        await service.apply(id);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: id } })).toMatchObject({ state: 'held', reason: 'contradictory_sender_declarations', messageId: null, actionId: null });
        expect(await db.message.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1, lastMessagePreview: 'original' });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(effects);
    });
    it('valid explicit PN/LID sender proof retains one family and stable UUID across providers', async () => {
        const f = await fixture(), group = '123-456@g.us', pn = '15550003333@s.whatsapp.net', lid = '777@lid';
        const evo = await f.send('evolution', { key: { id: 'proven', remoteJid: group, fromMe: false, participant: pn, participantAlt: lid }, participant: lid, pushName: 'Synthetic participant' });
        await service.apply(evo);
        const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        const waha = await f.send('waha', { id: `false_${group}_proven_${lid}`, from: group, participant: lid, _data: { author: lid } });
        await service.apply(waha);
        await service.apply(evo);
        expect(await db.message.findMany({ where: { workspaceId: f.workspaceId } })).toHaveLength(1);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: waha } })).toMatchObject({ state: 'applied', messageId: message.id });
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1 });
    });
    it.each(['evolution', 'waha'] as const)('holds an authenticated old normalized receipt from conserved raw before ACK: %s', async (provider) => {
        const f = await fixture(), group = '123-456@g.us', a = '15550003333@s.whatsapp.net', b = '15550004444@s.whatsapp.net';
        const clean = provider === 'evolution' ? { key: { id: 'old-adapter', remoteJid: group, fromMe: false, participant: a }, message: { conversation: 'held' } } : { id: `false_${group}_old-adapter_${a}`, from: group, participant: a, _data: { author: a } };
        const seedId = await f.send(provider, clean), { receipt: seed, payload: oldPayload } = await journal.readPayload(seedId);
        expect(oldPayload.events[0]?.kind).toBe('accepted');
        const raw = provider === 'evolution' ? { event: 'MESSAGES_UPSERT', instance: f.evo.sessionName, data: { ...clean, participant: b } } : { event: 'message.any', session: f.waha.sessionName, payload: { ...clean, _data: { author: b } } };
        const receipt = await journal.stage({ transportNamespace: f.namespace, source: seed.source as unknown as TrustedMessagingContext, raw: Buffer.from(JSON.stringify(raw)), payload: oldPayload, authentication: provider === 'evolution' ? 'evolution_constant_time_secret' : 'waha_hmac_sha512', reauthenticate: async () => { } });
        const before = await db.ingressReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
        // Remove the unconsumed clean seed, so no synthetic original can mask the assertion.
        const ch = await admin.createChannel();
        await ch.purgeQueue(transportTopology(f.namespace).incoming);
        await db.ingressReceipt.delete({ where: { id: seedId } });
        await journal.publish(receipt.id, f.publisher);
        const consumer = await IngressTransportConsumer.start({ url: brokerUrl!, namespace: f.namespace, journal, publisher: () => f.publisher, application: service });
        consumers.push(consumer);
        await until(() => db.ingressApplication.findUnique({ where: { receiptId: receipt.id } }), v => v?.state === 'held');
        await until(() => ch.checkQueue(transportTopology(f.namespace).incoming), v => v.messageCount === 0);
        await consumer.close();
        await ch.close();
        await service.apply(receipt.id);
        expect(await db.ingressReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(before);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: receipt.id } })).toMatchObject({ state: 'held', reason: 'contradictory_sender_declarations', messageId: null });
        expect(await db.ingressDelivery.findUnique({ where: { receiptId: receipt.id } })).toMatchObject({ failures: 0, lastError: 'application_held', consumedAt: expect.any(Date) });
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    });
    it.each(['msg', 'message', 'tuple', 'both'] as const)('nested WPP %s participantAlt is held without mutating an existing Message', async (shape) => {
        const f = await fixture(), group = '123-456@g.us', pn = '15550003333@s.whatsapp.net', other = '15550004444@s.whatsapp.net';
        await service.apply(await f.send('evolution', { key: { id: 'original', remoteJid: group, fromMe: false, participant: pn }, message: { conversation: 'original' } }));
        const original = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } }), effects = await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } });
        const target = { id: 'original', remote: group, fromMe: false, participant: pn };
        const clean = { body: 'mutated', author: pn, latestEditMsgKey: { id: 'EDIT', remote: group, fromMe: false, participant: pn } }, bad = { ...clean, participantAlt: other };
        const model = shape === 'tuple' ? [group, target, bad] : shape === 'both' ? { id: target, author: pn, msg: clean, message: bad } : { id: target, author: pn, [shape]: bad };
        const id = await f.send('waha', { id: `false_${group}_EDIT_${pn}`, from: group, participant: pn, _data: model }, 'message.edited');
        await service.apply(id);
        await service.apply(id);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: id } })).toMatchObject({ state: 'held', reason: 'contradictory_sender_declarations', messageId: null, actionId: null, observationId: null });
        expect(await db.message.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(effects);
        expect(await db.ingressEffect.count({ where: { receiptId: id } })).toBe(0);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1, lastMessagePreview: 'original' });
    });
    it.each(['legacy-alt', 'verified-pn-lid', 'second-pn'] as const)('raw-guarded nested edit receipt preserves facts and completes ACK: %s', async (variant) => {
        const f = await fixture(), group = '123-456@g.us', pn = '15550003333@s.whatsapp.net', other = '15550004444@s.whatsapp.net', lid = '777@lid';
        await service.apply(await f.send('evolution', { key: { id: 'original', remoteJid: group, fromMe: false, participant: pn }, message: { conversation: 'original' } }));
        const original = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } }), effects = await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } });
        const seed = await f.send('waha'), { receipt: seedReceipt } = await journal.readPayload(seed);
        const source = seedReceipt.source as unknown as TrustedMessagingContext;
        const clean = { id: randomUUID(), event: 'message.edited', session: f.waha.sessionName, payload: { id: `false_${group}_EDIT_${pn}`, participant: pn, _data: { id: { id: 'original', remote: group, fromMe: false, participant: pn }, author: pn, msg: { body: 'verified edit', author: pn, ...(variant === 'legacy-alt' ? {} : { participantAlt: lid }), latestEditMsgKey: { id: 'EDIT', remote: group, fromMe: false, participant: pn } } } } };
        const event = normalizeWahaEvent(source, clean, { verifiedLidMappings: variant === 'legacy-alt' ? [] : [{ lid, pn }] });
        expect(event.kind).toBe('accepted');
        if (event.kind !== 'accepted')
            throw Error('fixture');
        expect(event.event.addressMappings).toEqual(variant === 'legacy-alt' ? [] : [{ role: 'sender', lid, pn, source: 'waha.lid_lookup' }]);
        const raw = structuredClone(clean);
        if (variant !== 'verified-pn-lid')
            Object.assign(raw.payload._data.msg, { participantAlt: other });
        const receipt = await journal.stage({ transportNamespace: f.namespace, source, raw: Buffer.from(JSON.stringify(raw)), payload: { version: 1, events: [event] }, authentication: 'waha_hmac_sha512', reauthenticate: async () => { } });
        const before = await db.ingressReceipt.findUniqueOrThrow({ where: { id: receipt.id } }), conserved = await journal.readPayload(receipt.id);
        const ch = await admin.createChannel();
        await ch.purgeQueue(transportTopology(f.namespace).incoming);
        await db.ingressReceipt.delete({ where: { id: seed } });
        await journal.publish(receipt.id, f.publisher);
        const consumer = await IngressTransportConsumer.start({ url: brokerUrl!, namespace: f.namespace, journal, publisher: () => f.publisher, application: service });
        consumers.push(consumer);
        const applied = variant === 'verified-pn-lid';
        await until(() => db.ingressApplication.findUnique({ where: { receiptId: receipt.id } }), v => v?.state === (applied ? 'applied' : 'held'));
        await consumer.close();
        for (const queue of [transportTopology(f.namespace).incoming, transportTopology(f.namespace).retry, transportTopology(f.namespace).dead])
            expect((await ch.checkQueue(queue)).messageCount).toBe(0);
        await ch.close();
        await service.apply(receipt.id);
        expect(await db.ingressReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(before);
        expect((await journal.readPayload(receipt.id)).payload).toEqual(conserved.payload);
        expect(await db.ingressDelivery.findUnique({ where: { receiptId: receipt.id } })).toMatchObject({ failures: 0, consumedAt: expect.any(Date) });
        if (applied) {
            expect(await db.message.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ body: 'verified edit' });
            expect(await db.ingressEventProgress.findFirst({ where: { receiptId: receipt.id } })).toMatchObject({ state: 'applied', messageId: original.id, actionId: expect.any(String) });
            expect(await db.ingressEffect.count({ where: { receiptId: receipt.id } })).toBe(3);
        }
        else {
            expect(await db.ingressEventProgress.findFirst({ where: { receiptId: receipt.id } })).toMatchObject({ state: 'held', reason: 'contradictory_sender_declarations', messageId: null, actionId: null });
            expect(await db.message.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
            expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(effects);
        }
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1 });
    });
    it('nested Evolution target PN/LID proof allows a legitimate revoke by a different action author', async () => {
        const f = await fixture(), group = '123-456@g.us', pn = '15550003333@s.whatsapp.net', actor = '15550004444@s.whatsapp.net', lid = '777@lid';
        await service.apply(await f.send('evolution', { key: { id: 'original', remoteJid: group, fromMe: false, participant: pn }, message: { conversation: 'original' } }));
        const original = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        const id = await f.send('evolution', { key: { id: 'REVOKE', remoteJid: group, fromMe: false, participant: actor }, message: { protocolMessage: { type: 0, key: { id: 'original', remoteJid: group, fromMe: false, participant: lid, participantAlt: pn } } } });
        await service.apply(id);
        await service.apply(id);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: id } })).toMatchObject({ state: 'applied', messageId: original.id, actionId: expect.any(String) });
        expect(await db.message.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ metadata: { deletedAt: expect.any(String) } });
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1 });
        expect(await db.ingressEffect.count({ where: { receiptId: id, kind: 'human.reply_improvement' } })).toBe(0);
    });
    it.each(['edit', 'revoke'].flatMap(kind => ['older', 'latest'].flatMap(target => [false, true].map(reversed => ({ kind, target, reversed })))))(`preview UUID ownership survives $kind of $target with reversed arrival $reversed`, async ({ kind, target, reversed }) => {
        const f = await fixture(), a = { id: 'preview-a', remoteJid: peer, fromMe: false }, b = { ...a, id: 'preview-b' };
        const receiptA = await f.send('evolution', { key: a, message: { conversation: 'A' }, messageTimestamp: 1700000000 }), receiptB = await f.send('evolution', { key: b, message: { conversation: 'B' }, messageTimestamp: 1700000000 });
        for (const id of reversed ? [receiptB, receiptA] : [receiptA, receiptB])
            await service.apply(id);
        const selected = reversed ? a : b, old = reversed ? b : a;
        const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        const owner = await db.conversationPreviewOwner.findUniqueOrThrow({ where: { conversationId: conversation.id } });
        const selectedIdentity = await db.canonicalMessageIdentity.findFirstOrThrow({ where: { workspaceId: f.workspaceId, rawId: selected.id } });
        expect(owner.messageId).toBe(selectedIdentity.messageId);
        expect(conversation.lastMessagePreview).toBe(reversed ? 'A' : 'B');
        const key = target === 'latest' ? selected : old;
        const action = await stage(f, { event: 'MESSAGES_UPSERT', instance: f.evo.sessionName, data: { key: { ...key, id: 'preview-action' }, message: { protocolMessage: { key, type: kind === 'edit' ? 14 : 'REVOKE', ...(kind === 'edit' ? { editedMessage: { conversation: 'edited' } } : {}) } } } });
        await journal.publish(action.id, f.publisher);
        const consumer = await IngressTransportConsumer.start({ url: brokerUrl!, namespace: f.namespace, journal, publisher: () => f.publisher, application: service, prefetch: 1 });
        consumers.push(consumer);
        await until(() => db.ingressApplication.findUnique({ where: { receiptId: action.id } }), v => v?.state === 'applied');
        await consumer.close();
        const ch = await admin.createChannel();
        expect((await ch.checkQueue(transportTopology(f.namespace).incoming)).messageCount).toBe(0);
        await ch.close();
        await service.apply(action.id);
        // An old provider mirror and delayed event cannot reclaim an equal/newer preview.
        await service.apply(await f.send('waha', { id: `false_${peer}_${old.id}`, body: reversed ? 'B' : 'A' }));
        await service.apply(await f.send('evolution', { key: { ...a, id: 'preview-delayed' }, message: { conversation: 'delayed' }, messageTimestamp: 1699999999 }));
        const current = await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
        expect(current).toMatchObject({ lastMessagePreview: target === 'latest' ? (kind === 'edit' ? 'edited' : 'Esta mensagem foi apagada') : (reversed ? 'A' : 'B'), lastMessagePreviewAt: conversation.lastMessagePreviewAt, lastMessageAt: conversation.lastMessageAt, hiddenUntilReply: false, unreadCount: 3 });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: conversation.id } })).toEqual(owner);
        expect(await db.ingressEffect.count({ where: { receiptId: action.id, kind: 'content.reconcile' } })).toBe(1);
    });
    it('legacy preview without exact UUID proof stays conservative despite equal timestamp and body', async () => {
        const f = await fixture(), key = { id: 'legacy-preview', remoteJid: peer, fromMe: false };
        await service.apply(await f.send('evolution', { key, message: { conversation: 'same' } }));
        const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        await db.conversation.update({ where: { id: conversation.id }, data: { lastMessagePreview: 'same' } });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: conversation.id } })).toBeNull();
        const action = await stage(f, { event: 'MESSAGES_UPSERT', instance: f.evo.sessionName, data: { key: { ...key, id: 'legacy-edit' }, message: { protocolMessage: { key, type: 14, editedMessage: { conversation: 'edited' } } } } });
        await service.apply(action.id);
        await service.apply(await f.send('evolution', { key: { ...key, id: 'same-time-new' }, message: { conversation: 'new tied' } }));
        expect(await db.conversation.findUnique({ where: { id: conversation.id } })).toMatchObject({ lastMessagePreview: 'same', lastMessagePreviewAt: conversation.lastMessagePreviewAt, unreadCount: 2 });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: conversation.id } })).toBeNull();
    });
    it('a newer live Message replaces legacy preview without preview clock using activity before it advances', async () => {
        const f = await fixture(), key = { id: 'legacy-clock', remoteJid: peer, fromMe: false };
        await service.apply(await f.send('evolution', { key, message: { conversation: 'prior' }, messageTimestamp: 1699999999 }));
        const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        await db.conversation.update({ where: { id: conversation.id }, data: { lastMessagePreview: 'legacy', lastMessagePreviewAt: null } });
        await service.apply(await f.send('evolution', { key: { ...key, id: 'newer-clock' }, message: { conversation: 'newer' }, messageTimestamp: 1700000000 }));
        const latest = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId, body: 'newer' } });
        expect(await db.conversation.findUnique({ where: { id: conversation.id } })).toMatchObject({ lastMessagePreview: 'newer', lastMessagePreviewAt: latest.createdAt, lastMessageAt: latest.createdAt, unreadCount: 2 });
        expect(await db.conversationPreviewOwner.findUnique({ where: { conversationId: conversation.id } })).toMatchObject({ messageId: latest.id });
    });
    it('persists one pending group metadata obligation across providers, deliveries and history without attendance', async () => {
        const f = await fixture(), group = '123-456@g.us', participant = '15550003333@s.whatsapp.net';
        const id = await f.send('evolution', { type: 'append', key: { id: 'group-metadata', remoteJid: group, fromMe: false, participant }, pushName: 'Synthetic participant' });
        await service.apply(id);
        await service.apply(id);
        const contact = await db.contact.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        expect(contact).toMatchObject({ name: null, isGroup: true });
        const obligations = await db.ingressEffect.findMany({ where: { workspaceId: f.workspaceId, kind: 'contact.group_metadata' } });
        expect(obligations).toHaveLength(1);
        expect(obligations[0]).toMatchObject({ state: 'pending', frozen: { contactId: contact.id, chatAddress: group, nativeChatAddress: group, originalName: null, presentationOnly: true, mode: 'history' } });
        const mirror = await f.send('waha', { id: `false_${group}_group-metadata`, from: group, participant, _data: { author: participant } });
        await service.apply(mirror);
        const later = await f.send('evolution', { type: 'append', key: { id: 'group-metadata-later', remoteJid: group, fromMe: false, participant } });
        await service.apply(later);
        expect(await db.ingressEffect.findMany({ where: { workspaceId: f.workspaceId, kind: 'contact.group_metadata' } })).toEqual(obligations);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: { notIn: ['contact.group_metadata', 'realtime.message', 'realtime.conversation'] } } })).toBe(0);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 0 });
        // Existing real group names need no deferred lookup or participant-name overwrite.
        await db.contact.update({ where: { id: contact.id }, data: { name: 'Synthetic group' } });
        const named = await f.send('evolution', { type: 'append', key: { id: 'group-named', remoteJid: group, fromMe: false, participant }, pushName: 'Another participant' });
        await service.apply(named);
        expect(await db.contact.findUnique({ where: { id: contact.id } })).toMatchObject({ name: 'Synthetic group' });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'contact.group_metadata' } })).toBe(1);
    });
    it.each(['evolution', 'waha'] as const)('two providers, %s first, delivery repeats: one UUID, unread and logical effects', async (first) => {
        const f = await fixture();
        const a = await f.send(first), b = await f.send(first === 'evolution' ? 'waha' : 'evolution');
        await Promise.all([service.apply(a), service.apply(b)]);
        await service.apply(a);
        const messages = await db.message.findMany({ where: { workspaceId: f.workspaceId } });
        expect(messages).toHaveLength(1);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1, lastMessagePreview: 'hello' });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'prospecting.inbound' } })).toBe(1);
        expect(await db.ingressEffect.findMany({ where: { workspaceId: f.workspaceId } })).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'pending', messageId: messages[0]!.id })]));
        expect(await db.ingressApplication.findUnique({ where: { receiptId: a } })).toMatchObject({ state: 'applied', appliedAt: expect.any(Date) });
    });
    it('WAHA-only fallback applies in the actual executable worker and ACK follows complete SQL obligations', async () => {
        const f = await fixture(), id = await f.send('waha');
        const child = spawn(process.execPath, ['dist/ingress-worker.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl, INGRESS_TRANSPORT_STAGE: 'isolated-1b', INGRESS_AMQP_URL: brokerUrl, INGRESS_NAMESPACE: f.namespace, INGRESS_PRIVATE_ROOT: root, INGRESS_WORKSPACE_ALLOWLIST: f.workspaceId }, stdio: 'pipe' });
        children.push(child);
        await until(() => db.ingressApplication.findUnique({ where: { receiptId: id } }), v => v?.state === 'applied');
        const ch = await admin.createChannel();
        await until(() => ch.checkQueue(transportTopology(f.namespace).incoming), v => v.messageCount === 0);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBeGreaterThan(0);
        await ch.close();
        child.kill('SIGTERM');
        await until(async () => child.exitCode, v => v !== null);
    });
    it('old authenticated lifecycle is retained pending recertification, never applied or paused', async () => {
        const f = await fixture(), id = await f.send();
        await db.channelConnection.update({ where: { id: f.evo.id }, data: { lifecycleGeneration: 2 } });
        await service.apply(id);
        await service.apply(id);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: id } })).toMatchObject({ state: 'pending_recertification', reason: 'stale_source' });
        expect(await db.ingressApplication.findUnique({ where: { receiptId: id } })).toMatchObject({ state: 'held', appliedAt: null });
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        expect((await db.ingressReceipt.findUniqueOrThrow({ where: { id } })).source).toMatchObject({ lifecycleGeneration: 0 });
    });
    describe('recertification of events held as stale_source', () => {
        async function held(f: Awaited<ReturnType<typeof fixture>>, generation = 2) {
            const id = await f.send();
            await db.channelConnection.update({ where: { id: f.evo.id }, data: { lifecycleGeneration: generation, status: 'connected' } });
            await service.apply(id);
            return id;
        }
        it('applies the message under the current source as recovered traffic, leaving the held fact untouched', async () => {
            const f = await fixture(), id = await held(f);
            expect(await service.recertify(id, 0)).toMatchObject({ state: 'applied' });
            expect(await db.ingressEventProgress.findFirst({ where: { receiptId: id } })).toMatchObject({ state: 'pending_recertification', reason: 'stale_source' });
            expect(await db.ingressEventRecertification.findUnique({ where: { receiptId_eventIndex: { receiptId: id, eventIndex: 0 } } })).toMatchObject({ outcome: 'applied', messageId: expect.any(String) });
            const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
            expect(conversation).toMatchObject({ unreadCount: 1, lastMessagePreview: 'hello' });
            expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
            // Recovered traffic reaches people, not agents or automations.
            const kinds = (await db.ingressEffect.findMany({ where: { workspaceId: f.workspaceId } })).map(e => e.kind);
            expect(kinds).toEqual(expect.arrayContaining(['realtime.message']));
            expect(kinds).not.toEqual(expect.arrayContaining(['agent.debounce']));
            expect(kinds).not.toEqual(expect.arrayContaining(['assistant.message']));
            expect(kinds).not.toEqual(expect.arrayContaining(['automation.occurrence']));
            expect(await service.recertify(id, 0)).toMatchObject({ state: 'already_certified' });
            expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        });
        it('keeps the event waiting while the connection is still being paired, and applies it once it settles', async () => {
            const f = await fixture(), id = await held(f, 2);
            await db.channelConnection.update({ where: { id: f.evo.id }, data: { lifecycleGeneration: 3 } });
            expect(await service.recertify(id, 0)).toEqual({ state: 'still_stale' });
            expect(await db.ingressEventRecertification.count({ where: { receiptId: id } })).toBe(0);
            await db.channelConnection.update({ where: { id: f.evo.id }, data: { lifecycleGeneration: 4 } });
            expect(await service.recertify(id, 0)).toMatchObject({ state: 'applied' });
        });
        it('never gives a message from one number to a session now paired with another', async () => {
            const f = await fixture(), id = await held(f);
            await db.channelConnection.update({ where: { id: f.evo.id }, data: { verifiedPhoneNumber: '15559990000' } });
            expect(await service.recertify(id, 0)).toMatchObject({ state: 'held' });
            expect(await db.ingressEventRecertification.findUnique({ where: { receiptId_eventIndex: { receiptId: id, eventIndex: 0 } } })).toMatchObject({ outcome: 'held', reason: 'number_changed' });
            expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
        });
        it('does nothing for events that are not waiting, and the sweep applies what is ready', async () => {
            const f = await fixture(), fresh = await f.send('evolution', { key: { id: 'fresh-one', remoteJid: peer, fromMe: false } });
            await service.apply(fresh);
            expect(await service.recertify(fresh, 0)).toEqual({ state: 'not_pending' });
            const id = await held(f);
            expect(await service.recertifyPending({ workspaceIds: [f.workspaceId] })).toEqual({ examined: 1, applied: 1 });
            expect(await service.recertifyPending({ workspaceIds: [f.workspaceId] })).toEqual({ examined: 0, applied: 0 });
            expect(await db.ingressEventRecertification.count({ where: { receiptId: id } })).toBe(1);
        });
    });
    it('a WAHA message from a LID chat joins the phone conversation when WAHA itself proves the number', async () => {
        const f = await fixture(), lid = '423456789012345@lid';
        await service.apply(await f.send('evolution', { key: { id: 'phone-first', remoteJid: peer, fromMe: false } }));
        const proven = createIngressHttp({ db, journal, publisher: () => f.publisher, evolutionSecret: secret, wahaSecret: secret, workspaceAllowlist: new Set([f.workspaceId]),
            wahaLids: { resolve: async (_session: string, input: unknown) => JSON.stringify(input).includes(lid) ? [{ lid, pn: peer }] : [] } });
        apps.push(proven);
        const raw = { id: randomUUID(), event: 'message.any', session: f.waha.sessionName, payload: { id: `false_${lid}_from-lid`, from: lid, fromMe: false, body: 'pelo lid', timestamp: 1700000100 } };
        const result = await proven.inject({ method: 'POST', url: `/webhooks/waha/${f.workspaceId}`, headers: { 'content-type': 'application/json', 'x-webhook-hmac': createHmac('sha512', secret).update(JSON.stringify(raw)).digest('hex'), 'x-webhook-hmac-algorithm': 'sha512' }, payload: JSON.stringify(raw) });
        expect(result.statusCode).toBe(202);
        await service.apply(result.json().receiptId);
        expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        expect((await db.message.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { createdAt: 'asc' } })).map(m => m.body)).toEqual(['hello', 'pelo lid']);
        // Without WAHA's answer the same LID stays its own chat (no guessed identity).
        const unproven = await f.send('waha', { id: `false_${lid}_no-proof`, from: lid, body: 'sem prova' });
        await service.apply(unproven);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId, body: 'sem prova' } })).toBe(1);
    });
    it('history/append never increments unread, opens service window or creates autonomous effects', async () => {
        const f = await fixture(), id = await f.send('evolution', { type: 'append' });
        await service.apply(id);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 0, aiControlStatus: 'human_controlled' });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'agent.debounce' } })).toBe(0);
    });
    it('operator outbound uses the real pause helper; a same body campaign is no proof', async () => {
        const f = await fixture(), id = await f.send('evolution', { key: { id: 'operator', remoteJid: peer, fromMe: true } });
        await service.apply(id);
        await service.apply(id);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 0, aiControlStatus: 'human_controlled', hiddenUntilReply: false });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'human_reply.improvement' } })).toBe(1);
    });
    it('commit before ACK crash redelivers the original reference without duplicate domain hooks', async () => {
        const f = await fixture(), id = await f.send();
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/modules/ingress/application-crash-child.fixture.mjs'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl, INGRESS_TRANSPORT_STAGE: 'isolated-1b', INGRESS_AMQP_URL: brokerUrl, INGRESS_NAMESPACE: f.namespace, INGRESS_PRIVATE_ROOT: root, INGRESS_WORKSPACE_ALLOWLIST: f.workspaceId }, stdio: 'pipe' });
        children.push(child);
        await until(async () => child.exitCode, v => v !== null);
        expect(child.exitCode).toBe(73);
        expect(await db.ingressApplication.findUnique({ where: { receiptId: id } })).toMatchObject({ state: 'applied' });
        const ch = await admin.createChannel();
        await until(() => ch.checkQueue(transportTopology(f.namespace).incoming), v => v.messageCount === 1);
        const consumer = await IngressTransportConsumer.start({ url: brokerUrl!, namespace: f.namespace, journal, publisher: () => f.publisher, application: service });
        consumers.push(consumer);
        await until(() => ch.checkQueue(transportTopology(f.namespace).incoming), v => v.messageCount === 0);
        await consumer.close();
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 1 });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'prospecting.inbound' } })).toBe(1);
        await ch.close();
    });
    it('effect persistence failure rolls back Message, contact, unread and progress before transport bounded retry', async () => {
        const f = await fixture(), id = await f.send();
        await failInsert('ingress_effects', f.workspaceId, async () => {
            await expect(service.apply(id)).rejects.toThrow('fixture rollback');
            expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
            expect(await db.contact.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
            expect(await db.ingressEventProgress.count({ where: { receiptId: id } })).toBe(0);
            const consumer = await IngressTransportConsumer.start({ url: brokerUrl!, namespace: f.namespace, journal, publisher: () => f.publisher, application: service, maxFailures: 2 });
            consumers.push(consumer);
            await until(() => db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: id } }), v => v.state === 'dead_letter');
            await consumer.close();
            expect(await db.ingressPublishAttempt.findMany({ where: { receiptId: id }, orderBy: { createdAt: 'asc' } })).toEqual(expect.arrayContaining([expect.objectContaining({ destination: 'retry', outcome: 'confirmed' }), expect.objectContaining({ destination: 'dead', outcome: 'confirmed' })]));
        });
        await journal.recoverDeadLetter({ namespace: f.namespace, workspaceId: f.workspaceId, channelId: f.channel.id, receiptId: id });
        await service.apply(id);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    });
    it('equal raw IDs in different chats/workspaces and group participants preserve separate UUIDs and no participant group name', async () => {
        const f = await fixture(), g = await fixture();
        for (const target of [f, g])
            for (const jid of [peer, '15550002222@s.whatsapp.net']) {
                const id = await target.send('evolution', { key: { id: 'same-stanza', remoteJid: jid, fromMe: false }, pushName: 'Contact Label' });
                await service.apply(id);
            }
        for (const participant of ['15550003333@s.whatsapp.net', '15550004444@s.whatsapp.net']) {
            const id = await f.send('evolution', { key: { id: 'same-stanza', remoteJid: '123456789012@g.us', participant, fromMe: false }, pushName: 'Participant Label' });
            await service.apply(id);
        }
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(4);
        expect(await db.message.count({ where: { workspaceId: g.workspaceId } })).toBe(2);
        expect(await db.contact.findFirst({ where: { workspaceId: f.workspaceId, isGroup: true } })).toMatchObject({ name: null });
        const group = await db.conversation.findFirst({ where: { workspaceId: f.workspaceId, contact: { isGroup: true } } });
        expect(group).toMatchObject({ unreadCount: 2, aiControlStatus: 'human_controlled' });
    });
    it('late contact name, demonstrated LID and contact/location/media presentation use real Message metadata', async () => {
        const f = await fixture();
        const a = await f.send('waha');
        await service.apply(a);
        const b = await f.send('evolution', { pushName: 'Synthetic Person' });
        await service.apply(b);
        expect(await db.contact.findFirst({ where: { workspaceId: f.workspaceId, phone: '15550001111' } })).toMatchObject({ name: 'Synthetic Person' });
        const cases = [{ id: 'loc', message: { locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: 'Synthetic place' } } }, { id: 'card', message: { contactMessage: { displayName: 'Synthetic Contact', vcard: 'BEGIN:VCARD\nFN:Synthetic Contact\nTEL:+15550009999\nEND:VCARD' } } }, { id: 'img', message: { imageMessage: { url: 'https://media.invalid/synthetic', caption: 'Caption', mimetype: 'image/png', width: 100, height: 80 } } }];
        for (const c of cases) {
            const id = await f.send('evolution', { key: { id: c.id, remoteJid: peer, fromMe: false }, message: c.message });
            await service.apply(id);
        }
        const rows = await db.message.findMany({ where: { workspaceId: f.workspaceId } });
        expect(rows).toHaveLength(4);
        expect(rows.some(r => (r.metadata as any).location)).toBe(true);
        expect(rows.some(r => (r.metadata as any).contactCards)).toBe(true);
        expect(rows.some(r => (r.metadata as any).attachment?.caption === 'Caption')).toBe(true);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'media.prepare' } })).toBe(1);
        const lid = await f.send('evolution', { key: { id: 'lid-proof', remoteJid: '555000000001@lid', remoteJidAlt: peer, fromMe: false } });
        await service.apply(lid);
        expect(await db.contact.findFirst({ where: { workspaceId: f.workspaceId, phone: '15550001111' } })).toMatchObject({ customFields: { evolutionLid: '555000000001@lid' } });
    });
    it('recovered_live mode without a persisted checkpoint does not authorize unread or operational obligations', async () => {
        const f = await fixture(), r = await stage(f, { event: 'MESSAGES_UPSERT', instance: f.evo.sessionName, data: { key: { id: 'recovered', remoteJid: peer, fromMe: false }, message: { conversation: 'hello' }, messageTimestamp: 1700000000 } }, 'recovered_live');
        await service.apply(r.id);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: 0 });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'agent.debounce' } })).toBe(0);
    });
    it('preview clocks stay monotonic and frozen automation persists the original active flow', async () => {
        const f = await fixture();
        await db.automationRule.create({ data: { workspaceId: f.workspaceId, name: 'Synthetic flow', status: 'enabled', trigger: 'message.received', actions: [{ type: 'synthetic' }] } });
        await service.apply(await f.send('evolution', { messageTimestamp: 1700000020 }));
        await service.apply(await f.send('evolution', { key: { id: 'older', remoteJid: peer, fromMe: false }, messageTimestamp: 1700000010, message: { conversation: 'older' } }));
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ lastMessagePreview: 'hello', lastMessageAt: new Date(1700000020000), unreadCount: 2 });
        const e = await db.ingressEffect.findFirstOrThrow({ where: { workspaceId: f.workspaceId, kind: 'automation.occurrence' } });
        expect((e.frozen as any).frozenFlows[0].actions).toEqual([{ type: 'synthetic' }]);
        expect((e.frozen as any).dependsOn).not.toContain('automation.occurrence');
    });
    async function metaFixture() {
        const f = await fixture(), phoneNumberId = 'synthetic-meta-' + randomUUID();
        const meta = await db.channel.create({ data: { workspaceId: f.workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId } });
        await db.integrationConfig.create({ data: { workspaceId: f.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings: { enabled: true, connectionMode: 'direct', phoneNumberId, wabaId: 'synthetic', accessToken: 'local-test-only', appSecret: secret } } });
        const value = (messages: unknown[], statuses: unknown[] = []) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages, statuses } }] }] });
        async function submit(body: unknown) { const response = await f.app.inject({ method: 'POST', url: `/webhooks/meta/${f.workspaceId}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}` }, payload: JSON.stringify(body) }); expect(response.statusCode).toBe(202); return response.json().receiptId as string; }
        return { ...f, meta, phoneNumberId, value, submit };
    }
    it('Meta partial batch crash resumes positions, opens window once per live message and retains unsupported media held', async () => {
        const f = await metaFixture();
        const id = await f.submit(f.value([{ id: 'wamid.batch1', from: '15550001111', type: 'text', text: { body: 'one' }, timestamp: '1700000000' }, { id: 'wamid.batch2', from: '15550001111', type: 'text', text: { body: 'two' }, timestamp: '1700000005' }]));
        await failInsert('ingress_event_progress', f.workspaceId, async () => {
            await expect(service.apply(id)).rejects.toThrow('fixture rollback');
            expect(await db.ingressEventProgress.count({ where: { receiptId: id } })).toBe(1);
            expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
            expect(await db.ingressApplication.findUnique({ where: { receiptId: id } })).toBe(null);
        }, 1);
        await service.apply(id);
        await service.apply(id);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId, channelId: f.meta.id } })).toMatchObject({ unreadCount: 2, customerServiceWindowExpiresAt: new Date(1700086405000) });
        const unsupported = await f.submit(f.value([{ id: 'wamid.image', from: '15550001111', type: 'image', image: { id: 'private-meta-media' } }]));
        await service.apply(unsupported);
        expect(await db.ingressApplication.findUnique({ where: { receiptId: unsupported } })).toMatchObject({ state: 'held', appliedAt: null });
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: unsupported } })).toMatchObject({ state: 'held', reason: 'unsupported_meta_message' });
    });
    it('Meta receipts use own native namespace and proven recipient; controls without recipient are held', async () => {
        const f = await metaFixture();
        const raw = f.value([{ id: 'wamid.status', from: '15550001111', type: 'text', text: { body: 'outbound' }, timestamp: '1700000000' }]);
        const seedReceipt = await f.submit(raw);
        const { payload } = await journal.readPayload(seedReceipt);
        const item = payload.events[0];
        if (item?.kind !== 'accepted' || item.event.kind !== 'message')
            throw Error('fixture');
        const original = { ...item.event, key: { ...item.event.key, direction: 'outbound' as const } };
        const created = await createCanonicalStore().persist(db, original, { receiptKey: 'synthetic-meta-outbound' });
        const id = await f.submit(f.value([], [{ id: 'wamid.status', recipient_id: '15550001111', status: 'read', timestamp: '1700000006' }]));
        await service.apply(id);
        await service.apply(id);
        expect(await db.message.findUnique({ where: { id: created.messageId! } })).toMatchObject({ status: 'read' });
        expect(await db.ingressEffect.findMany({ where: { receiptId: id } })).toHaveLength(2);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId, channelId: f.meta.id } })).toMatchObject({ unreadCount: 0, customerServiceWindowExpiresAt: null });
        const unknown = await f.submit(f.value([], [{ id: 'wamid.status', status: 'read' }]));
        await service.apply(unknown);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: unknown } })).toMatchObject({ state: 'held' });
        const evolutionId = await f.send('evolution', { key: { id: 'wamid.status', remoteJid: peer, fromMe: false }, message: { conversation: 'outbound' } });
        await service.apply(evolutionId);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
        expect(await db.canonicalMessageIdentity.findMany({ where: { workspaceId: f.workspaceId }, select: { providerScope: true } })).toEqual(expect.arrayContaining([{ providerScope: 'meta_official' }, { providerScope: 'evolution' }]));
    });
    it.each(['revoke', 'edit', 'receipt'] as const)('%s before original is conserved and recovered through approved reducers, without extra unread/effects', async (kind) => {
        const f = await fixture();
        const key = { id: 'original', remoteJid: peer, fromMe: false };
        const input = kind === 'receipt' ? { event: 'MESSAGES_UPDATE', instance: f.evo.sessionName, data: { key, status: 'READ' } } : { event: 'MESSAGES_UPSERT', instance: f.evo.sessionName, data: { key: { id: 'action', remoteJid: peer, fromMe: false }, message: { protocolMessage: { key, type: kind === 'revoke' ? 'REVOKE' : 14, ...(kind === 'edit' ? { editedMessage: { conversation: 'edited' } } : {}) } } } };
        const action = await stage(f, input);
        await service.apply(action.id);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: action.id } })).toMatchObject({ state: 'held', actionId: expect.any(String) });
        const id = await f.send('evolution', { key, message: { conversation: 'initial' } });
        await service.apply(id);
        await service.apply(id);
        const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        expect(message).toMatchObject(kind === 'revoke' ? { type: 'system' } : kind === 'edit' ? { body: 'edited' } : { status: 'read' });
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: kind === 'revoke' ? 0 : 1, ...(kind === 'edit' ? { lastMessagePreview: 'edited' } : {}) });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'prospecting.inbound' } })).toBe(kind === 'revoke' ? 0 : 1);
        // Original pending receipt remains an explicit recovery frontier for stage1D.
        expect(await db.ingressApplication.findUnique({ where: { receiptId: action.id } })).toMatchObject({ state: 'held' });
    });
    it('a real contact hook failure rolls back all canonical/domain work', async () => {
        const f = await fixture();
        await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '15550001111' } });
        const id = await f.send('evolution', { pushName: 'Synthetic Name' });
        await failInsert('contacts', f.workspaceId, async () => { await expect(service.apply(id)).rejects.toThrow('fixture rollback'); expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0); expect(await db.conversation.count({ where: { workspaceId: f.workspaceId } })).toBe(0); expect(await db.ingressEventProgress.count({ where: { receiptId: id } })).toBe(0); });
        await service.apply(id);
        expect(await db.contact.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ name: 'Synthetic Name' });
    });
    it.each([false, true])('native Talk binding preserves UUID/control and campaign visibility (campaign=%s)', async (campaignOrigin) => {
        const f = await fixture(), api = createOutboundIntents(), user = await db.userProfile.create({ data: { workspaceId: f.workspaceId, clerkUserId: randomUUID(), displayName: 'Synthetic User' } }), contact = await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '15550001111' } }), conversation = await db.conversation.create({ data: { workspaceId: f.workspaceId, channelId: f.channel.id, contactId: contact.id } });
        const source = await db.$transaction(async (tx) => { await enterCanonicalWorkspaceTransaction(tx, f.workspaceId); return deriveTrustedMessagingContext(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, authenticatedSource: { provider: 'evolution', connectionId: f.evo.id }, mode: 'live', observedAt: '2026-10-01T00:00:00Z' }); });
        const campaign = campaignOrigin ? await db.campaign.create({ data: { workspaceId: f.workspaceId, name: 'Synthetic campaign', messageBody: 'hello', status: 'sending', channelId: f.channel.id, hideFromInboxUntilReply: true } }) : null;
        const recipient = campaign ? await db.campaignRecipient.create({ data: { workspaceId: f.workspaceId, campaignId: campaign.id, channelId: f.channel.id, contactId: contact.id, status: 'in_flight', phoneSnapshot: '15550001111', contactSnapshot: { message: 'hello' }, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000), verifiedAt: new Date() } }) : null;
        const request: any = { conversationId: conversation.id, destination: peer, origin: { kind: recipient ? 'campaign_recipient' : 'human', originId: recipient?.id ?? user.id, actionOrdinal: 0, requestKey: randomUUID() }, actor: { kind: recipient ? 'automation' : 'user', id: campaign?.id ?? user.id }, message: { type: 'text', body: 'hello', mediaUrl: null, metadata: {} }, preparedMedia: [], domainFences: [] };
        if (recipient && campaign)
            request.domainFences = await db.$transaction(async (tx) => { await enterCanonicalWorkspaceTransaction(tx, f.workspaceId); return Promise.all([captureOutboundDomainFenceInTransaction(tx, f.workspaceId, 'campaign', campaign.id), captureOutboundDomainFenceInTransaction(tx, f.workspaceId, 'campaign_recipient', recipient.id), captureOutboundDomainFenceInTransaction(tx, f.workspaceId, 'conversation', conversation.id)]); });
        const reserved = await db.$transaction(tx => api.reserveLocalOutboundInTransaction(tx, source, request, async () => true), { isolationLevel: 'ReadCommitted' });
        expect(reserved.kind).toBe('reserved');
        const dispatch = await db.$transaction(tx => api.beginDispatchInTransaction(tx, source, { intentId: reserved.intent!.id, authorizeOrigin: async () => true }), { isolationLevel: 'ReadCommitted' });
        expect(dispatch.kind).toBe('dispatch');
        const response = await db.$transaction(tx => api.recordDispatchResultInTransaction(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, token: dispatch.attempt!.token, resultKey: 'synthetic', evidence: { transport: 'http', status: 200, bodyState: 'json', raw: { key: { id: 'exact-echo', remoteJid: peer, fromMe: true } } } }), { isolationLevel: 'ReadCommitted' });
        const bound = await db.$transaction(tx => api.bindLocalOutboundInTransaction(tx, { workspaceId: f.workspaceId, channelId: f.channel.id, token: dispatch.attempt!.token, resultId: response.result!.id }), { isolationLevel: 'ReadCommitted' });
        expect(bound.kind).toBe('bound');
        const id = await f.send('evolution', { key: { id: 'exact-echo', remoteJid: peer, fromMe: true } });
        await service.apply(id);
        await service.apply(id);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
        expect(await db.message.findUnique({ where: { id: reserved.intent!.messageId } })).not.toBe(null);
        expect(await db.conversation.findUnique({ where: { id: conversation.id } })).toMatchObject({ aiControlStatus: 'agent_allowed', hiddenUntilReply: campaignOrigin, unreadCount: 0, lastMessageAt: null });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'human_reply.improvement' } })).toBe(0);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'assistant.control' } })).toBe(0);
        if (campaignOrigin) {
            await service.apply(await f.send('evolution', { key: { id: 'reply', remoteJid: peer, fromMe: false } }));
            expect(await db.conversation.findUnique({ where: { id: conversation.id } })).toMatchObject({ hiddenUntilReply: false, unreadCount: 1 });
        }
    });
    it('a current connection observation never proves eligibility; secondary QR and stale first QR do not overwrite primary', async () => {
        const f = await fixture(false);
        await db.channelConnection.update({ where: { id: f.evo.id }, data: { status: 'connected', eligible: true, verifiedPhoneNumber: '15550009999' } });
        await db.channel.update({ where: { id: f.channel.id }, data: { status: 'connected' } });
        const qr = await stage(f, { event: 'QRCODE_UPDATED', instance: f.evo.sessionName, data: { base64: 'synthetic-private-qr' } });
        await db.channelConnection.update({ where: { id: f.evo.id }, data: { lifecycleGeneration: 2 } });
        await service.apply(qr.id);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: qr.id } })).toMatchObject({ state: 'pending_recertification' });
        const raw = { event: 'session.status', session: f.waha.sessionName, id: randomUUID(), payload: { status: 'WORKING' } };
        const result = await f.app.inject({ method: 'POST', url: `/webhooks/waha/${f.workspaceId}`, headers: { 'content-type': 'application/json', 'x-webhook-hmac': createHmac('sha512', secret).update(JSON.stringify(raw)).digest('hex'), 'x-webhook-hmac-algorithm': 'sha512' }, payload: JSON.stringify(raw) });
        expect(result.statusCode).toBe(202);
        await service.apply(result.json().receiptId);
        expect(await db.channelConnection.findUnique({ where: { id: f.waha.id } })).toMatchObject({ status: 'connected', eligible: false, verifiedPhoneNumber: null });
        expect(await db.channelConnection.findUnique({ where: { id: f.evo.id } })).toMatchObject({ status: 'connected', eligible: true });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'realtime.connection' } })).toBe(1);
        expect(JSON.stringify(await db.ingressEffect.findMany({ where: { workspaceId: f.workspaceId } }))).not.toContain('synthetic-private-qr');
    });
    it.each(['missing', 'mismatch', 'degraded', 'changed'] as const)('WAHA same-number receive authority: %s pairing', async (mode) => {
        const f = await fixture(mode !== 'missing');
        if (mode === 'mismatch')
            await db.channelConnection.update({ where: { id: f.waha.id }, data: { verifiedPhoneNumber: '15550007777' } });
        if (mode === 'degraded')
            await db.channelConnection.update({ where: { id: f.waha.id }, data: { status: 'connected', health: 'degraded', eligible: false } });
        const id = await f.send('waha');
        if (mode === 'changed')
            await db.channelConnection.update({ where: { id: f.evo.id }, data: { lifecycleGeneration: 2, verifiedPhoneNumber: '15550006666' } });
        await service.apply(id);
        await service.apply(id);
        expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(mode === 'degraded' ? 1 : 0);
        expect(await db.ingressEventProgress.findFirst({ where: { receiptId: id } })).toMatchObject({ state: mode === 'degraded' ? 'applied' : mode === 'changed' ? 'pending_recertification' : 'held', reason: mode === 'degraded' ? null : mode === 'changed' ? 'waha_pairing_changed' : mode === 'missing' ? 'waha_identity_unverified' : 'waha_identity_mismatch' });
        if (mode !== 'degraded')
            expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    });
    it('completion timestamp is stable when the same receipt is redelivered', async () => {
        const f = await fixture(), id = await f.send();
        const first = await service.apply(id);
        await new Promise(r => setTimeout(r, 25));
        const second = await service.apply(id);
        expect(second.appliedAt).toEqual(first.appliedAt);
    });
    it('real routing and persistent assistant state share the Message commit; operator pause cancels the active session/reply', async () => {
        const f = await fixture(), agent = await db.aiAgent.create({ data: { workspaceId: f.workspaceId, name: 'Synthetic agent', systemPrompt: 'Synthetic prompt' } }), user = await db.userProfile.create({ data: { workspaceId: f.workspaceId, clerkUserId: randomUUID(), displayName: 'Synthetic agent user', presenceState: 'online' } });
        await db.channel.update({ where: { id: f.channel.id }, data: { encryptedConfig: { assistant: { mode: 'automatic', agentId: agent.id } } } });
        const department = await db.department.create({ data: { workspaceId: f.workspaceId, name: 'Synthetic department', distributionMode: 'round_robin', members: { create: { userId: user.id } }, channelRules: { create: { channelId: f.channel.id } } } });
        const id = await f.send();
        await failInsert('assistant_conversation_states', f.workspaceId, async () => { await expect(service.apply(id)).rejects.toThrow('fixture rollback'); expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0); expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId } })).toBe(0); });
        await service.apply(id);
        const conversation = await db.conversation.findFirstOrThrow({ where: { workspaceId: f.workspaceId } }), message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
        expect(conversation).toMatchObject({ departmentId: department.id, assignedUserId: user.id });
        expect(await db.assistantConversationState.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'pending', lastMessageId: message.id });
        const session = await db.aiAgentSession.create({ data: { workspaceId: f.workspaceId, agentId: agent.id, conversationId: conversation.id } });
        await db.conversation.update({ where: { id: conversation.id }, data: { activeAgentSessionId: session.id } });
        await db.aiAgentPendingReply.create({ data: { workspaceId: f.workspaceId, conversationId: conversation.id, agentId: agent.id, sessionId: session.id, lastMessageId: message.id, scheduledAt: new Date() } });
        await service.apply(await f.send('evolution', { key: { id: 'genuine-operator', remoteJid: peer, fromMe: true } }));
        expect(await db.aiAgentSession.findUnique({ where: { id: session.id } })).toMatchObject({ status: 'paused_by_human' });
        expect(await db.aiAgentPendingReply.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'cancelled', lastError: 'human_outbound' });
        expect(await db.assistantConversationState.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'stale', scheduledAt: null });
    });
    it('campaign body/time/provider ID heuristics cannot hide or classify an unbound real operator', async () => {
        const f = await fixture(), contact = await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '15550001111' } }), campaign = await db.campaign.create({ data: { workspaceId: f.workspaceId, name: 'Synthetic legacy campaign', messageBody: 'hello', hideFromInboxUntilReply: true } });
        await db.campaignRecipient.create({ data: { workspaceId: f.workspaceId, campaignId: campaign.id, channelId: f.channel.id, contactId: contact.id, status: 'in_flight', phoneSnapshot: '15550001111', contactSnapshot: { message: 'hello' }, verifiedAt: new Date() } });
        await service.apply(await f.send('evolution', { key: { id: 'unbound-operator', remoteJid: peer, fromMe: true } }));
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ hiddenUntilReply: false, aiControlStatus: 'human_controlled', lastMessageAt: expect.any(Date) });
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'human_reply.improvement' } })).toBe(1);
    });
    it.each(['history', 'group'] as const)('media acquisition is a durable presentation obligation for %s without attendance', async (mode) => {
        const f = await fixture();
        const id = await f.send('evolution', {
            ...(mode === 'history' ? { type: 'append' } : {}),
            key: { id: 'presentation-media', remoteJid: mode === 'group' ? '123456789012@g.us' : peer, fromMe: false, ...(mode === 'group' ? { participant: '15550005555@s.whatsapp.net' } : {}) },
            message: { imageMessage: { url: 'https://media.invalid/presentation', mimetype: 'image/png' } }
        });
        await service.apply(id);
        await service.apply(id);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'media.prepare' } })).toBe(1);
        expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: { in: ['assistant.message', 'agent.debounce', 'prospecting.inbound', 'automation.occurrence', 'followup.activity'] } } })).toBe(0);
        expect(await db.conversation.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ unreadCount: mode === 'history' ? 0 : 1, aiControlStatus: 'human_controlled' });
    });
    it('unqualified secondary connected status cannot overwrite logical primary disconnected status', async () => {
        const f = await fixture(false);
        const raw = { event: 'session.status', session: f.waha.sessionName, id: randomUUID(), payload: { status: 'WORKING' } };
        const r = await f.app.inject({ method: 'POST', url: `/webhooks/waha/${f.workspaceId}`, headers: { 'content-type': 'application/json', 'x-webhook-hmac': createHmac('sha512', secret).update(JSON.stringify(raw)).digest('hex'), 'x-webhook-hmac-algorithm': 'sha512' }, payload: JSON.stringify(raw) });
        expect(r.statusCode).toBe(202);
        await service.apply(r.json().receiptId);
        expect(await db.channelConnection.findUnique({ where: { id: f.waha.id } })).toMatchObject({ status: 'connected', eligible: false });
        expect(await db.channel.findUnique({ where: { id: f.channel.id } })).toMatchObject({ status: 'disconnected' });
    });
    it('demonstrated group identity and absent blank contact name are annotated without replacing existing labels', async () => {
        const f = await fixture();
        await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '123456789012@g.us', name: 'Synthetic group', isGroup: false } });
        await db.contact.create({ data: { workspaceId: f.workspaceId, phone: '15550001111', name: '' } });
        await service.apply(await f.send('evolution', { key: { id: 'group-proof', remoteJid: '123456789012@g.us', participant: '15550003333@s.whatsapp.net', fromMe: false }, pushName: 'Participant Label' }));
        await service.apply(await f.send('evolution', { pushName: 'Synthetic Customer' }));
        expect(await db.contact.findFirst({ where: { workspaceId: f.workspaceId, phone: '123456789012@g.us' } })).toMatchObject({ isGroup: true, name: 'Synthetic group' });
        expect(await db.contact.findFirst({ where: { workspaceId: f.workspaceId, phone: '15550001111' } })).toMatchObject({ name: 'Synthetic Customer' });
    });

    describe('media.prepare executed by the durable runner', () => {
        const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
        async function harness(deps: { waha?: any; evolution?: any; withoutJournal?: boolean }, scope: string[]) {
            const store = new IngressPrivateStore(join(root, `media-${randomUUID()}`));
            await store.initialize();
            const media = createMessageMediaService({ db, store });
            const handler = createMediaPrepareHandler({ ...(deps.withoutJournal ? {} : { journal }), media, waha: deps.waha ?? null, evolution: deps.evolution ?? null });
            const runner = createEffectRunner({ db, workerId: 'media-test', handlers: { 'media.prepare': handler }, workspaceIds: scope, baseBackoffMs: 1, maxAttempts: 3 });
            return { media, runner };
        }
        it('stores an Evolution image through the provider fallback and marks the effect done', async () => {
            const f = await fixture();
            const fetchMedia = async () => `data:image/png;base64,${PNG.toString('base64')}`;
            const { media, runner } = await harness({ evolution: { fetchMedia } }, [f.workspaceId]);
            await service.apply(await f.send('evolution', { key: { id: 'evo-media', remoteJid: peer, fromMe: false }, message: { imageMessage: { url: 'https://media.invalid/expired', mimetype: 'image/png' } } }));
            await runner.drain();
            const effect = await db.ingressEffect.findFirstOrThrow({ where: { workspaceId: f.workspaceId, kind: 'media.prepare' } });
            expect(effect).toMatchObject({ state: 'done', result: { state: 'stored', playback: 'not_applicable' } });
            const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
            const served = await media.read({ workspaceId: f.workspaceId, conversationId: message.conversationId, messageId: message.id });
            expect(served?.bytes.equals(PNG)).toBe(true);
        });
        it('stores a WAHA-only image with an authenticated scoped fetch and never uses the provider URL', async () => {
            const f = await fixture();
            const mediaExact = vi.fn(async (_input: Record<string, unknown>) => ({ kind: 'resolved' as const, message: { id: 'x', media: { url: 'http://waha.internal/api/files/s/f.png', mimetype: 'image/png' } }, bytes: new Uint8Array(PNG) }));
            const { media, runner } = await harness({ waha: { mediaExact } }, [f.workspaceId]);
            const id = `false_${peer}_waha-media`;
            await service.apply(await f.send('waha', { id, hasMedia: true, media: { url: 'http://waha.internal/api/files/s/f.png', mimetype: 'image/png' }, _data: { type: 'image', mimetype: 'image/png' } }));
            await runner.drain();
            expect(mediaExact).toHaveBeenCalledTimes(1);
            expect(mediaExact.mock.calls[0]![0]).toMatchObject({ session: f.waha.sessionName, purpose: 'serve' });
            const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
            const row = await db.messageMedia.findUniqueOrThrow({ where: { messageId: message.id } });
            expect(row).toMatchObject({ state: 'stored', sourceKind: 'waha', mimeType: 'image/png' });
            expect((await media.read({ workspaceId: f.workspaceId, conversationId: message.conversationId, messageId: message.id }))?.bytes.equals(PNG)).toBe(true);
        });
        it('a process without the private receipt store prepares media from the identifiers frozen in the effect', async () => {
            const f = await fixture();
            const mediaExact = vi.fn(async (_input: Record<string, unknown>) => ({ kind: 'resolved' as const, message: { id: 'x', media: { url: 'http://waha.internal/api/files/s/f.png', mimetype: 'image/png' } }, bytes: new Uint8Array(PNG) }));
            const { media, runner } = await harness({ waha: { mediaExact }, withoutJournal: true }, [f.workspaceId]);
            await service.apply(await f.send('waha', { id: `false_${peer}_frozen-source`, hasMedia: true, media: { url: 'http://waha.internal/api/files/s/f.png', mimetype: 'image/png' }, _data: { type: 'image', mimetype: 'image/png' } }));
            const effect = await db.ingressEffect.findFirstOrThrow({ where: { workspaceId: f.workspaceId, kind: 'media.prepare' } });
            expect(effect.frozen).toMatchObject({ mediaSource: { provider: 'waha', sessionName: f.waha.sessionName, mimeType: 'image/png' } });
            await runner.drain();
            expect(mediaExact.mock.calls[0]![0]).toMatchObject({ session: f.waha.sessionName, purpose: 'serve' });
            const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
            expect((await media.read({ workspaceId: f.workspaceId, conversationId: message.conversationId, messageId: message.id }))?.bytes.equals(PNG)).toBe(true);
        });
        it('the compiled worker executes media.prepare by itself: webhook -> Message -> effect -> stored original', async () => {
            const f = await fixture();
            const requests: string[] = [];
            const evolutionApi = http.createServer((req, res) => {
                requests.push(`${req.method} ${req.url}`);
                req.resume();
                req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ base64: PNG.toString('base64'), mimetype: 'image/png' })); });
            });
            await new Promise<void>(resolve => evolutionApi.listen(0, '127.0.0.1', resolve));
            const mediaRoot = join(root, `worker-media-${randomUUID()}`);
            const child = spawn(process.execPath, ['dist/ingress-worker.js'], { cwd: process.cwd(), stdio: 'pipe', env: { ...process.env, DATABASE_URL: databaseUrl, INGRESS_TRANSPORT_STAGE: 'isolated-1b', INGRESS_AMQP_URL: brokerUrl, INGRESS_NAMESPACE: f.namespace,
                INGRESS_PRIVATE_ROOT: root, INGRESS_WORKSPACE_ALLOWLIST: f.workspaceId, TALK_MEDIA_STORE_PATH: mediaRoot,
                EVOLUTION_API_BASE_URL: `http://127.0.0.1:${(evolutionApi.address() as { port: number }).port}`, EVOLUTION_API_KEY: 'test-only' } });
            children.push(child);
            try {
                await f.send('evolution', { key: { id: 'worker-media', remoteJid: peer, fromMe: false }, message: { imageMessage: { url: 'https://media.invalid/expired', mimetype: 'image/png' } } });
                const stored = await until(() => db.messageMedia.findFirst({ where: { workspaceId: f.workspaceId } }), v => v?.state === 'stored');
                expect(stored).toMatchObject({ mimeType: 'image/png', sourceKind: 'evolution', sizeBytes: PNG.length });
                expect(await until(() => db.ingressEffect.findFirstOrThrow({ where: { workspaceId: f.workspaceId, kind: 'media.prepare' } }), v => v.state === 'done')).toMatchObject({ attempts: 1 });
                expect(requests).toEqual([expect.stringMatching(/^POST \/chat\/getBase64FromMediaMessage\//)]);
                // Effects without a handler yet stay pending obligations, untouched.
                expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, state: 'pending' } })).toBeGreaterThan(0);
            } finally {
                child.kill('SIGTERM');
                await until(async () => child.exitCode, v => v !== null);
                await new Promise<void>(resolve => evolutionApi.close(() => resolve()));
            }
        });
        it('retries a provider outage, then fails visibly and recovers after an operator requeue without a duplicate effect', async () => {
            const f = await fixture();
            let up = false;
            const fetchMedia = vi.fn(async () => { if (!up) throw new Error('provider down'); return `data:image/png;base64,${PNG.toString('base64')}`; });
            const { runner } = await harness({ evolution: { fetchMedia } }, [f.workspaceId]);
            await service.apply(await f.send('evolution', { key: { id: 'evo-outage', remoteJid: peer, fromMe: false }, message: { imageMessage: { url: 'https://media.invalid/gone', mimetype: 'image/png' } } }));
            for (let i = 0; i < 5; i++) { await runner.drain(); await new Promise(r => setTimeout(r, 15)); }
            const failed = await db.ingressEffect.findFirstOrThrow({ where: { workspaceId: f.workspaceId, kind: 'media.prepare' } });
            expect(failed).toMatchObject({ state: 'failed', attempts: 3, lastErrorCode: 'MEDIA_UNAVAILABLE' });
            expect(await db.messageMedia.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ state: 'unavailable', originalRef: null });
            up = true;
            expect(await runner.requeue(failed.id)).toBe(true);
            await runner.drain();
            expect(await db.ingressEffect.count({ where: { workspaceId: f.workspaceId, kind: 'media.prepare' } })).toBe(1);
            expect(await db.ingressEffect.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ state: 'done' });
            expect(await db.messageMedia.findFirst({ where: { workspaceId: f.workspaceId } })).toMatchObject({ state: 'stored' });
        });
    });

    describe('every effect executed by the durable runner', () => {
        function wiring(workspaceId: string, extra: Record<string, unknown> = {}) {
            const log: string[] = [];
            const call = (name: string) => vi.fn(async (..._args: unknown[]) => { log.push(name); return undefined; });
            const published: any[] = [];
            const services = {
                db, realtime: { publish: (event: unknown) => { published.push(event); log.push(`realtime:${(event as { type: string }).type}`); } },
                assistantScheduler: { message: call('assistant.message'), control: call('assistant.control'), isAssisted: vi.fn(async () => false) },
                handoffBriefService: { schedule: vi.fn(() => { log.push('handoff.brief'); }) },
                inboxTriage: { observeMessage: call('triage.message') },
                followupService: { observeConversationActivity: call('followup.activity') },
                agentImprovements: { observeHumanReply: vi.fn(async () => { log.push('human_reply.improvement'); return { created: true }; }) },
                agentRuntime: { prepareAudioMessage: vi.fn(async () => { log.push('prepareAudioMessage'); return { status: 'completed' }; }) },
                agentReplyScheduler: { scheduleActiveSessionForMessage: call('agent.schedule') },
                automationRunner: { runForInboundMessage: call('automation.occurrence') },
                historyBackfill: call('history.backfill'),
                ...extra
            };
            const runner = createEffectRunner({ db, workerId: 'handlers-test', handlers: createEffectHandlers(services as never), workspaceIds: [workspaceId], baseBackoffMs: 1 });
            return { services, runner, log, published };
        }
        const effectsOf = (workspaceId: string) => db.ingressEffect.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });

        it('a customer message runs each consequence exactly once, in dependency order, from the frozen inputs', async () => {
            const f = await fixture();
            const { services, runner, log, published } = wiring(f.workspaceId);
            await service.apply(await f.send('evolution', { key: { id: 'handler-text', remoteJid: peer, fromMe: false }, pushName: 'Maria', message: { conversation: 'preciso de 10 chapas' } }));
            await runner.drain();
            const effects = await effectsOf(f.workspaceId);
            expect(effects.every(e => e.state === 'done')).toBe(true);
            const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
            const conversationId = message.conversationId;
            expect(published.find(e => e.type === 'message.created')?.payload).toMatchObject({ id: message.id, body: 'preciso de 10 chapas' });
            expect(published.find(e => e.type === 'conversation.updated')?.payload).toMatchObject({ id: conversationId });
            expect(services.assistantScheduler.message).toHaveBeenCalledWith({ workspaceId: f.workspaceId, conversationId, messageId: message.id, direction: 'inbound' });
            expect(services.handoffBriefService.schedule).toHaveBeenCalledWith({ workspaceId: f.workspaceId, conversationId });
            expect(services.inboxTriage.observeMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: message.id, direction: 'inbound' }));
            expect(services.followupService.observeConversationActivity).toHaveBeenCalledWith({ workspaceId: f.workspaceId, conversationId, messageId: message.id, direction: 'inbound', source: 'customer' });
            expect(services.automationRunner.runForInboundMessage).toHaveBeenCalledWith({ workspaceId: f.workspaceId, messageId: message.id, eventKey: `message.received:${message.id}` });
            expect(services.agentReplyScheduler.scheduleActiveSessionForMessage).toHaveBeenCalledWith({ workspaceId: f.workspaceId, conversationId, messageId: message.id });
            expect(services.historyBackfill).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: f.workspaceId, conversationId, providerKey: f.channel.providerKey, identity: '15550001111', pushName: 'Maria' }));
            expect(log.indexOf('agent.schedule')).toBeGreaterThan(log.indexOf('assistant.message') < 0 ? 0 : -1);
            const prospecting = effects.find(e => e.kind === 'prospecting.inbound')!;
            expect(prospecting.result).toEqual({ reserved: false, activated: false, liveEligible: false });
            expect(prospecting.completedAt!.getTime()).toBeLessThanOrEqual(effects.find(e => e.kind === 'agent.debounce')!.completedAt!.getTime());
            const before = log.length;
            await runner.drain();
            expect(log).toHaveLength(before);
        });

        it('a human operator message pauses the assistant, records the follow-up and improvement, and never wakes the agent', async () => {
            const f = await fixture();
            const { services, runner } = wiring(f.workspaceId);
            await service.apply(await f.send('evolution', { key: { id: 'handler-operator', remoteJid: peer, fromMe: true }, message: { conversation: 'já te respondo' } }));
            await runner.drain();
            const message = await db.message.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
            expect(services.assistantScheduler.control).toHaveBeenCalledWith(f.workspaceId, message.conversationId, true);
            expect(services.followupService.observeConversationActivity).toHaveBeenCalledWith(expect.objectContaining({ direction: 'outbound', source: 'human' }));
            expect(services.agentImprovements.observeHumanReply).toHaveBeenCalledWith({ workspaceId: f.workspaceId, conversationId: message.conversationId, messageId: message.id });
            expect(services.agentReplyScheduler.scheduleActiveSessionForMessage).not.toHaveBeenCalled();
            expect(services.assistantScheduler.message).not.toHaveBeenCalled();
        });

        it('an inbound audio is transcribed only after its media was prepared, so the agent reads the durable original', async () => {
            const f = await fixture();
            const store = new IngressPrivateStore(join(root, `handlers-media-${randomUUID()}`)); await store.initialize();
            const media = createMessageMediaService({ db, store });
            const fetchMedia = vi.fn(async () => `data:audio/ogg;base64,${Buffer.from('OggS-synthetic').toString('base64')}`);
            const mediaHandler = createMediaPrepareHandler({ media, waha: null, evolution: { fetchMedia } as never });
            const { services, log } = wiring(f.workspaceId);
            let mediaWasStored = false;
            services.agentRuntime.prepareAudioMessage = vi.fn(async () => { log.push('prepareAudioMessage'); mediaWasStored = (await db.messageMedia.findFirst({ where: { workspaceId: f.workspaceId } }))?.state === 'stored'; return { status: 'completed' }; });
            const runner = createEffectRunner({ db, workerId: 'audio-test', baseBackoffMs: 1, workspaceIds: [f.workspaceId], handlers: { ...createEffectHandlers(services as never), 'media.prepare': mediaHandler } });
            await service.apply(await f.send('evolution', { key: { id: 'handler-audio', remoteJid: peer, fromMe: false }, message: { audioMessage: { url: 'https://media.invalid/expired.enc', mimetype: 'audio/ogg; codecs=opus', ptt: true } } }));
            await runner.drain();
            expect(mediaWasStored).toBe(true);
            expect(services.agentRuntime.prepareAudioMessage).toHaveBeenCalledTimes(1);
            expect(log.indexOf('prepareAudioMessage')).toBeLessThan(log.indexOf('agent.schedule'));
            expect((await effectsOf(f.workspaceId)).every(e => e.state === 'done')).toBe(true);
        });

        it('the real API process, with its real services and the realtime bridge, drains every effect of an accepted message', async () => {
            const f = await fixture();
            const app = await buildApp({ DATABASE_URL: databaseUrl!, EFFECTS_ENABLED: true, REALTIME_BRIDGE_ENABLED: true, EFFECTS_WORKSPACE_ALLOWLIST: [f.workspaceId],
                TALK_MEDIA_STORE_PATH: join(root, `api-media-${randomUUID()}`) }, { prismaEnabled: true });
            try {
                await service.apply(await f.send('evolution', { key: { id: 'real-api-text', remoteJid: peer, fromMe: false }, pushName: 'Maria', message: { conversation: 'preciso de 10 chapas' } }));
                const effects = await until(() => effectsOf(f.workspaceId), v => v.length > 0 && v.every(e => e.state === 'done' || e.state === 'failed'));
                expect(effects.map(e => [e.kind, e.state, e.lastErrorCode]).filter(([, state]) => state !== 'done')).toEqual([]);
                expect(new Set(effects.map(e => e.kind))).toEqual(new Set(['realtime.message', 'realtime.conversation', 'assistant.message', 'handoff.brief', 'triage.message', 'prospecting.inbound', 'history.backfill', 'followup.activity', 'automation.occurrence', 'agent.debounce']));
            } finally { await app.close(); }
        });

        it('publishes a connection change and the QR from the private receipt, which never reaches SQL', async () => {
            const f = await fixture(false);
            const describeChannel = vi.fn(async (channel: { id: string }) => ({ id: channel.id, status: 'connecting' }));
            const { runner, published } = wiring(f.workspaceId, { journal, describeChannel });
            const qr = await stage(f, { event: 'QRCODE_UPDATED', instance: f.evo.sessionName, data: { base64: 'synthetic-private-qr' } });
            await service.apply(qr.id);
            await runner.drain();
            expect(published.map(e => e.type)).toEqual(['channel.updated', 'channel.qr_updated']);
            expect(published[1].payload).toMatchObject({ channelId: f.channel.id, connectionId: f.evo.id, provider: 'evolution' });
            expect(JSON.stringify(published[1].payload)).toContain('synthetic-private-qr');
            expect(JSON.stringify(await db.ingressEffect.findMany({ where: { workspaceId: f.workspaceId } }))).not.toContain('synthetic-private-qr');
        });
    });
});
