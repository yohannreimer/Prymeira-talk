import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { availableParallelism, freemem, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExactEvolutionMediaFixture } from '../src/test/evolution-media-fixture.js';
import { transportTopology } from '../src/modules/ingress/broker.js';
import { type WahaMessage } from '../src/modules/waha/waha.client.js';
import { historyDigest } from '../src/modules/channels/history-memory-budget.js';

const databaseUrl = process.env.REHEARSAL_DATABASE_URL, brokerUrl = process.env.INGRESS_TEST_AMQP_URL;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'rehearsal-evolution-secret-123';
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); }
}

/** Rehearsal of the production stage with the compiled executables: real HTTP -> RabbitMQ -> worker -> PostgreSQL,
 * every workspace accepted, production guards active (no loopback or test-database shortcuts). */
describe.skipIf(!databaseUrl || !brokerUrl)('isolated matched VPS comparison (diagnostic only)', () => {
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
    await mkdir(join(process.cwd(), '../../validation-artifacts'), { recursive: true });
    await writeFile(join(process.cwd(), '../../validation-artifacts/runtime.log'), logs.join(''));
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
  it('observes the fixed 80 canonical / 160 envelope load without release approval', async () => {
    const diagnosticControl = process.env.TALK_LOAD_DIAGNOSTIC_RECOVERY === 'disabled';
    if (process.env.TALK_VALIDATION_RUN_ID) throw new Error('Recovery-disabled diagnostic control cannot run as qualification');
    const startedAt = new Date().toISOString(), prefix = `load-${randomUUID()}-`;
    const addresses = Array.from({ length: 2930 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12,'0')}`, workspaceId, channelId }));
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
    const recoveryMessages: WahaMessage[] = recoveredIds.map(id => ({ id: `false_15550001111@c.us_${id}`, from: '15550001111@c.us', fromMe: false, body: 'synthetic recovered fixture', timestamp: recoveryAt }));
    const provider = http.createServer((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/server/version') { versionRequests++; return response.end(JSON.stringify({ engine: 'GOWS' })); }
      const session = decodeURIComponent(url.pathname.split('/')[2]!);
      const connectionIndex = recoveryConnections.findIndex(c => c.sessionName === session);
      if (connectionIndex < 0) { response.statusCode = 404; return response.end('{}'); }
      counts.set(session, (counts.get(session) ?? 0) + 1);
      const offset = Number(url.searchParams.get('offset'));
      const rows: WahaMessage[] = offset ? [] : [recoveryMessages[connectionIndex]!];
      response.setHeader('x-talk-recovery-pagination', '1'); response.setHeader('x-talk-recovery-raw-digest', historyDigest(rows));
      response.setHeader('x-talk-recovery-raw-count', String(rows.length)); response.setHeader('x-talk-recovery-next-offset', String(offset + rows.length)); response.setHeader('x-talk-recovery-exhausted', String(rows.length === 0));
      setTimeout(() => response.end(JSON.stringify(rows)), 100);
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    await db.channelConnection.updateMany({ where: { workspaceId, provider: 'evolution' }, data: { historyRecoveryNextAttemptAt: new Date(Date.now() + 120_000) } });
    const previousWorker = children[1]!; previousWorker.kill('SIGTERM'); await until(async () => previousWorker.exitCode, value => value !== null);
    runtimeEnv = { ...runtimeEnv, INGRESS_WORKSPACE_ALLOWLIST: workspaceId, INGRESS_RECOVERY_ENABLED: diagnosticControl ? 'false' : 'true',
      WAHA_API_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, WAHA_API_KEY: 'synthetic-only' };
    const recoveryWorker = spawn(process.execPath, ['dist/ingress-worker.js'], { cwd: process.cwd(), env: runtimeEnv, stdio: 'pipe' }); children.push(recoveryWorker);
    recoveryWorker.stdout!.on('data', data => { const value = String(data); logs.push(value); if (!firstSweepFinishedAt && value.includes('Ingress background summary')) firstSweepFinishedAt = Date.now(); }); recoveryWorker.stderr!.on('data', data => logs.push(String(data)));
    if (diagnosticControl) await new Promise(resolve => setTimeout(resolve, 30_000));
    else await until(async () => counts.size, count => count > 0, 40_000);
    const receiptSentAt = new Map<string, number>();
    const envelopeDetails = new Map<string, { sequence: number; provider: 'evolution' | 'waha'; sentAt: number; acceptedAt: number }>();
    const applicationFinalizedAt = new Map<string, number>(), pollTimings: Array<{ startMs: number; durationMs: number; gapMs: number | null; requested: number; visible: number }> = [];
    let previousPollStartedAt: number | null = null;
    const acceptMs: number[] = [], sentAt = new Map<string, number>(), resources: Array<{ elapsedMs: number; cpuPercent: number; rssKiB: number; processes: Array<{ role: string; cpuSeconds: number; rssKiB: number }> }> = [];
    const hostBefore = { loadAverage: loadavg(), freeBytes: freemem(), availableParallelism: availableParallelism() };
    const began = Date.now(), applicationObservedAt = new Map<string, number>();
    let observingStopped = false;
    const observing = (async () => { while (!observingStopped) {
      if (receiptSentAt.size) {
        const pollStartedAt = Date.now(), requested = receiptSentAt.size;
        const visible = await db.ingressApplication.findMany({ where: { workspaceId, receiptId: { in: [...receiptSentAt.keys()] }, state: 'applied' }, select: { receiptId: true, appliedAt: true } });
        const at = Date.now();
        if (pollStartedAt - began < 15_000) pollTimings.push({ startMs: pollStartedAt - began, durationMs: at-pollStartedAt, gapMs: previousPollStartedAt === null ? null : pollStartedAt-previousPollStartedAt, requested, visible: visible.length });
        previousPollStartedAt = pollStartedAt;
        for (const row of visible) if (!applicationObservedAt.has(row.receiptId)) { applicationObservedAt.set(row.receiptId, at); if (row.appliedAt) applicationFinalizedAt.set(row.receiptId, row.appliedAt.getTime()); }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } })();
    const sampler = setInterval(() => {
      try {
        const values = execFileSync('ps', ['-o', 'pid=,time=,rss=', '-p', [process.pid, ...children.filter(c => c.exitCode === null && c.pid).map(c => c.pid)].join(',')], { encoding: 'utf8' }).trim().split('\n').map(row => {
          const [pid, time, rss] = row.trim().split(/\s+/), parts = time!.split(':').map(Number);
          return { role: Number(pid) === process.pid ? 'test-observer' : Number(pid) === children[0]?.pid ? 'ingress' : 'application-recovery-worker', cpuSeconds: parts.reduce((seconds, part) => seconds*60+part, 0), rssKiB: Number(rss) };
        });
        resources.push({ elapsedMs: Date.now() - began, cpuPercent: values.reduce((n, row) => n + row.cpuSeconds, 0), rssKiB: values.reduce((n, row) => n + row.rssKiB, 0), processes: values });
      } catch { /* A restarting process can disappear between ps and the sample. */ }
    }, 250);
    let sweepMs = 0, overlapEndMs = 0, firstTurnRuntimeRecovered = 0;
    const recovery = (async () => {
      if (diagnosticControl) return;
      const summary = await until(async () => logs.join('').match(/gaps:\s*\{[\s\S]*?maxMs:\s*(\d+)/), value => !!value && firstSweepFinishedAt > 0, 30_000);
      sweepMs = Number(summary![1]); firstTurnRuntimeRecovered = Number(logs.join('').match(/gaps:\s*\{[\s\S]*?counts:\s*\{\s*recovered:\s*(\d+)/)?.[1] ?? -1); expect(firstTurnRuntimeRecovered).toBeGreaterThanOrEqual(0); overlapEndMs = firstSweepFinishedAt - began;
    })();
    try {
      for (let i = 0; i < 80; i++) {
        const scheduled = began + i * 125; if (Date.now() < scheduled) await new Promise(resolve => setTimeout(resolve, scheduled - Date.now()));
        const id = `${prefix}${i}`, timestamp = Math.floor(Date.now() / 1000); sentAt.set(id, Date.now());
        const evo = upsert(id, { conversation: 'synthetic controlled load' });
        const wa = { event: 'message.any', session: wahaSession, payload: { id: `false_15550001111@c.us_${id}`, from: '15550001111@c.us', fromMe: false, body: 'synthetic controlled load', timestamp } };
        await Promise.all([
          (async () => { const at = Date.now(); const response = await post(`/webhooks/evolution/${workspaceId}`, evo); expect(response.status).toBe(202); const receiptId = (await response.json() as { receiptId: string }).receiptId, acceptedAt = Date.now(); receiptSentAt.set(receiptId, at); envelopeDetails.set(receiptId, { sequence: i, provider: 'evolution', sentAt: at, acceptedAt }); acceptMs.push(acceptedAt - at); })(),
          (async () => { const at = Date.now(); const bytes = JSON.stringify(wa); const response = await post(`/webhooks/waha/${workspaceId}`, wa, { 'x-webhook-hmac-algorithm': 'sha512', 'x-webhook-hmac': createHmac('sha512', 'rehearsal-waha-secret-1234567').update(bytes).digest('hex') }); expect(response.status).toBe(202); const receiptId = (await response.json() as { receiptId: string }).receiptId, acceptedAt = Date.now(); receiptSentAt.set(receiptId, at); envelopeDetails.set(receiptId, { sequence: i, provider: 'waha', sentAt: at, acceptedAt }); acceptMs.push(acceptedAt - at); })()
        ]);
      }
      if (Date.now() < began + 10_000) await new Promise(resolve => setTimeout(resolve, began + 10_000 - Date.now()));
      const trafficDurationMs = Date.now() - began;
      await recovery;
      const firstTurnCounts = new Map(counts);
      const yielded = await db.channelConnection.findMany({ where: { id: { in: recoveryConnections.map(c => c.id) } }, select: { id: true, historyRecoveryFailures: true, recoveredThroughAt: true, historyRecoveryNextAttemptAt: true, historyRecoveryLeaseToken: true, historyRecoveryLeaseUntil: true, historyRecoveryCursor: true } });
      expect(yielded).toHaveLength(recoveryConnections.length);
      const firstTurnYields = (logs.join('').match(/Provider gap_recovery step failed/g) ?? []).length;
      const failureBlocks = logs.join('').split('Provider gap_recovery step failed').slice(1).map(block => block.split(/\r?\n}\r?\n/)[0]!);
      const contentionFailures = failureBlocks.map(block => ({ connectionId: block.match(/connectionId: '([a-f0-9-]+)'/)?.[1] ?? null,
        kind: block.includes('Unable to start a transaction') ? 'pool-acquire' : block.includes('55P03') ? 'lock-wait' : 'other',
        diagnostic: block.slice(0,3000) }));
      const isAdvanced = (c: typeof yielded[number]) => c.recoveredThroughAt!.getTime() > recoveryConnections.find(original => original.id === c.id)!.recoveredThroughAt!.getTime();
      const firstTurnRecovered = await db.canonicalMessageIdentity.count({ where: { workspaceId, rawId: { in: recoveredIds } } });
      // Only the synthetic fixture's due time is changed. The compiled runtime's next
      // scheduled turn must resume persisted metadata after contention has ended.
      const pendingConnections = yielded.filter(c => !isAdvanced(c));
      const laterTurnRequired = pendingConnections.length > 0;
      let laterTurnProgressProved: boolean | null = null;
      const identities = await until(() => db.canonicalMessageIdentity.findMany({ where: { workspaceId, rawId: { startsWith: prefix } }, include: { message: true } }), rows => [...sentAt.keys()].every(id => rows.some(row => row.rawId === id)), 120_000);
      const actual = identities.filter(i => sentAt.has(i.rawId)).map(i => i.rawId).sort(), expected = [...sentAt.keys()].sort(); expect(actual).toEqual(expected);
      const appliedProgress = await until(() => db.ingressEventProgress.findMany({ where: { workspaceId, receiptId: { in: [...receiptSentAt.keys()] } }, select: { receiptId: true, committedAt: true, state: true } }), rows => rows.length === 160, 120_000);
      expect(appliedProgress.every(p => p.state !== 'held')).toBe(true);
      await until(async () => applicationObservedAt.size, count => count === 160, 120_000);
      const applicationMs = appliedProgress.map(p => applicationObservedAt.get(p.receiptId)! - receiptSentAt.get(p.receiptId)!);
      const overlapProgress = appliedProgress.filter(p => receiptSentAt.get(p.receiptId)! <= began + overlapEndMs);

      const percentile = (rows: number[], q: number) => [...rows].sort((a,b) => a-b)[Math.ceil(rows.length*q)-1]!;
      const ingressP95Ms = percentile(acceptMs, .95), applicationP95Ms = percentile(applicationMs, .95);
      const overlapApplicationP95Ms = percentile(overlapProgress.map(p => applicationObservedAt.get(p.receiptId)! - receiptSentAt.get(p.receiptId)!), .95);
      const quantiles = (values: number[]) => values.length ? { count: values.length, p50: percentile(values, .5), p90: percentile(values, .9), p95: percentile(values, .95), p99: percentile(values, .99), max: Math.max(...values) } : { count: 0 };
      const envelopes = [...envelopeDetails].map(([receiptId, detail]) => ({ sequence: detail.sequence, provider: detail.provider, sentMs: detail.sentAt-began, acceptedMs: detail.acceptedAt-began,
        applicationFinalizedMs: applicationFinalizedAt.has(receiptId) ? applicationFinalizedAt.get(receiptId)!-began : null, firstObservedAppliedMs: applicationObservedAt.get(receiptId)!-began,
        ingressMs: detail.acceptedAt-detail.sentAt, applicationMs: applicationObservedAt.get(receiptId)!-detail.sentAt,
        applicationFinalizationMs: applicationFinalizedAt.has(receiptId) ? applicationFinalizedAt.get(receiptId)!-detail.sentAt : null,
        visibilityDelayMs: applicationFinalizedAt.has(receiptId) ? applicationObservedAt.get(receiptId)!-applicationFinalizedAt.get(receiptId)! : null,
        overlapsRecovery: detail.sentAt <= began+overlapEndMs })).sort((a,b) => a.sequence-b.sequence || a.provider.localeCompare(b.provider));
      const observations = { schemaVersion: 1, kind: 'matched-comparison-observations', observationsOnly: true, recoveryEnabled: !diagnosticControl, diagnosticControl,
        runtimeArtifacts: JSON.parse(process.env.TALK_COMPARE_RUNTIME_ARTIFACTS!), variant: process.env.TALK_COMPARE_VARIANT, slot: process.env.TALK_COMPARE_SLOT, diagnosticOnly: true, qualification: false,
        controllerSha: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(), controllerSourceState: execFileSync('git', ['status','--porcelain'], { encoding: 'utf8' }).trim() ? 'working-tree' : 'clean-checkout',
        harnessRunId: process.env.TALK_VALIDATION_RUN_ID ?? null, startedAt, observedAt: new Date().toISOString(), thresholds: { ingressP95Ms: 500, applicationP95Ms: 2000 },
        trafficDurationMs, oracleIdentities: identities.length, ingressMs: quantiles(acceptMs), applicationMs: quantiles(applicationMs),
        overlapApplicationMs: quantiles(envelopes.filter(e => e.overlapsRecovery).map(e => e.applicationMs)), postOverlapApplicationMs: quantiles(envelopes.filter(e => !e.overlapsRecovery).map(e => e.applicationMs)),
        perSecond: Array.from({ length: 10 }, (_, second) => { const interval = envelopes.filter(e => e.sentMs >= second*1000 && e.sentMs < (second+1)*1000); return { second, ingressMs: quantiles(interval.map(e => e.ingressMs)), applicationMs: quantiles(interval.map(e => e.applicationMs)) }; }),
        perProvider: ['evolution', 'waha'].map(provider => ({ provider, ingressMs: quantiles(envelopes.filter(e => e.provider === provider).map(e => e.ingressMs)), applicationMs: quantiles(envelopes.filter(e => e.provider === provider).map(e => e.applicationMs)) })),
        finalizationMs: quantiles(envelopes.flatMap(e => e.applicationFinalizationMs === null ? [] : [e.applicationFinalizationMs])), visibilityDelayMs: quantiles(envelopes.flatMap(e => e.visibilityDelayMs === null ? [] : [e.visibilityDelayMs])),
        pollQueryMs: quantiles(pollTimings.map(p => p.durationMs)), pollGapMs: quantiles(pollTimings.flatMap(p => p.gapMs === null ? [] : [p.gapMs])),
        sweep: { totalMs: sweepMs, overlapEndMs, observedContentionYields: firstTurnYields, contentionFailures, advancedConnections: yielded.filter(isAdvanced).length, claimedBackoffConnections: yielded.filter(c => !isAdvanced(c) && !!c.historyRecoveryNextAttemptAt).length,
          untouchedConnections: yielded.filter(c => !c.historyRecoveryNextAttemptAt && !c.historyRecoveryLeaseUntil).length, firstTurnRuntimeRecovered, firstTurnPersistedIdentities: firstTurnRecovered, laterTurnRequired, laterTurnProgressProved },
        hostBefore, hostAtObservation: { loadAverage: loadavg(), freeBytes: freemem() }, resources, envelopes, pollTimings };
      const diagnosticPath = join(process.cwd(), '../../validation-artifacts', `load-observations-${Date.now()}.json`); await mkdir(join(process.cwd(), '../../validation-artifacts'), { recursive: true });
      await writeFile(diagnosticPath, JSON.stringify(observations, null, 2));
      console.info('SYNTHETIC_LOAD_OBSERVATIONS', JSON.stringify({ file: diagnosticPath, ingressMs: observations.ingressMs, applicationMs: observations.applicationMs, overlapApplicationMs: observations.overlapApplicationMs, visibilityDelayMs: observations.visibilityDelayMs, pollQueryMs: observations.pollQueryMs, pollGapMs: observations.pollGapMs, sweep: observations.sweep }));
      expect(acceptMs).toHaveLength(160);
      const historical = await db.ingressEffect.findMany({ where: { workspaceId, messageId: { in: identities.filter(i => recoveredIds.includes(i.rawId)).map(i => i.messageId) } } });
      const historicalByKind = Object.fromEntries([...new Set(historical.map(e=>e.kind))].map(kind=>[kind,historical.filter(e=>e.kind===kind).length]));
      expect(historical.every(e => ['realtime.message','realtime.conversation','media.prepare'].includes(e.kind) && e.receiptId === null)).toBe(true);
      const beforeIdentities = identities.length;
      const before = await db.ingressEffect.count({ where: { workspaceId } });
      const worker = recoveryWorker; worker.kill('SIGTERM'); await until(async () => worker.exitCode, value => value !== null);
      const restarted = spawn(process.execPath, ['dist/ingress-worker.js'], { cwd: process.cwd(), env: { ...runtimeEnv, INGRESS_RECOVERY_ENABLED: 'false' }, stdio: 'pipe' }); children.push(restarted);
      restarted.stdout!.on('data', data => logs.push(String(data))); restarted.stderr!.on('data', data => logs.push(String(data)));
      const duplicate = await post(`/webhooks/evolution/${workspaceId}`, upsert(`${prefix}0`, { conversation: 'synthetic controlled load' })); expect(duplicate.status).toBe(202);
      const duplicateReceipt = (await duplicate.json() as { receiptId: string }).receiptId;
      await until(() => db.ingressApplication.findUnique({ where: { receiptId: duplicateReceipt } }), application => application?.state === 'applied');
      expect(await db.canonicalMessageIdentity.count({ where: { workspaceId, rawId: { startsWith: prefix } } })).toBe(beforeIdentities);
      expect(await db.ingressEffect.count({ where: { workspaceId } })).toBe(before);
      expect(resources.length).toBeGreaterThan(10);
      expect(trafficDurationMs).toBeGreaterThanOrEqual(10_000); expect(trafficDurationMs).toBeLessThan(11_000);
      const cpuWindowSeconds = resources.at(-1)!.cpuPercent - resources[0]!.cpuPercent;
      const resourceDurationMs = resources.at(-1)!.elapsedMs - resources[0]!.elapsedMs;
      const finalResult = { ...observations, executionCompleted: true, latencyPass: ingressP95Ms < 500 && applicationP95Ms < 2000,
        recoveryState: yielded, historicalEffects: historicalByKind, autonomousHistoricalEffects: 0, restartDuplicatePreserved: true,
        totalProviderCalls: [...counts.values()].reduce((a,b)=>a+b,0)+versionRequests, completedLiveIdentities: 80,
        boundary: 'Common observational harness, not release qualification. Recovery callbacks/cursor guarantees differ by version and are observed rather than presumed.' };
      await writeFile(diagnosticPath, JSON.stringify(finalResult,null,2));
    } finally { observingStopped = true; await observing; clearInterval(sampler); await recovery; await new Promise<void>(resolve => provider.close(() => resolve())); }
  }, 240_000);

});
