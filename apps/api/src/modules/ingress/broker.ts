import type { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { setupOwnedAmqpConnection, type SetupStep } from './connection-setup.js';
import { closeOwnedAmqpConnection } from './connection-close.js';
import { randomUUID } from 'node:crypto';

export type Destination = 'incoming' | 'retry' | 'dead';
export type TransportReference = { version: 1; receiptId: string } | { version: 1; quarantineId: string };
export class IngressBackpressure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'IngressBackpressure'; }
}
export function transportTopology(namespace: string) {
  if (!/^talk\.isolated\.[a-z0-9_-]{1,80}$/.test(namespace)) throw new Error('Stage 1A requires an isolated Talk namespace');
  return { exchange: namespace, incoming: `${namespace}.incoming`, retry: `${namespace}.retry`, dead: `${namespace}.dead` };
}
export async function declareTransport(model: ChannelModel, namespace: string, step: SetupStep) {
  const topology = transportTopology(namespace), channel = await step(() => model.createChannel());
  channel.on('error', () => {});
  try {
    await step(() => channel.assertExchange(topology.exchange, 'direct', { durable: true }));
    for (const destination of ['incoming', 'retry', 'dead'] as const) {
      await step(() => channel.assertQueue(topology[destination], { durable: true, arguments: { 'x-queue-type': 'quorum' } }));
      await step(() => channel.bindQueue(topology[destination], topology.exchange, destination));
    }
  } finally { await step(() => channel.close()); }
  return topology;
}
interface Pending {
  returned: boolean;
  finish(error?: IngressBackpressure): void;
}
/** A publisher session never retries internally. false means accepted into the
 * client buffer: the same publish is awaited, never submitted twice. A broken or
 * blocked session is retired; callers get explicit backpressure until replaced. */
export class ConfirmedIngressPublisher {
  private pending = new Map<string, Pending>();
  private usable = true;
  private writable = true;
  private closed: Promise<void> | null = null;
  private constructor(readonly model: ChannelModel, readonly channel: ConfirmChannel,
    readonly namespace: string, readonly deadlineMs: number, readonly maxInflight: number) {
    channel.on('return', message => {
      const pending = this.pending.get(message.properties.messageId ?? '');
      if (pending) pending.returned = true;
    });
    channel.on('drain', () => { this.writable = true; });
    channel.on('error', () => this.retire('channel_error'));
    channel.on('close', () => this.retire('channel_closed'));
    model.on('error', () => this.retire('connection_error'));
    model.on('close', () => this.retire('connection_closed'));
    model.on('blocked', () => this.retire('broker_blocked'));
  }
  static async connect(url: string, namespace: string, options: { deadlineMs?: number; maxInflight?: number; declare?: boolean; signal?: AbortSignal; setupDeadlineMs?: number } = {}) {
    transportTopology(namespace);
    const deadlineMs = options.deadlineMs ?? 2000, maxInflight = options.maxInflight ?? 128;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 50 || deadlineMs > 30000 || !Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > 4096) throw new Error('Invalid publisher bounds');
    return setupOwnedAmqpConnection(url, options, async (model, step) => {
      if (options.declare !== false) await declareTransport(model, namespace, step);
      const channel = await step(() => model.createConfirmChannel());
      return new ConfirmedIngressPublisher(model, channel, namespace, deadlineMs, maxInflight);
    });
  }
  get ready() { return this.usable && this.writable && this.pending.size < this.maxInflight; }
  get alive() { return this.usable; }
  private retire(code: string) {
    if (!this.usable) return;
    this.usable = false;
    for (const pending of [...this.pending.values()]) pending.finish(new IngressBackpressure(code));
    this.closed = closeOwnedAmqpConnection(this.model);
  }
  async publish(reference: TransportReference, destination: Destination, publishId = randomUUID()) {
    if (!this.ready) throw new IngressBackpressure(this.usable ? 'publisher_backpressure' : 'publisher_unavailable');
    if (this.pending.has(publishId)) throw new Error('Duplicate publish attempt');
    const body = Buffer.from(JSON.stringify(reference));
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.retire('publish_deadline'), this.deadlineMs);
      const pending: Pending = { returned: false, finish: error => {
        if (!this.pending.delete(publishId)) return;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      } };
      this.pending.set(publishId, pending);
      try {
        const writable = this.channel.publish(this.namespace, destination, body,
          { mandatory: true, persistent: true, contentType: 'application/json', messageId: publishId }, error => {
            if (pending.returned) pending.finish(new IngressBackpressure('unroutable'));
            else pending.finish(error ? new IngressBackpressure('publish_nack') : undefined);
          });
        if (!writable) this.writable = false;
      } catch { this.retire('publish_error'); }
    });
  }
  async close() { this.retire('publisher_closed'); await this.closed; }
}
export function decodeReference(message: ConsumeMessage): TransportReference | null {
  if (message.content.length > 256) return null;
  try {
    const value = JSON.parse(message.content.toString('utf8'));
    if (value?.version !== 1 || Object.keys(value).length !== 2) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (typeof value.receiptId === 'string' && uuid.test(value.receiptId)) return { version: 1, receiptId: value.receiptId };
    if (typeof value.quarantineId === 'string' && uuid.test(value.quarantineId)) return { version: 1, quarantineId: value.quarantineId };
    return null;
  } catch { return null; }
}
