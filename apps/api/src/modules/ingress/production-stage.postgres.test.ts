import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExactEvolutionMediaFixture } from '../../test/evolution-media-fixture.js';
import { transportTopology } from './broker.js';
import { type WahaMessage } from '../waha/waha.client.js';
import { historyDigest } from '../channels/history-memory-budget.js';
import { writeQualificationEvidence } from '../../test/qualification-evidence.js';

const databaseUrl = process.env.REHEARSAL_DATABASE_URL, brokerUrl = process.env.INGRESS_TEST_AMQP_URL;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'rehearsal-evolution-secret-123';
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); }
}

/** Rehearsal of the production stage with the compiled executables: real HTTP -> RabbitMQ -> worker -> PostgreSQL,
 * every workspace accepted, production guards active (no loopback or test-database shortcuts). */
describe.skipIf(!databaseUrl || !brokerUrl)('ingress in the production stage (rehearsal)', () => {
  let db: PrismaClient, root: string, evolutionApi: http.Server;
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const namespace = `talk.prod.rehearsal-${randomUUID().slice(0, 8)}`;
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  let workspaceId: string, instance: string, channelId: string, wahaSession: string, runtimeEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    if (new URL(databaseUrl!).hostname !== '127.0.0.1' || new URL(databaseUrl!).port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || new URL(databaseUrl!).pathname !== '/talk_rehearsal' || new URL(brokerUrl!).hostname !== '127.0.0.1' || new URL(brokerUrl!).port !== (process.env.TALK_TEST_AMQP_PORT ?? '56739') || decodeURIComponent(new URL(brokerUrl!).pathname) !== '/talk_test') throw new Error('Only the local rehearsal database is permitted');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    root = await realpath(await mkdtemp(join(tmpdir(), 'talk-prod-rehearsal-')));
    workspaceId = `rehearsal-${randomUUID()}`; instance = `inst-${randomUUID()}`;
    evolutionApi = createExactEvolutionMediaFixture({ sessionName: instance, key: { id: 'PROD-MEDIA-1', remoteJid: '700001@lid', remoteJidAlt: '15550001111@s.whatsapp.net', fromMe: false }, bytes: PNG }).server;
    await new Promise<void>(resolve => evolutionApi.listen(0, '127.0.0.1', resolve));
    const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: instance, status: 'connected' } });
    await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: instance, status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '15550008888' } });
    channelId = channel.id; wahaSession = `load-wa-${randomUUID()}`;
    await db.channelConnection.create({ data: { workspaceId, channelId, provider: 'waha', sessionName: wahaSession, status: 'connected', health: 'healthy', eligible: true, verifiedPhoneNumber: '15550008888', lastHealthyAt: new Date(), recoveredThroughAt: new Date(Date.now() - 600_000) } });
    const env = { ...process.env, DATABASE_URL: databaseUrl, INGRESS_TRANSPORT_STAGE: 'production', INGRESS_AMQP_URL: brokerUrl, INGRESS_NAMESPACE: namespace,
      INGRESS_PRIVATE_ROOT: join(root, 'ingress'), INGRESS_WORKSPACE_ALLOWLIST: '*', INGRESS_EVOLUTION_SECRET: SECRET, INGRESS_WAHA_SECRET: 'rehearsal-waha-secret-1234567', INGRESS_PORT: String(port),
      TALK_MEDIA_STORE_PATH: join(root, 'media'), EVOLUTION_API_BASE_URL: `http://127.0.0.1:${(evolutionApi.address() as { port: number }).port}`, EVOLUTION_API_KEY: 'test-only' };
    runtimeEnv = env;
    for (const entry of ['dist/ingress.js', 'dist/ingress-worker.js']) {
      const child = spawn(process.execPath, [entry], { cwd: process.cwd(), env, stdio: 'pipe' });
      children.push(child);
      child.stdout!.on('data', d => logs.push(`[${entry}] ${d}`)); child.stderr!.on('data', d => logs.push(`[${entry}!] ${d}`));
      child.on('error', error => logs.push(`[${entry}] spawn error: ${error.message}`));
      child.on('exit', (code, signal) => logs.push(`[${entry}] exit code=${code} signal=${signal}`));
    }
    let lastHealth = 'not requested';
    try {
      await until(async () => {
        if (children.some(child => child.exitCode !== null || child.signalCode !== null)) throw new Error('A compiled rehearsal process exited before readiness');
        const status = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
          .then(r => r.status).catch(error => { lastHealth = error.message; return 0; });
        if (status) lastHealth = `HTTP ${status}`;
        return status;
      }, status => status === 200);
    } catch (error) {
      const processes = children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
      throw new Error(`Production rehearsal startup failed (health=${lastHealth}, port=${port}, processes=${JSON.stringify(processes)}).\n${logs.join('').slice(-8000)}`, { cause: error });
    }
  }, 60_000);

  afterAll(async () => {
    if (process.env.DEBUG_REHEARSAL) console.log('LOGS', logs.join('').slice(-12000));
    for (const child of children) { if (child.exitCode === null) { child.kill('SIGTERM'); await until(async () => child.exitCode, v => v !== null).catch(() => child.kill('SIGKILL')); } }
    await new Promise<void>(resolve => evolutionApi.close(() => resolve()));
    const admin = await amqp.connect(brokerUrl!), ch = await admin.createChannel();
    const topology = transportTopology(namespace);
    for (const queue of [topology.incoming, topology.retry, topology.dead]) await ch.deleteQueue(queue).catch(() => undefined);
    await ch.deleteExchange(namespace).catch(() => undefined); await ch.close(); await admin.close();
    const where = { workspaceId };
    await db.ingressEffect.deleteMany({ where }); await db.ingressReceipt.deleteMany({ where });
    await db.canonicalChatAuthorityResolution.deleteMany({ where }); await db.canonicalAction.deleteMany({ where }); await db.canonicalRecipientReceipt.deleteMany({ where });
    await db.canonicalAddressEvidence.deleteMany({ where }); await db.canonicalObservation.deleteMany({ where });
    await db.canonicalNativeAlias.deleteMany({ where }); await db.canonicalMessageIdentity.deleteMany({ where });
    await db.canonicalChatMember.deleteMany({ where }); await db.canonicalChat.deleteMany({ where });
    await db.canonicalAddressAlias.deleteMany({ where }); await db.canonicalAddress.updateMany({ where, data: { redirectId: null } }); await db.canonicalAddress.deleteMany({ where });
    await db.channel.deleteMany({ where });
    await db.contact.deleteMany({ where: { workspaceId } });
    await db.$disconnect(); await rm(root, { recursive: true, force: true });
  }, 60_000);

  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-prymeira-talk-secret': SECRET }) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const upsert = (id: string, message: unknown) => ({ event: 'MESSAGES_UPSERT', instance, data: { key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Maria' } });

  it('refuses a wrong secret, and reports an unknown source instead of guessing', async () => {
    expect((await post(`/webhooks/evolution/${workspaceId}`, upsert('x', { conversation: 'oi' }), { 'x-prymeira-talk-secret': 'wrong-secret-value' })).status).toBe(401);
    expect((await post(`/webhooks/evolution/${workspaceId}`, { ...upsert('y', { conversation: 'oi' }), instance: 'unknown-instance' })).status).toBe(409);
  });

  it('accepts a webhook the legacy 1 MiB limit rejected (413), applies the message and stores its media', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 7)]).toString('base64');
    const response = await post(`/webhooks/evolution/${workspaceId}`, upsert('PROD-MEDIA-1', { base64: big, imageMessage: { url: 'https://media.invalid/expired', mimetype: 'image/png', caption: 'foto grande' } }));
    expect(response.status).toBe(202);
    const message = await until(() => db.message.findFirst({ where: { workspaceId, body: 'foto grande' } }), v => !!v);
    expect(message).toMatchObject({ type: 'image', direction: 'inbound', body: 'foto grande' });
    const stored = await until(() => db.messageMedia.findUnique({ where: { messageId: message!.id } }), v => v?.state === 'stored');
    expect(stored).toMatchObject({ mimeType: 'image/png', sourceKind: expect.stringMatching(/inline|evolution/) });
    expect(await db.ingressApplication.count({ where: { workspaceId, state: 'applied' } })).toBeGreaterThan(0);
    expect(await db.conversation.findFirst({ where: { workspaceId } })).toMatchObject({ unreadCount: 1 });
  });

  it('keeps every effect of an applied message as a durable obligation for the API process', async () => {
    await post(`/webhooks/evolution/${workspaceId}`, upsert('PROD-TEXT-1', { conversation: 'preciso de 10 chapas' }));
    const message = await until(() => db.message.findFirst({ where: { workspaceId, body: 'preciso de 10 chapas' } }), v => !!v);
    const kinds = (await db.ingressEffect.findMany({ where: { workspaceId, messageId: message!.id } })).map(effect => effect.kind);
    expect(kinds).toEqual(expect.arrayContaining(['realtime.message', 'realtime.conversation', 'assistant.message', 'agent.debounce', 'followup.activity', 'prospecting.inbound']));
  });
  it('qualifies 80 canonical / 160 dual-provider envelopes in 10 seconds with concurrent bounded recovery', async () => {
    const startedAt = new Date().toISOString(), prefix = `load-${randomUUID()}-`;
    const addresses = Array.from({ length: 2930 }, () => ({ id: randomUUID(), workspaceId, channelId }));
    await db.canonicalAddress.createMany({ data: addresses });
    await db.canonicalAddressAlias.createMany({ data: addresses.map((a, i) => ({ workspaceId, channelId, addressId: a.id, address: `${15551000000 + i}@s.whatsapp.net` })) });
    const recoveryConnections = [await db.channelConnection.findFirstOrThrow({ where: { workspaceId, provider: 'waha' } })];
    for (let i = 0; i < 2; i++) {
      const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), historyImportStatus: 'completed', verifiedMessagingPhoneNumber: '15550008888' } });
      recoveryConnections.push(await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: randomUUID(), status: 'connected', eligible: true, health: 'healthy', verifiedPhoneNumber: '15550008888', lastHealthyAt: new Date(), recoveredThroughAt: new Date(Date.now() - 600_000) } }));
    }
    const recoveryAt = Math.floor((Date.now() - 500_000) / 1000);
    let versionRequests = 0, firstSweepFinishedAt = 0;
    const counts = new Map<string, number>(), recoveredIds = recoveryConnections.map((c, i) => `${prefix}recovery-${i}`);
    const provider = http.createServer((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/server/version') { versionRequests++; return response.end(JSON.stringify({ engine: 'GOWS' })); }
      const session = decodeURIComponent(url.pathname.split('/')[2]!);
      const connectionIndex = recoveryConnections.findIndex(c => c.sessionName === session);
      if (connectionIndex < 0) { response.statusCode = 404; return response.end('{}'); }
      counts.set(session, (counts.get(session) ?? 0) + 1);
      const offset = Number(url.searchParams.get('offset'));
      const rows: WahaMessage[] = offset ? [] : [{ id: `false_15550001111@c.us_${recoveredIds[connectionIndex]}`, from: '15550001111@c.us', fromMe: false, body: 'synthetic recovered fixture', timestamp: recoveryAt }];
      response.setHeader('x-talk-recovery-pagination', '1'); response.setHeader('x-talk-recovery-raw-digest', historyDigest(rows));
      response.setHeader('x-talk-recovery-raw-count', String(rows.length)); response.setHeader('x-talk-recovery-next-offset', String(offset + rows.length)); response.setHeader('x-talk-recovery-exhausted', String(rows.length === 0));
      setTimeout(() => response.end(JSON.stringify(rows)), 100);
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    await db.channelConnection.updateMany({ where: { workspaceId, provider: 'evolution' }, data: { historyRecoveryNextAttemptAt: new Date(Date.now() + 120_000) } });
    const previousWorker = children[1]!; previousWorker.kill('SIGTERM'); await until(async () => previousWorker.exitCode, value => value !== null);
    runtimeEnv = { ...runtimeEnv, INGRESS_WORKSPACE_ALLOWLIST: workspaceId, INGRESS_RECOVERY_ENABLED: 'true',
      WAHA_API_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, WAHA_API_KEY: 'synthetic-only' };
    const recoveryWorker = spawn(process.execPath, ['dist/ingress-worker.js'], { cwd: process.cwd(), env: runtimeEnv, stdio: 'pipe' }); children.push(recoveryWorker);
    recoveryWorker.stdout!.on('data', data => { const value = String(data); logs.push(value); if (!firstSweepFinishedAt && value.includes('Ingress background summary')) firstSweepFinishedAt = Date.now(); }); recoveryWorker.stderr!.on('data', data => logs.push(String(data)));
    await until(async () => counts.size, count => count > 0, 40_000);
    const receiptSentAt = new Map<string, number>();
    const acceptMs: number[] = [], sentAt = new Map<string, number>(), resources: Array<{ elapsedMs: number; cpuPercent: number; rssKiB: number }> = [];
    const began = Date.now(), applicationObservedAt = new Map<string, number>();
    let observingStopped = false;
    const observing = (async () => { while (!observingStopped) {
      if (receiptSentAt.size) {
        const visible = await db.ingressApplication.findMany({ where: { workspaceId, receiptId: { in: [...receiptSentAt.keys()] }, state: 'applied' }, select: { receiptId: true } });
        const at = Date.now(); for (const row of visible) if (!applicationObservedAt.has(row.receiptId)) applicationObservedAt.set(row.receiptId, at);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } })();
    const sampler = setInterval(() => {
      try {
        const values = execFileSync('ps', ['-o', 'time=,rss=', '-p', [process.pid, ...children.filter(c => c.exitCode === null && c.pid).map(c => c.pid)].join(',')], { encoding: 'utf8' }).trim().split('\n').map(row => { const [time, rss] = row.trim().split(/\s+/); const parts = time!.split(':').map(Number); return [parts.reduce((seconds, part) => seconds*60+part, 0), Number(rss)]; });
        resources.push({ elapsedMs: Date.now() - began, cpuPercent: values.reduce((n, row) => n + row[0]!, 0), rssKiB: values.reduce((n, row) => n + row[1]!, 0) });
      } catch { /* A restarting process can disappear between ps and the sample. */ }
    }, 250);
    let sweepMs = 0, overlapEndMs = 0, firstTurnRuntimeRecovered = 0;
    const recovery = (async () => {
      const summary = await until(async () => logs.join('').match(/gaps:\s*\{[\s\S]*?maxMs:\s*(\d+)/), value => !!value && firstSweepFinishedAt > 0, 10_000);
      sweepMs = Number(summary![1]); firstTurnRuntimeRecovered = Number(logs.join('').match(/gaps:\s*\{[\s\S]*?counts:\s*\{\s*recovered:\s*(\d+)/)?.[1] ?? -1); expect(firstTurnRuntimeRecovered).toBeGreaterThanOrEqual(0); overlapEndMs = firstSweepFinishedAt - began;
    })();
    try {
      for (let i = 0; i < 80; i++) {
        const scheduled = began + i * 125; if (Date.now() < scheduled) await new Promise(resolve => setTimeout(resolve, scheduled - Date.now()));
        const id = `${prefix}${i}`, timestamp = Math.floor(Date.now() / 1000); sentAt.set(id, Date.now());
        const evo = upsert(id, { conversation: 'synthetic controlled load' });
        const wa = { event: 'message.any', session: wahaSession, payload: { id: `false_15550001111@c.us_${id}`, from: '15550001111@c.us', fromMe: false, body: 'synthetic controlled load', timestamp } };
        await Promise.all([
          (async () => { const at = Date.now(); const response = await post(`/webhooks/evolution/${workspaceId}`, evo); expect(response.status).toBe(202); receiptSentAt.set((await response.json() as { receiptId: string }).receiptId, at); acceptMs.push(Date.now() - at); })(),
          (async () => { const at = Date.now(); const bytes = JSON.stringify(wa); const response = await post(`/webhooks/waha/${workspaceId}`, wa, { 'x-webhook-hmac-algorithm': 'sha512', 'x-webhook-hmac': createHmac('sha512', 'rehearsal-waha-secret-1234567').update(bytes).digest('hex') }); expect(response.status).toBe(202); receiptSentAt.set((await response.json() as { receiptId: string }).receiptId, at); acceptMs.push(Date.now() - at); })()
        ]);
      }
      if (Date.now() < began + 10_000) await new Promise(resolve => setTimeout(resolve, began + 10_000 - Date.now()));
      const trafficDurationMs = Date.now() - began;
      clearInterval(sampler);
      await recovery;
      const firstTurnCounts = new Map(counts);
      const yielded = await db.channelConnection.findMany({ where: { id: { in: recoveryConnections.map(c => c.id) } }, select: { id: true, historyRecoveryFailures: true, recoveredThroughAt: true, historyRecoveryNextAttemptAt: true, historyRecoveryLeaseUntil: true, historyRecoveryCursor: true } });
      const firstTurnYields = (logs.join('').match(/Provider gap_recovery step failed/g) ?? []).length;
      expect(firstTurnYields).toBeLessThanOrEqual(3);
      const failureBlocks = logs.join('').split('Provider gap_recovery step failed').slice(1).map(block => block.split(/\r?\n}\r?\n/)[0]!);
      expect(failureBlocks).toHaveLength(firstTurnYields);
      for (const block of failureBlocks) expect(block).toContain('55P03');
      const isAdvanced = (c: typeof yielded[number]) => c.recoveredThroughAt!.getTime() > recoveryConnections.find(original => original.id === c.id)!.recoveredThroughAt!.getTime();
      const intactCheckpoints = yielded.map(c => ({ before: recoveryConnections.find(original => original.id === c.id)!.recoveredThroughAt?.toISOString(), after: c.recoveredThroughAt?.toISOString(), nextAttemptAt: c.historyRecoveryNextAttemptAt?.toISOString() }));
      const intact = yielded.every(c => isAdvanced(c) || (c.recoveredThroughAt!.getTime() === recoveryConnections.find(original => original.id === c.id)!.recoveredThroughAt!.getTime() && ((c.historyRecoveryNextAttemptAt && c.historyRecoveryNextAttemptAt.getTime() > began) || (!c.historyRecoveryNextAttemptAt && !c.historyRecoveryLeaseUntil && c.historyRecoveryFailures === 0 && c.historyRecoveryCursor === null))));
      expect(intact, JSON.stringify({ began, intactCheckpoints })).toBe(true);
      const firstTurnRecovered = await db.canonicalMessageIdentity.count({ where: { workspaceId, rawId: { in: recoveredIds } } });
      // Only the synthetic fixture's due time is changed. The compiled runtime's next
      // scheduled turn must resume persisted metadata after contention has ended.
      await db.channelConnection.updateMany({ where: { id: { in: recoveryConnections.map(c => c.id) } }, data: { historyRecoveryNextAttemptAt: null } });
      await until(() => db.channelConnection.count({ where: { id: { in: recoveryConnections.map(c => c.id) }, historyRecoveryFailures: 0, recoveredThroughAt: { gt: new Date(Date.now() - 550_000) } } }), count => count === 3, 40_000);
      const identities = await until(() => db.canonicalMessageIdentity.findMany({ where: { workspaceId, rawId: { startsWith: prefix } }, include: { message: true } }), rows => rows.length === 83);
      const actual = identities.map(i => i.rawId).sort(), expected = [...sentAt.keys(), ...recoveredIds].sort(); expect(actual).toEqual(expected);
      const appliedProgress = await until(() => db.ingressEventProgress.findMany({ where: { workspaceId, receiptId: { in: [...receiptSentAt.keys()] } }, select: { receiptId: true, committedAt: true, state: true } }), rows => rows.length === 160);
      expect(appliedProgress.every(p => p.state !== 'held')).toBe(true);
      await until(async () => applicationObservedAt.size, count => count === 160);
      const applicationMs = appliedProgress.map(p => applicationObservedAt.get(p.receiptId)! - receiptSentAt.get(p.receiptId)!);
      const overlapProgress = appliedProgress.filter(p => receiptSentAt.get(p.receiptId)! <= began + overlapEndMs);
      expect(overlapProgress.length).toBeGreaterThan(10);
      const percentile = (rows: number[], q: number) => [...rows].sort((a,b) => a-b)[Math.ceil(rows.length*q)-1]!;
      const ingressP95Ms = percentile(acceptMs, .95), applicationP95Ms = percentile(applicationMs, .95);
      expect(acceptMs).toHaveLength(160); expect(ingressP95Ms).toBeLessThan(500); expect(applicationP95Ms).toBeLessThan(2000);
      const overlapApplicationP95Ms = percentile(overlapProgress.map(p => applicationObservedAt.get(p.receiptId)! - receiptSentAt.get(p.receiptId)!), .95); expect(overlapApplicationP95Ms).toBeLessThan(2000);
      expect(sweepMs).toBeLessThan(6500); expect((logs.join('').match(/Provider gap_recovery step failed/g) ?? []).length).toBe(firstTurnYields); expect(counts.size).toBe(3);
      const perTurnRequests = [...counts].map(([session, total]) => Math.max(firstTurnCounts.get(session) ?? 0, total - (firstTurnCounts.get(session) ?? 0)));
      for (const count of perTurnRequests) expect(count).toBeLessThanOrEqual(4);
      const historical = await db.ingressEffect.findMany({ where: { workspaceId, messageId: { in: identities.filter(i => recoveredIds.includes(i.rawId)).map(i => i.messageId) } } });
      expect(historical).toHaveLength(6); expect(historical.every(e => ['realtime.message','realtime.conversation'].includes(e.kind) && e.receiptId === null)).toBe(true);
      const before = await db.ingressEffect.count({ where: { workspaceId } });
      const worker = recoveryWorker; worker.kill('SIGTERM'); await until(async () => worker.exitCode, value => value !== null);
      const restarted = spawn(process.execPath, ['dist/ingress-worker.js'], { cwd: process.cwd(), env: runtimeEnv, stdio: 'pipe' }); children.push(restarted);
      restarted.stdout!.on('data', data => logs.push(String(data))); restarted.stderr!.on('data', data => logs.push(String(data)));
      const duplicate = await post(`/webhooks/evolution/${workspaceId}`, upsert(`${prefix}0`, { conversation: 'synthetic controlled load' })); expect(duplicate.status).toBe(202);
      const duplicateReceipt = (await duplicate.json() as { receiptId: string }).receiptId;
      await until(() => db.ingressApplication.findUnique({ where: { receiptId: duplicateReceipt } }), application => application?.state === 'applied');
      expect(await db.canonicalMessageIdentity.count({ where: { workspaceId, rawId: { startsWith: prefix } } })).toBe(83);
      expect(await db.ingressEffect.count({ where: { workspaceId } })).toBe(before);
      expect(resources.length).toBeGreaterThan(10);
      expect(trafficDurationMs).toBeGreaterThanOrEqual(10_000); expect(trafficDurationMs).toBeLessThan(11_000);
      const cpuWindowSeconds = resources.at(-1)!.cpuPercent - resources[0]!.cpuPercent;
      const resourceDurationMs = resources.at(-1)!.elapsedMs - resources[0]!.elapsedMs;
      await writeQualificationEvidence('load', startedAt, { canonicalMessages: 80, dualProviderEnvelopes: 160, oracleIdentities: 83, canonicalAddresses: 2930,
        durationMs: Date.now()-began, trafficDurationMs, ingressP95Ms, applicationP95Ms, applicationClock: 'client send to first externally observed applied receipt (25 ms polling upper bound)', overlapEnvelopes: overlapProgress.length, overlapApplicationP95Ms, recovery: { connections: 3, sweepMs, timingSource: 'existing compiled runtime sweep-observer gaps.maxMs', overlapEndMs, requestsPerConnection: perTurnRequests, observedContentionYields: firstTurnYields, firstTurnAdvancedConnections: yielded.filter(isAdvanced).length, firstTurnClaimedBackoffConnections: yielded.filter(c => !isAdvanced(c) && !!c.historyRecoveryNextAttemptAt).length, untouchedConnectionsAfterContention: yielded.filter(c => !c.historyRecoveryNextAttemptAt && !c.historyRecoveryLeaseUntil).length, firstTurnPersistedIdentities: firstTurnRecovered, firstTurnRuntimeRecovered, fixtureOnlyRescheduledNextAttempt: true, backoffAndResumeProved: true, unexpectedFailures: 0, providerHttp: { pageReads: [...counts.values()].reduce((a,b)=>a+b,0), versionProbes: versionRequests, lidLookups: 0, total: [...counts.values()].reduce((a,b)=>a+b,0) + versionRequests }, executor: 'compiled ingress-worker runtime loop on same event loop as application', historicalEffects: historical.length, autonomousHistoricalEffects: 0 },
        restartDuplicatePreserved: true, resources: { sampleIntervalMs: 250, sampleCount: resources.length, durationMs: resources.at(-1)!.elapsedMs, method: 'ps cumulative CPU time delta over sampled traffic window and RSS KiB summed across ingress/worker children and test parent; time resolution <=1 second', baseline: { rssKiB: resources[0]!.rssKiB }, cpuWindowSeconds, averageCpuPercent: cpuWindowSeconds / (resourceDurationMs/1000) * 100, maximumRssKiB: Math.max(...resources.map(r => r.rssKiB)) } });
    } finally { observingStopped = true; await observing; clearInterval(sampler); await recovery; await new Promise<void>(resolve => provider.close(() => resolve())); }
  }, 90_000);

});
