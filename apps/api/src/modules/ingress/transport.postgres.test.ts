import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import amqp, { type ChannelModel } from 'amqplib';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmedIngressPublisher, transportTopology } from './broker.js';
import { IngressPrivateStore } from './private-store.js';
import { IngressJournal } from './journal.js';
import { createIngressHttp } from './http.js';
import { IngressTransportConsumer } from './consumer.js';
import { createIngressRuntime, readIngressEnvironment } from './runtime.js';

const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const brokerUrl = process.env.INGRESS_TEST_AMQP_URL;
const secret = 'isolated-webhook-test-only';
const peer = '15550001111@s.whatsapp.net';
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error('Timed out observing durable state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
describe.skipIf(!databaseUrl || !brokerUrl)('isolated ingress PostgreSQL + actual RabbitMQ', () => {
  let db: PrismaClient, files: IngressPrivateStore, journal: IngressJournal, root: string, admin: ChannelModel;
  const workspaces: string[] = [], namespaces: string[] = [], publishers: ConfirmedIngressPublisher[] = [], consumers: IngressTransportConsumer[] = [];
  const apps: ReturnType<typeof createIngressHttp>[] = [];
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    readIngressEnvironment({ INGRESS_TRANSPORT_STAGE: 'isolated-1a', DATABASE_URL: databaseUrl, INGRESS_AMQP_URL: brokerUrl,
      INGRESS_NAMESPACE: 'talk.isolated.test', INGRESS_WORKSPACE_ALLOWLIST: 'fixture', INGRESS_PRIVATE_ROOT: '/private/tmp/unused' });
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    root = await mkdtemp('/private/tmp/talk-ingress-'); files = new IngressPrivateStore(root); await files.initialize();
    journal = new IngressJournal(db, files); admin = await amqp.connect(brokerUrl!);
  });
  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const app of apps) await app.close();
    for (const consumer of consumers) await consumer.close();
    for (const publisher of publishers) await publisher.close();
    if (admin) {
      const channel = await admin.createChannel();
      for (const namespace of namespaces) {
        const topology = transportTopology(namespace);
        for (const name of [topology.incoming, topology.retry, topology.dead]) await channel.deleteQueue(name);
        await channel.deleteExchange(namespace);
      }
      await channel.close(); await admin.close();
    }
    if (db) {
      await db.ingressReceipt.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await db.channel.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await db.integrationConfig.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await db.$disconnect();
    }
    if (root) await rm(root, { recursive: true, force: true });
  }, 20000);
  async function fixture(options: { deadlineMs?: number; maxInflight?: number } = {}) {
    const workspaceId = randomUUID(), namespace = `talk.isolated.${randomUUID()}`;
    workspaces.push(workspaceId); namespaces.push(namespace);
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID() } });
    const evolution = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey } });
    const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: randomUUID() } });
    const publisher = await ConfirmedIngressPublisher.connect(brokerUrl!, namespace, options); publishers.push(publisher);
    const app = createIngressHttp({ db, journal, publisher: () => publisher, evolutionSecret: secret, wahaSecret: secret,
      workspaceAllowlist: new Set([workspaceId]), evolutionAliases: ['/private/evolution/:workspaceId'] }); apps.push(app);
    const envelope = { event: 'MESSAGES_UPSERT', instance: evolution.sessionName, data: { key: { id: 'stanza-A', remoteJid: peer, fromMe: false }, message: { conversation: 'hello' }, messageTimestamp: 1700000000 } };
    const submit = (body: unknown = envelope, headers: Record<string, string | string[]> = { 'x-prymeira-talk-secret': secret }, path = `/webhooks/evolution/${workspaceId}`) => app.inject({ method: 'POST', url: path, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
    const consume = async () => {
      const consumer = await IngressTransportConsumer.start({ url: brokerUrl!, namespace, journal, publisher: () => publisher });
      consumers.push(consumer); return consumer;
    };
    return { workspaceId, channel, evolution, waha, publisher, namespace, app, envelope, submit, consume };
  }
  it('authenticates before staging and rejects duplicate/missing headers, foreign workspace/session and non-JSON', async () => {
    const f = await fixture();
    expect((await f.submit(f.envelope, {})).statusCode).toBe(401);
    expect((await f.submit(f.envelope, { 'x-prymeira-talk-secret': [secret, secret] })).statusCode).toBe(401);
    expect((await f.submit({ ...f.envelope, instance: 'foreign' })).statusCode).toBe(409);
    expect((await f.submit(f.envelope, { 'x-prymeira-talk-secret': secret }, '/webhooks/evolution/foreign')).statusCode).toBe(403);
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });
  it('stages privately then confirms a persistent routed reference, with no credential/media bytes in SQL or Rabbit', async () => {
    const f = await fixture();
    const envelope = { ...f.envelope, apikey: 'do-not-store-key', data: { ...f.envelope.data, message: { imageMessage: { base64: 'aGVsbG8=', mimetype: 'image/png', mediaKey: 'private-decrypt-material', url: 'https://media.invalid/file?apikey=remove-me' } } } };
    const response = await f.submit(envelope, undefined, `/private/evolution/${f.workspaceId}`);
    expect(response.statusCode).toBe(202);
    const id = response.json().receiptId;
    const receipt = await db.ingressReceipt.findUniqueOrThrow({ where: { id }, include: { delivery: true, frontier: true } });
    expect(receipt.authenticatedDigest).toBe(createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
    expect(receipt.delivery).toMatchObject({ state: 'routed', confirmedAt: expect.any(Date) });
    const raw = (await files.read(receipt.rawRef, receipt.rawDigest)).toString();
    expect(raw).not.toContain('do-not-store-key'); expect(raw).not.toContain('remove-me'); expect(raw).toContain('private-decrypt-material');
    const storedSql = JSON.stringify(receipt, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    expect(storedSql).not.toContain('aGVsbG8='); expect(storedSql).not.toContain('private-decrypt-material');
    const channel = await admin.createChannel(), message = await channel.get(transportTopology(f.namespace).incoming, { noAck: false });
    expect(message).not.toBe(false);
    if (!message) throw new Error('Missing routed receipt');
    expect(JSON.parse(message.content.toString())).toEqual({ version: 1, receiptId: id });
    expect(message.properties.deliveryMode).toBe(2);
    channel.nack(message, false, true); await channel.close();
    expect((await stat(join(root, receipt.rawRef))).mode & 0o777).toBe(0o600);
  });
  it('gives each HTTP delivery a new receipt UUID; Rabbit redelivery retains the original UUID and one pending obligation', async () => {
    const f = await fixture();
    const responses = await Promise.all([f.submit(), f.submit()]);
    const ids = responses.map(r => r.json().receiptId); expect(new Set(ids).size).toBe(2);
    await f.consume();
    await until(() => db.ingressApplication.count({ where: { workspaceId: f.workspaceId } }), count => count === 2);
    await journal.publish(ids[0], f.publisher);
    await until(() => db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: ids[0] } }), r => r.state === 'pending_application');
    expect(await db.ingressApplication.count({ where: { workspaceId: f.workspaceId } })).toBe(2);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    expect(await db.ingressApplication.findMany({ where: { workspaceId: f.workspaceId } })).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'pending_application', appliedAt: null })]));
  });
  it('validates WAHA raw SHA512 once with exact session/physical source; metadata cannot select another workspace', async () => {
    const f = await fixture();
    const body = { id: 'waha-event', event: 'message.any', session: f.waha.sessionName, metadata: { workspaceId: 'untrusted', channelId: randomUUID() },
      payload: { id: `false_${peer}_stanza-A`, from: peer, fromMe: false, body: 'hello' } };
    const signature = createHmac('sha512', secret).update(JSON.stringify(body)).digest('hex');
    const headers = { 'x-webhook-hmac': signature, 'x-webhook-hmac-algorithm': 'sha512' };
    const path = `/webhooks/waha/${f.workspaceId}/${f.waha.id}`;
    expect((await f.submit(body, { ...headers, 'x-webhook-hmac-algorithm': 'sha256' }, path)).statusCode).toBe(401);
    expect((await f.submit({ ...body, id: 'tampered' }, headers, path)).statusCode).toBe(401);
    expect((await f.submit(body, { ...headers, 'x-webhook-hmac': [signature, signature] }, path)).statusCode).toBe(401);
    expect((await f.submit(body, headers, `/webhooks/waha/${f.workspaceId}/${f.evolution.id}`)).statusCode).toBe(409);
    const accepted = await f.submit(body, headers, path); expect(accepted.statusCode).toBe(202);
    const { receipt, payload } = await journal.readPayload(accepted.json().receiptId);
    expect(receipt.source).toMatchObject({ workspaceId: f.workspaceId, channelId: f.channel.id, connectionId: f.waha.id, sessionName: f.waha.sessionName });
    expect(payload.events[0]).toMatchObject({ kind: 'accepted', event: { key: { rawId: 'stanza-A', chatAddress: peer, direction: 'inbound' } } });
  });
  it('enforces direct Meta config/phoneNumber and connectionMode; retains customer timestamp for later application', async () => {
    const f = await fixture(), phoneNumberId = 'synthetic-meta-phone';
    await db.channel.create({ data: { workspaceId: f.workspaceId, provider: 'meta_cloud', providerKey: phoneNumberId } });
    const settings = { enabled: true, connectionMode: 'direct', phoneNumberId, wabaId: 'dummy', accessToken: 'not-persisted', appSecret: secret, webhookVerifyToken: secret };
    await db.integrationConfig.create({ data: { workspaceId: f.workspaceId, provider: 'meta_cloud', mode: 'real', status: 'connected', settings } });
    const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ id: 'wamid.exact', from: '15550001111', type: 'text', text: { body: 'hello' }, timestamp: '1700000000' }] } }] }] };
    const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}` };
    const response = await f.submit(body, headers, `/webhooks/meta/${f.workspaceId}`); expect(response.statusCode).toBe(202);
    expect((await journal.readPayload(response.json().receiptId)).payload.events[0]).toMatchObject({ kind: 'accepted', event: { context: { provider: 'meta_official' }, order: { timestampMs: 1700000000000 } } });
    const foreign = structuredClone(body); foreign.entry[0]!.changes[0]!.value.metadata.phone_number_id = 'foreign';
    expect((await f.submit(foreign, { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(JSON.stringify(foreign)).digest('hex')}` }, `/webhooks/meta/${f.workspaceId}`)).statusCode).toBe(400);
    await db.integrationConfig.update({ where: { workspaceId_provider: { workspaceId: f.workspaceId, provider: 'meta_cloud' } }, data: { settings: { ...settings, connectionMode: 'evolution_official' } } });
    expect((await f.submit(body, headers, `/webhooks/meta/${f.workspaceId}`)).statusCode).toBe(409);
  });
  it('does not return 2xx on mandatory return even when broker confirms publication positively', async () => {
    const f = await fixture(), channel = await admin.createChannel();
    await channel.unbindQueue(transportTopology(f.namespace).incoming, f.namespace, 'incoming');
    const response = await f.submit(); expect(response.statusCode).toBe(503);
    const receipt = await db.ingressReceipt.findFirstOrThrow({ where: { workspaceId: f.workspaceId }, include: { attempts: true, delivery: true } });
    expect(receipt.attempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'unroutable' });
    expect(receipt.delivery?.confirmedAt).toBe(null);
    await channel.bindQueue(transportTopology(f.namespace).incoming, f.namespace, 'incoming'); await channel.close();
    await db.ingressDelivery.update({ where: { receiptId: receipt.id }, data: { nextAttemptAt: new Date(0) } });
    expect(await journal.recover(f.publisher)).toBe(1);
    await f.consume();
    await until(() => db.ingressApplication.count({ where: { receiptId: receipt.id } }), n => n === 1);
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });
  it('waits the one publish after flow-control false; it neither republishes nor admits new work before drain', async () => {
    const f = await fixture(), original = f.publisher.channel.publish.bind(f.publisher.channel);
    const spy = vi.spyOn(f.publisher.channel, 'publish').mockImplementation((...args) => { original(...args); return false; });
    const response = await f.submit(); expect(response.statusCode).toBe(202); expect(spy).toHaveBeenCalledTimes(1);
    expect((await f.submit()).statusCode).toBe(503); expect(spy).toHaveBeenCalledTimes(1);
    f.publisher.channel.emit('drain'); spy.mockRestore();
    expect((await f.submit()).statusCode).toBe(202);
  });
  it('bounds confirmation deadline/inflight; late ACK cannot turn a 503 into acceptance or republish', async () => {
    const f = await fixture({ deadlineMs: 100, maxInflight: 1 });
    const original = f.publisher.channel.publish.bind(f.publisher.channel);
    let confirm: ((error: unknown) => void) | undefined;
    const spy = vi.spyOn(f.publisher.channel, 'publish').mockImplementation((exchange, route, content, options, callback) => {
      confirm = callback ? error => callback(error, {}) : undefined; return original(exchange, route, content, options, () => {});
    });
    const first = f.submit();
    await until(() => Promise.resolve(spy.mock.calls.length), n => n === 1);
    expect((await f.submit()).statusCode).toBe(503);
    expect((await first).statusCode).toBe(503); confirm?.(null); expect(spy).toHaveBeenCalledTimes(1);
    const row = await db.ingressReceipt.findFirstOrThrow({ where: { workspaceId: f.workspaceId }, include: { delivery: true } });
    expect(row.delivery?.confirmedAt).toBe(null); expect(f.publisher.alive).toBe(false);
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    spy.mockRestore();
  });
  it('retains source and pending application across logout/QR generation changes, and never grants current authorization', async () => {
    const f = await fixture(); const response = await f.submit(); const id = response.json().receiptId;
    await db.channelConnection.update({ where: { id: f.evolution.id }, data: { lifecycleGeneration: 3, sessionName: 'changed-after-acceptance' } });
    await f.consume(); await until(() => db.ingressApplication.count({ where: { receiptId: id } }), n => n === 1);
    expect((await db.ingressReceipt.findUniqueOrThrow({ where: { id } })).source).toMatchObject({ sessionName: f.evolution.sessionName, lifecycleGeneration: 0 });
    await expect(db.ingressReceipt.update({ where: { id }, data: { source: {} } })).rejects.toThrow('immutable ingress fact');
    const authorize = vi.fn(async () => { throw new Error('forbidden'); });
    await expect(journal.frontier({ workspaceId: f.workspaceId, channelId: f.channel.id, chatAddresses: [peer], authorize })).rejects.toThrow('forbidden');
    expect(authorize).toHaveBeenCalledOnce();
    const frontier = await journal.frontier({ workspaceId: f.workspaceId, channelId: f.channel.id, chatAddresses: [peer], authorize: async tx => { expect(await tx.channel.count({ where: { workspaceId: f.workspaceId, id: f.channel.id } })).toBe(1); } });
    expect(frontier).toHaveLength(1); expect(frontier[0]!.receipt.id).toBe(id);
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });
  it('publishes bounded retries and DLQ with confirms before ACK, then recovers the same receipt after private storage repair', async () => {
    const f = await fixture(); const response = await f.submit(); const id = response.json().receiptId;
    const receipt = await db.ingressReceipt.findUniqueOrThrow({ where: { id } });
    await rename(join(root, receipt.eventRef), join(root, `${receipt.eventRef}.held`));
    const consumer = await f.consume();
    await until(() => db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: id } }), r => r.state === 'dead_letter');
    expect(await db.ingressApplication.count({ where: { receiptId: id } })).toBe(0);
    const attempts = await db.ingressPublishAttempt.findMany({ where: { receiptId: id }, orderBy: { createdAt: 'asc' } });
    expect(attempts.map(a => [a.destination, a.outcome])).toEqual([['incoming','confirmed'],['retry','confirmed'],['retry','confirmed'],['dead','confirmed']]);
    const channel = await admin.createChannel();
    await until(() => channel.checkQueue(transportTopology(f.namespace).dead), q => q.messageCount === 1);
    await consumer.close();
    await rename(join(root, `${receipt.eventRef}.held`), join(root, receipt.eventRef));
    expect((await journal.recoverDeadLetter({ namespace: f.namespace, workspaceId: 'foreign', channelId: f.channel.id, receiptId: id })).count).toBe(0);
    const scope = { workspaceId: f.workspaceId, channelId: f.channel.id, receiptId: id };
    const otherNamespace = `talk.isolated.other_${randomUUID()}`;
    const beforeRecovery = await db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: id } });
    expect((await journal.recoverDeadLetter({ ...scope, namespace: otherNamespace })).count).toBe(0);
    await expect(journal.recoverDeadLetter({ ...scope, namespace: undefined as unknown as string })).rejects.toThrow('isolated Talk namespace');
    expect(await db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: id } })).toEqual(beforeRecovery);
    async function recoverCli(namespace: string) {
      const recovery = spawn(process.execPath, ['dist/ingress-recover.js', f.workspaceId, f.channel.id, id], { cwd: process.cwd(),
        env: { ...process.env, INGRESS_TRANSPORT_STAGE: 'isolated-1a', DATABASE_URL: databaseUrl, INGRESS_AMQP_URL: brokerUrl,
          INGRESS_NAMESPACE: namespace, INGRESS_PRIVATE_ROOT: root, INGRESS_WORKSPACE_ALLOWLIST: f.workspaceId }, stdio: 'pipe' });
      children.push(recovery);
      let output = ''; recovery.stdout?.on('data', data => { output += data; });
      await until(async () => recovery.exitCode, code => code !== null);
      expect(recovery.exitCode).toBe(0);
      return JSON.parse(output);
    }
    expect(await recoverCli(otherNamespace)).toMatchObject({ transportRecoveryQueued: false });
    expect(await db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: id } })).toEqual(beforeRecovery);
    expect(await recoverCli(f.namespace)).toMatchObject({ transportRecoveryQueued: true });
    const recovered = await db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: id } });
    expect(recovered).toMatchObject({ state: 'staged', failures: 0, recoveries: beforeRecovery.recoveries + 1 });
    expect((await journal.recoverDeadLetter({ ...scope, namespace: f.namespace })).count).toBe(0);
    expect(await recoverCli(f.namespace)).toMatchObject({ transportRecoveryQueued: false });
    expect(await db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: id } })).toEqual(recovered);
    expect(await db.ingressReceipt.findUniqueOrThrow({ where: { id } })).toEqual(receipt);
    await journal.recover(f.publisher); await f.consume();
    await until(() => db.ingressApplication.count({ where: { receiptId: id } }), n => n === 1);
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    await channel.close();
  });
  it('requeues unACKed original channel deliveries and remains idempotent after commit-before-ACK failure', async () => {
    const f = await fixture(); const response = await f.submit(), id = response.json().receiptId;
    const channel = await admin.createChannel();
    const delivery = await channel.get(transportTopology(f.namespace).incoming, { noAck: false }); expect(delivery).not.toBe(false);
    await journal.handoff(id); // committed sink, followed by simulated process/channel loss before ACK
    await channel.close();
    await f.consume();
    const queue = await admin.createChannel(); await until(() => queue.checkQueue(transportTopology(f.namespace).incoming), q => q.messageCount === 0);
    expect(await db.ingressApplication.count({ where: { receiptId: id } })).toBe(1);
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    await queue.close();
  });
  it('separates exact chat frontiers, including groups/LID and provider identity, without text/time dedup', async () => {
    const f = await fixture();
    const lid = '777000111@lid', group = '120000-100@g.us';
    for (const chat of [peer, lid, group]) {
      const body = structuredClone(f.envelope);
      body.data.key.remoteJid = chat;
      Object.assign(body.data.key, chat === group ? { participant: peer } : chat === lid ? { remoteJidAlt: peer } : {});
      expect((await f.submit(body)).statusCode).toBe(202);
    }
    const read = (chat: string) => journal.frontier({ workspaceId: f.workspaceId, channelId: f.channel.id, chatAddresses: [chat], authorize: async tx => { await tx.channel.findFirstOrThrow({ where: { workspaceId: f.workspaceId, id: f.channel.id } }); } });
    expect(await read(peer)).toHaveLength(1); expect(await read(lid)).toHaveLength(1); expect(await read(group)).toHaveLength(1);
    expect((await read(group))[0]!.exactKey).toMatchObject({ chatAddress: group, senderParticipant: peer, rawId: 'stanza-A' });
  });
  it('preserves staged receipts when publish fails, recovers concurrently without inserting another original', async () => {
    const f = await fixture();
    const spy = vi.spyOn(f.publisher, 'publish').mockRejectedValueOnce(new Error('transport failed before confirmation'));
    expect((await f.submit()).statusCode).toBe(503); spy.mockRestore();
    const receipt = await db.ingressReceipt.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    await db.ingressDelivery.update({ where: { receiptId: receipt.id }, data: { nextAttemptAt: new Date(0) } });
    const results = await Promise.all([journal.recover(f.publisher), journal.recover(f.publisher)]);
    expect(results.reduce((a,b) => a+b, 0)).toBe(1);
    await f.consume(); await until(() => db.ingressApplication.count({ where: { receiptId: receipt.id } }), n => n === 1);
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });
  it('retires blocked/closed sessions and permits explicit reconnection without republishing the same attempt', async () => {
    const f = await fixture(); f.publisher.model.emit('blocked', 'synthetic resource alarm');
    expect((await f.submit()).statusCode).toBe(503);
    const next = await ConfirmedIngressPublisher.connect(brokerUrl!, f.namespace); publishers.push(next);
    expect(next.ready).toBe(true);
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });

  async function sqlFault(table: 'ingress_receipts' | 'ingress_deliveries' | 'ingress_publish_attempts', workspaceId: string, predicate: string) {
    const name = `ingress_test_${randomUUID().replaceAll('-', '')}`;
    // All identifiers/predicates below are test constants; workspaceId is generated UUID.
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${workspaceId}' AND (${predicate}) THEN RAISE EXCEPTION 'injected ingress SQL fault'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    return async () => { await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON ${table}`); await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`); };
  }
  it('rolls back stage on SQL failure without publishing, and releases its transaction before Rabbit I/O', async () => {
    const f = await fixture();
    const remove = await sqlFault('ingress_receipts', f.workspaceId, 'true');
    const spy = vi.spyOn(f.publisher, 'publish');
    try { expect((await f.submit()).statusCode).toBe(503); expect(spy).not.toHaveBeenCalled(); }
    finally { await remove(); spy.mockRestore(); }
    expect(await db.ingressReceipt.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    const original = f.publisher.publish.bind(f.publisher);
    const check = vi.spyOn(f.publisher, 'publish').mockImplementation(async (...args) => {
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '200ms'`);
        // Would time out if staging still owned the source row while waiting for Rabbit.
        await tx.$queryRaw`SELECT id FROM channel_connections WHERE id=${f.evolution.id}::uuid FOR UPDATE`;
      });
      return original(...args);
    });
    try { expect((await f.submit()).statusCode).toBe(202); } finally { check.mockRestore(); }
  });
  it('keeps accepted broker facts recoverable when SQL confirmation recording fails', async () => {
    const f = await fixture(), remove = await sqlFault('ingress_publish_attempts', f.workspaceId, "NEW.outcome = 'confirmed'");
    try { expect((await f.submit()).statusCode).toBe(503); } finally { await remove(); }
    const receipt = await db.ingressReceipt.findFirstOrThrow({ where: { workspaceId: f.workspaceId }, include: { delivery: true, attempts: true } });
    expect(receipt.delivery?.confirmedAt).toBe(null); expect(receipt.attempts[0]?.outcome).toBe('pending');
    await f.consume(); await until(() => db.ingressApplication.count({ where: { receiptId: receipt.id } }), n => n === 1);
    expect((await db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: receipt.id } })).consumedAt).toBeInstanceOf(Date);
  });
  it('rolls back application handoff and leaves original unACKed when retry is unroutable', async () => {
    const f = await fixture(); const response = await f.submit(), id = response.json().receiptId;
    const remove = await sqlFault('ingress_deliveries', f.workspaceId, "NEW.state = 'pending_application'");
    const channel = await admin.createChannel(), topology = transportTopology(f.namespace);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const handoff = journal.handoff.bind(journal);
    const hold = vi.spyOn(journal, 'handoff').mockImplementation(async receiptId => { await gate; return handoff(receiptId); });
    try {
      const consumer = await f.consume();
      await channel.unbindQueue(topology.retry, f.namespace, 'retry');
      release(); hold.mockRestore();
      await until(async () => consumer.alive, alive => !alive);
      expect(await db.ingressApplication.count({ where: { receiptId: id } })).toBe(0);
      await until(() => channel.checkQueue(topology.incoming), q => q.messageCount === 1);
      expect(await db.ingressPublishAttempt.findMany({ where: { receiptId: id, destination: 'retry' } })).toEqual([expect.objectContaining({ outcome: 'failed', errorCode: 'unroutable' })]);
    } finally { release(); hold.mockRestore(); await remove(); await channel.bindQueue(topology.retry, f.namespace, 'retry'); }
    await f.consume(); await until(() => db.ingressApplication.count({ where: { receiptId: id } }), n => n === 1); await channel.close();
  });
  it('recovers only its own persisted namespace and refuses cross-namespace publication', async () => {
    const a = await fixture(), b = await fixture();
    const ar = await a.submit(), br = await b.submit(), aId = ar.json().receiptId, bId = br.json().receiptId;
    await db.ingressDelivery.updateMany({ where: { receiptId: { in: [aId,bId] } }, data: { nextAttemptAt: new Date(0) } });
    expect(await journal.recover(a.publisher)).toBe(1);
    expect(await db.ingressPublishAttempt.count({ where: { receiptId: bId } })).toBe(1);
    await expect(journal.publish(bId, a.publisher)).rejects.toThrow('namespace mismatch');
    await expect(db.ingressApplication.create({ data: { receiptId: aId, workspaceId: b.workspaceId, channelId: b.channel.id } })).rejects.toMatchObject({ code: 'P2003' });
  });

  function silence(model: ChannelModel) {
    const stream = (model.connection as unknown as { stream: import('node:net').Socket }).stream;
    stream.removeAllListeners('readable');
    return stream;
  }
  it('force-closes a silent real publisher and settles close despite a missing AMQP CloseOk', async () => {
    const f = await fixture({ deadlineMs: 100 }), stream = silence(f.publisher.model);
    await expect(f.publisher.publish({ version: 1, receiptId: randomUUID() }, 'incoming')).rejects.toMatchObject({ code: 'publish_deadline' });
    const started = Date.now();
    await f.publisher.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stream.destroyed).toBe(true);
    await until(async () => stream.closed, closed => closed);
    await f.publisher.close(); // one teardown; repeated close cannot hang either
  });
  it('retires a silent consumer before draining and preserves late commits plus redelivery on the new channel', async () => {
    const f = await fixture(), response = await f.submit(), id = response.json().receiptId;
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const handoff = journal.handoff.bind(journal);
    const hold = vi.spyOn(journal, 'handoff').mockImplementationOnce(async receiptId => { arrived(); await gate; return handoff(receiptId); });
    try {
      const consumer = await f.consume(); await entered;
      const stream = silence(consumer.model), started = Date.now();
      await consumer.close();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(stream.destroyed).toBe(true);
      const adminChannel = await admin.createChannel();
      await until(() => adminChannel.checkQueue(transportTopology(f.namespace).incoming), q => q.consumerCount === 0 && q.messageCount === 1);
      expect(await db.ingressApplication.count({ where: { receiptId: id } })).toBe(0);
      await f.consume(); await until(() => db.ingressApplication.count({ where: { receiptId: id } }), n => n === 1);
      release(); await until(async () => hold.mock.settledResults[0]?.type, type => type === 'fulfilled');
      expect(await db.ingressApplication.count({ where: { receiptId: id } })).toBe(1);
      await adminChannel.close();
    } finally { release(); hold.mockRestore(); }
  }, 10000);
  it('replaces the actual runtime publisher after silence and bounds shutdown with both sessions silent', async () => {
    const f = await fixture(), response = await f.submit(), id = response.json().receiptId;
    const startedConsumers = vi.spyOn(IngressTransportConsumer, 'start');
    const config = readIngressEnvironment({ INGRESS_TRANSPORT_STAGE: 'isolated-1a', DATABASE_URL: databaseUrl, INGRESS_AMQP_URL: brokerUrl,
      INGRESS_NAMESPACE: f.namespace, INGRESS_PRIVATE_ROOT: root, INGRESS_WORKSPACE_ALLOWLIST: f.workspaceId });
    const runtime = await createIngressRuntime(config, true);
    try {
      await until(async () => runtime.publisher(), publisher => !!publisher?.ready);
      await until(() => db.ingressApplication.count({ where: { receiptId: id } }), n => n === 1);
      const previous = runtime.publisher()!, oldSocket = silence(previous.model);
      await expect(runtime.journal.publish(id, previous)).rejects.toMatchObject({ code: 'publish_deadline' });
      const replacement = await until(async () => runtime.publisher(), publisher => !!publisher?.ready && publisher !== previous);
      expect(oldSocket.destroyed).toBe(true);
      await runtime.journal.publish(id, replacement!);
      const consumer = await startedConsumers.mock.results[0]!.value;
      const consumerSocket = silence(consumer.model), publisherSocket = silence(replacement!.model);
      const start = Date.now(); await runtime.close();
      expect(Date.now() - start).toBeLessThan(3000);
      expect(consumerSocket.destroyed).toBe(true); expect(publisherSocket.destroyed).toBe(true);
      expect(await db.ingressApplication.count({ where: { receiptId: id } })).toBe(1);
    } finally { await runtime.close(); startedConsumers.mockRestore(); }
  }, 10000);
  it('exits the built worker on SIGTERM while both real AMQP connections are silent', async () => {
    const f = await fixture(), response = await f.submit(), id = response.json().receiptId;
    const worker = spawn(process.execPath, ['src/modules/ingress/transport-lifecycle-child.fixture.mjs'], { cwd: process.cwd(),
      env: { ...process.env, INGRESS_TRANSPORT_STAGE: 'isolated-1a', DATABASE_URL: databaseUrl, INGRESS_AMQP_URL: brokerUrl,
        INGRESS_NAMESPACE: f.namespace, INGRESS_PRIVATE_ROOT: root, INGRESS_WORKSPACE_ALLOWLIST: f.workspaceId }, stdio: ['ignore','pipe','pipe','ipc'] });
    children.push(worker);
    let ready = false, silenced = 0;
    worker.on('message', message => { const event = message as { ready?: boolean; silenced?: number }; ready ||= event.ready === true; silenced = event.silenced ?? silenced; });
    await until(async () => ready, value => value);
    await until(() => db.ingressApplication.count({ where: { receiptId: id } }), n => n === 1);
    worker.send('silence'); await until(async () => silenced, n => n === 2);
    const start = Date.now(); worker.kill('SIGTERM');
    await until(async () => worker.exitCode, code => code === 0, 3000);
    expect(Date.now() - start).toBeLessThan(3000);
    const channel = await admin.createChannel();
    await until(() => channel.checkQueue(transportTopology(f.namespace).incoming), q => q.consumerCount === 0); await channel.close();
  }, 10000);
  it('runs independent built ingress and worker processes, survives worker restart, and never starts API schedulers', async () => {
    const f = await fixture();
    const port = 42000 + Math.floor(Math.random() * 10000);
    const env = { ...process.env, INGRESS_TRANSPORT_STAGE: 'isolated-1a', DATABASE_URL: databaseUrl, INGRESS_AMQP_URL: brokerUrl,
      INGRESS_NAMESPACE: f.namespace, INGRESS_PRIVATE_ROOT: root, INGRESS_WORKSPACE_ALLOWLIST: f.workspaceId, INGRESS_EVOLUTION_SECRET: secret, INGRESS_PORT: String(port) };
    function launch(entry: string) {
      const child = spawn(process.execPath, [`dist/${entry}.js`], { cwd: process.cwd(), env, stdio: 'pipe' }); children.push(child);
      let output = ''; child.stdout?.on('data', chunk => { output += chunk; }); child.stderr?.on('data', chunk => { output += chunk; });
      return { child, output: () => output };
    }
    const ingress = launch('ingress');
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).status; } catch { return 0; } }, n => n === 200);
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/evolution/${f.workspaceId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-prymeira-talk-secret': secret }, body: JSON.stringify(f.envelope) });
    expect(response.status).toBe(202); const id = (await response.json() as { receiptId: string }).receiptId;
    const first = launch('ingress-worker');
    await until(() => db.ingressApplication.count({ where: { receiptId: id } }), n => n === 1);
    first.child.kill('SIGKILL'); await until(async () => first.child.signalCode, code => code !== null);
    await journal.publish(id, f.publisher);
    const second = launch('ingress-worker');
    await until(async () => second.output(), text => text.includes('pending_application'));
    const channel = await admin.createChannel(); await until(() => channel.checkQueue(transportTopology(f.namespace).incoming), q => q.messageCount === 0); await channel.close();
    expect(await db.ingressApplication.count({ where: { receiptId: id } })).toBe(1);
    expect(ingress.output()).toContain('canonical application is not connected');
    expect(await db.message.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    ingress.child.kill('SIGTERM'); second.child.kill('SIGTERM');
    await until(async () => [ingress.child.exitCode, second.child.exitCode], codes => codes.every(code => code === 0));
  }, 20000);
});
