import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsumeMessage } from 'amqplib';
import type { IngressJournal } from './journal.js';
import type { ConfirmedIngressPublisher } from './broker.js';
import * as reporting from '../../observability/glitchtip.js';

const setup = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./connection-setup.js', () => ({ setupOwnedAmqpConnection: (...args: unknown[]) => setup.run(...args) }));
vi.mock('./connection-close.js', () => ({ closeOwnedAmqpConnection: async () => {} }));
vi.mock('./broker.js', async original => ({ ...await original<typeof import('./broker.js')>(),
  declareTransport: async () => ({ incoming: 'incoming', retry: 'retry' }) }));
import { IngressTransportConsumer } from './consumer.js';

afterEach(() => vi.restoreAllMocks());
describe('consumer failure reporting preserves durable delivery', () => {
  async function fixture(failures: number, failPublish = false) {
    const callbacks: Array<(message: ConsumeMessage | null) => void> = [];
    const channel = Object.assign(new EventEmitter(), { prefetch: vi.fn(),
      consume: vi.fn(async (_queue: string, callback: (message: ConsumeMessage | null) => void) => { callbacks.push(callback); }), ack: vi.fn() });
    const model = Object.assign(new EventEmitter(), { createChannel: async () => channel });
    setup.run.mockImplementation(async (_url, _options, callback) => callback(model, (run: () => unknown) => run()));
    const id = randomUUID(), error = Object.assign(new Error('PRIVATE_TOKEN original consumer failure'), { code: 'P2028' });
    const publisher = { ready: true } as ConfirmedIngressPublisher;
    const publish = failPublish ? vi.fn().mockRejectedValue(new Error('transport offline')) : vi.fn().mockResolvedValue({});
    const journal = { db: { ingressReceipt: { findUnique: async () => ({ id, transportNamespace: 'talk.isolated.monitor', workspaceId: 'fixture' }) },
      ingressDelivery: { findUniqueOrThrow: async () => ({ state: 'pending_application' }), update: async () => ({ failures }) } }, publish } as unknown as IngressJournal;
    const consumer = await IngressTransportConsumer.start({ url: 'amqp://unused', namespace: 'talk.isolated.monitor',
      journal, publisher: () => publisher, application: { apply: vi.fn().mockRejectedValue(error) } });
    const message = { content: Buffer.from(JSON.stringify({ version: 1, receiptId: id })) } as ConsumeMessage;
    return { consumer, publish, channel, error, message, deliver: () => callbacks[0]!(message) };
  }
  it('alerts on retry exhaustion after a confirmed dead-letter handoff and still ACKs', async () => {
    const report = vi.spyOn(reporting, 'reportFailure').mockReturnValue(true);
    const f = await fixture(3);
    try {
      f.deliver();
      await vi.waitFor(() => expect(f.channel.ack).toHaveBeenCalledWith(f.message));
      expect(f.publish).toHaveBeenCalledWith(expect.any(String), expect.anything(), 'dead');
      expect(report).toHaveBeenCalledWith('application_retry', f.error);
      expect(report).toHaveBeenCalledWith('application_dead_letter', f.error);
    } finally { await f.consumer.close(); }
  });
  it('never announces a completed dead-letter transfer or ACKs if publication fails', async () => {
    const report = vi.spyOn(reporting, 'reportFailure').mockReturnValue(true);
    const f = await fixture(3, true);
    try {
      f.deliver();
      await vi.waitFor(() => expect(f.consumer.alive).toBe(false));
      expect(f.channel.ack).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalledWith('application_dead_letter', expect.anything());
      expect(report).toHaveBeenCalledWith('transport_delivery', expect.any(Error));
    } finally { await f.consumer.close(); }
  });
});
