import { randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import amqp, { type ChannelModel } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanonicalStore } from '../messaging/canonical-store.js';
import { normalizeReceipt } from './normalization.js';
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
        async function send(provider: 'evolution' | 'waha' = 'evolution', data: Record<string, unknown> = {}) {
            const input = provider === 'evolution' ? { event: 'MESSAGES_UPSERT', instance: evo.sessionName, data: { key: { id: 'same-stanza', remoteJid: peer, fromMe: false }, message: { conversation: 'hello' }, messageTimestamp: 1700000000, ...data } }
                : { id: randomUUID(), event: 'message.any', session: waha.sessionName, payload: { id: `false_${peer}_same-stanza`, from: peer, fromMe: false, body: 'hello', timestamp: 1700000000, ...data } };
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
});
