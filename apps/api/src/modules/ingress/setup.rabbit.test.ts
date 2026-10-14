import { createServer, connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import amqp from 'amqplib';
import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, it, expect } from 'vitest';
import { ConfirmedIngressPublisher, transportTopology } from './broker.js';
import { IngressTransportConsumer } from './consumer.js';
import { IngressJournal } from './journal.js';
import { IngressPrivateStore } from './private-store.js';
import { createIngressRuntime, readIngressEnvironment } from './runtime.js';

const brokerUrl = process.env.INGRESS_TEST_AMQP_URL;
const databaseUrl = process.env.MESSAGING_TEST_DATABASE_URL;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer!); }
}
/** A real TCP proxy withholding one actual broker response (and later frames),
 * without replacing connect/RPC promises. Closing a client must release both
 * owned sockets; reconnect uses an unimpeded new connection. */
async function silentResponse(method: number, connectionNumber = 1, occurrence = 1) {
  const broker = new URL(brokerUrl!), upstreamPort = Number(broker.port), sockets = new Set<Socket>();
  let accepted = 0, hits = 0, ended = false, reach!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const server = createServer(client => {
    const number = ++accepted, upstream = connect({ host: broker.hostname, port: upstreamPort });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); }
    client.pipe(upstream);
    client.once('close', () => { upstream.destroy(); });
    client.once('end', () => { if (number === connectionNumber) ended = true; client.destroy(); upstream.destroy(); });
    upstream.once('close', () => client.destroy());
    let buffer = Buffer.alloc(0), held = false;
    upstream.on('data', data => {
      if (held) return;
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 7) {
        const length = buffer.readUInt32BE(3) + 8;
        if (buffer.length < length) return;
        const frame = buffer.subarray(0, length); buffer = buffer.subarray(length);
        const id = frame[0] === 1 && length >= 12 ? frame.readUInt32BE(7) : 0;
        if (number === connectionNumber && id === method && ++hits === occurrence) { held = true; reach(); return; }
        client.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Proxy address');
  broker.port = String(address.port);
  return { url: broker.toString(), reached, ended: () => ended, accepted: () => accepted,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function cleanup(namespace: string) {
  const model = await amqp.connect(brokerUrl!);
  try {
    const channel = await model.createChannel(), topology = transportTopology(namespace);
    for (const queue of [topology.incoming, topology.retry, topology.dead]) await channel.deleteQueue(queue);
    await channel.deleteExchange(namespace);
  } finally { await model.close(); }
}
// AMQP class/method IDs are from the pinned amqplib defs. Each selected response
// has already been produced by the real broker when the test cancels setup.
const windows = [
  ['initial protocol negotiation', 10 * 65536 + 10, 1],
  ['handshake', 10 * 65536 + 41, 1],
  ['topology channel open', 20 * 65536 + 11, 1],
  ['exchange declare', 40 * 65536 + 11, 1],
  ['queue declare', 50 * 65536 + 11, 1],
  ['queue bind', 50 * 65536 + 21, 1],
  ['topology channel close', 20 * 65536 + 41, 1],
  ['session channel open', 20 * 65536 + 11, 2],
] as const;
describe.skipIf(!brokerUrl || !databaseUrl)('owned real RabbitMQ setup cancellation', () => {
  beforeAll(() => {
    readIngressEnvironment({ INGRESS_TRANSPORT_STAGE: 'isolated-1a', DATABASE_URL: databaseUrl, INGRESS_AMQP_URL: brokerUrl,
      INGRESS_NAMESPACE: 'talk.isolated.setup_test', INGRESS_WORKSPACE_ALLOWLIST: 'fixture', INGRESS_PRIVATE_ROOT: '/private/tmp/unused' });
  });
  for (const kind of ['publisher', 'consumer'] as const) {
    const cases = [...windows, ...(kind === 'publisher'
      ? [['confirm select', 85 * 65536 + 11, 1] as const]
      : [['prefetch', 60 * 65536 + 11, 1] as const, ['first consume', 60 * 65536 + 21, 1] as const, ['second consume', 60 * 65536 + 21, 2] as const])];
    for (const [name, method, occurrence] of cases) {
      it(`${kind}: abort during ${name} destroys the connection and cannot activate a late session`, async () => {
        const namespace = `talk.isolated.${randomUUID()}`, proxy = await silentResponse(method, 1, occurrence);
        const abort = new AbortController(), db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
        const files = new IngressPrivateStore('/private/tmp/unused-setup-test');
        let session: ConfirmedIngressPublisher | IngressTransportConsumer | undefined;
        try {
          const pending = kind === 'publisher'
            ? ConfirmedIngressPublisher.connect(proxy.url, namespace, { signal: abort.signal })
            : IngressTransportConsumer.start({ url: proxy.url, namespace, signal: abort.signal, journal: new IngressJournal(db, files), publisher: () => null });
          const result = pending.then(value => { session = value; return 'started'; }, error => String(error));
          await within(proxy.reached);
          const started = Date.now(); abort.abort();
          expect(await within(result)).toContain('AMQP setup aborted');
          expect(Date.now() - started).toBeLessThan(1000);
          await pause(25); expect(proxy.ended()).toBe(true); expect(session).toBeUndefined();
        } finally { await session?.close(); await proxy.close(); await db.$disconnect(); await cleanup(namespace); }
      });
    }
    it(`${kind}: setup deadline releases a silent handshake and topology RPC`, async () => {
      for (const method of [10 * 65536 + 41, 50 * 65536 + 11]) {
        const namespace = `talk.isolated.${randomUUID()}`, proxy = await silentResponse(method);
        const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
        try {
          const pending = kind === 'publisher'
            ? ConfirmedIngressPublisher.connect(proxy.url, namespace, { setupDeadlineMs: 200 })
            : IngressTransportConsumer.start({ url: proxy.url, namespace, setupDeadlineMs: 200, journal: new IngressJournal(db, new IngressPrivateStore('/private/tmp/unused-setup-test')), publisher: () => null });
          const result = pending.then(session => { void session.close(); return 'started'; }, error => String(error));
          await within(proxy.reached); expect(await within(result)).toContain('AMQP setup deadline');
          await pause(25); expect(proxy.ended()).toBe(true);
        } finally { await proxy.close(); await db.$disconnect(); await cleanup(namespace); }
      }
    });
  }
  for (const [name, number, method] of [['publisher handshake', 1, 10 * 65536 + 41], ['publisher channel', 1, 20 * 65536 + 11], ['consumer topology', 2, 50 * 65536 + 11], ['consumer registration', 2, 60 * 65536 + 21]] as const) {
    it(`runtime shutdown cancels ${name} before a session is assigned`, async () => {
      const namespace = `talk.isolated.${randomUUID()}`, proxy = await silentResponse(method, number), privateRoot = await mkdtemp('/private/tmp/ingress-setup-');
      const runtime = await createIngressRuntime({ databaseUrl: databaseUrl!, amqpUrl: proxy.url, namespace, privateRoot, workspaceAllowlist: new Set([randomUUID()]), port: 4011, evolutionSecret: '', wahaSecret: '', evolutionAliases: [] }, true);
      try {
        await within(proxy.reached); const start = Date.now(); await within(runtime.close());
        expect(Date.now() - start).toBeLessThan(1000);
        await pause(30); expect(proxy.ended()).toBe(true);
        const count = proxy.accepted(); await pause(550); expect(proxy.accepted()).toBe(count);
        expect(runtime.publisher()?.alive ?? false).toBe(false);
      } finally { await runtime.close(); await proxy.close(); await cleanup(namespace); await rm(privateRoot, { recursive: true, force: true }); }
    });
  }
  for (const [name, number, method] of [['publisher handshake', 1, 10 * 65536 + 10], ['consumer topology', 2, 50 * 65536 + 11]] as const) {
    it(`compiled worker SIGTERM exits during ${name}`, async () => {
      const namespace = `talk.isolated.${randomUUID()}`, proxy = await silentResponse(method, number), privateRoot = await mkdtemp('/private/tmp/ingress-setup-child-');
      const child = spawn(process.execPath, ['src/modules/ingress/transport-setup-child.fixture.mjs'], { env: { ...process.env,
        DATABASE_URL: databaseUrl!, INGRESS_AMQP_URL: brokerUrl!, INGRESS_TEST_PROXY_URL: proxy.url,
        INGRESS_TRANSPORT_STAGE: 'isolated-1a', INGRESS_NAMESPACE: namespace, INGRESS_PRIVATE_ROOT: privateRoot,
        INGRESS_WORKSPACE_ALLOWLIST: randomUUID() }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      try {
        await within(proxy.reached, 3000);
        const start = Date.now(); child.kill('SIGTERM');
        expect(await within(exited), output).toEqual({ code: 0, signal: null });
        expect(Date.now() - start).toBeLessThan(1000); expect(proxy.ended()).toBe(true);
        expect(output).not.toMatch(/unhandled|uncaught/i);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        await proxy.close(); await cleanup(namespace); await rm(privateRoot, { recursive: true, force: true });
      }
    });
  }
  for (const number of [1, 2]) {
    it(`runtime replaces silent ${number === 1 ? 'publisher' : 'consumer'} setup after its deadline`, async () => {
      const namespace = `talk.isolated.${randomUUID()}`, proxy = await silentResponse(50 * 65536 + 11, number), privateRoot = await mkdtemp('/private/tmp/ingress-setup-');
      const runtime = await createIngressRuntime({ databaseUrl: databaseUrl!, amqpUrl: proxy.url, namespace, privateRoot, workspaceAllowlist: new Set([randomUUID()]), port: 4011, evolutionSecret: '', wahaSecret: '', evolutionAliases: [] }, true);
      const admin = await amqp.connect(brokerUrl!);
      try {
        await within(proxy.reached);
        await within((async () => {
          const channel = await admin.createChannel();
          while (!proxy.ended() || proxy.accepted() < 3) await pause(25);
          while ((await channel.checkQueue(transportTopology(namespace).retry)).consumerCount !== 1) await pause(25);
          await channel.close();
        })(), 5000);
        expect(runtime.publisher()?.ready).toBe(true);
        await within(runtime.close());
      } finally { await runtime.close(); await admin.close(); await proxy.close(); await cleanup(namespace); await rm(privateRoot, { recursive: true, force: true }); }
    }, 10000);
  }
});
