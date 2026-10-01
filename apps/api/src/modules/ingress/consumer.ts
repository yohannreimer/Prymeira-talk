import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { ConfirmedIngressPublisher, decodeReference, declareTransport } from './broker.js';
import { IngressJournal } from './journal.js';

/** Real transport consumer for stage 1A only. ACK means a durable application
 * obligation exists. Stage 1B must move ACK behind its complete canonical TX. */
export class IngressTransportConsumer {
  private inflight = new Set<Promise<void>>();
  private tags: string[] = [];
  private running = true;
  private closed: Promise<void> | null = null;
  private constructor(readonly model: ChannelModel, readonly channel: Channel,
    readonly journal: IngressJournal, readonly namespace: string, readonly publisher: () => ConfirmedIngressPublisher | null, readonly maxFailures: number) {
    channel.on('error', () => this.stopAccepting()); channel.on('close', () => this.stopAccepting());
    model.on('error', () => this.stopAccepting()); model.on('close', () => this.stopAccepting());
  }
  static async start(input: { url: string; namespace: string; journal: IngressJournal; publisher: () => ConfirmedIngressPublisher | null; prefetch?: number; maxFailures?: number }) {
    const prefetch = input.prefetch ?? 8, maxFailures = input.maxFailures ?? 3;
    if (!Number.isSafeInteger(prefetch) || prefetch < 1 || prefetch > 128 || !Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 10) throw new Error('Invalid consumer bounds');
    const model = await amqp.connect(input.url, { timeout: 2000 });
    model.on('error', () => {});
    try {
      const topology = await declareTransport(model, input.namespace), channel = await model.createChannel();
      const consumer = new IngressTransportConsumer(model, channel, input.journal, input.namespace, input.publisher, maxFailures);
      await channel.prefetch(prefetch);
      for (const queue of [topology.incoming, topology.retry]) {
        const { consumerTag } = await channel.consume(queue, message => {
          if (!message) { consumer.stopAccepting(); return; }
          const work = consumer.deliver(message).catch(() => consumer.stopAccepting());
          consumer.inflight.add(work);
          void work.finally(() => consumer.inflight.delete(work));
        }, { noAck: false });
        consumer.tags.push(consumerTag);
      }
      return consumer;
    } catch (error) { await model.close().catch(() => {}); throw error; }
  }
  get alive() { return this.running; }
  private stopAccepting() {
    if (!this.running) return;
    this.running = false;
    // Closing the ORIGINAL channel requeues unacknowledged deliveries. Never ACK
    // those delivery tags on a replacement connection.
    this.closed = this.model.close().catch(() => {});
  }
  private ack(message: ConsumeMessage) {
    if (!this.running) return;
    try { this.channel.ack(message); } catch { this.stopAccepting(); }
  }
  private async quarantine(message: ConsumeMessage, reason: string) {
    const publisher = this.publisher();
    if (!publisher?.ready) { this.stopAccepting(); return; }
    const raw = await this.journal.files.put(message.content), id = randomUUID();
    await this.journal.db.ingressQuarantine.create({ data: { id, rawRef: raw.ref, rawDigest: raw.digest, reason } });
    await publisher.publish({ version: 1, quarantineId: id }, 'dead');
    this.ack(message);
  }
  private async deliver(message: ConsumeMessage) {
    const reference = decodeReference(message);
    if (!reference || !('receiptId' in reference)) return this.quarantine(message, 'invalid_transport_reference');
    const receipt = await this.journal.db.ingressReceipt.findUnique({ where: { id: reference.receiptId } });
    if (!receipt) return this.quarantine(message, 'unknown_receipt');
    if (receipt.transportNamespace !== this.namespace || (this.journal.workspaceAllowlist && !this.journal.workspaceAllowlist.has(receipt.workspaceId))) return this.quarantine(message, 'foreign_transport_scope');
    const state = await this.journal.db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: receipt.id } });
    if (state.state === 'dead_letter') { this.ack(message); return; }
    try {
      await this.journal.handoff(receipt.id);
    } catch {
      const failure = await this.journal.db.ingressDelivery.update({ where: { receiptId: receipt.id }, data: { failures: { increment: 1 }, lastError: 'application_handoff_failed' } });
      const publisher = this.publisher();
      if (!publisher?.ready) { this.stopAccepting(); return; }
      // No classic DLX. The replacement persistent message is mandatory-routed
      // and confirmed, and its evidence committed, BEFORE the original ACK.
      await this.journal.publish(receipt.id, publisher, failure.failures >= this.maxFailures ? 'dead' : 'retry');
      this.ack(message);
      return;
    }
    this.ack(message);
  }
  async close() {
    if (this.running) for (const tag of this.tags) await this.channel.cancel(tag).catch(() => {});
    await Promise.allSettled([...this.inflight]);
    this.stopAccepting();
    await this.closed;
  }
}
