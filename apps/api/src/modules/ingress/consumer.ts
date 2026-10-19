import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { setupOwnedAmqpConnection } from './connection-setup.js';
import { closeOwnedAmqpConnection } from './connection-close.js';
import { randomUUID } from 'node:crypto';
import { ConfirmedIngressPublisher, IngressBackpressure, decodeReference, declareTransport, transportTopology } from './broker.js';
import { IngressJournal } from './journal.js';
import { reportFailure } from '../../observability/glitchtip.js';

/** Original-channel ACK follows the selected milestone sink: stage 1A conserves
 * transport only; stage 1B commits complete per-event application and obligations. */
export class IngressTransportConsumer {
  private inflight = new Set<Promise<void>>();
  private running = true;
  private closed: Promise<void> | null = null;
  private drained: Promise<void> | null = null;
  private constructor(readonly model: ChannelModel, readonly channel: Channel,
    readonly journal: IngressJournal, readonly namespace: string, readonly publisher: () => ConfirmedIngressPublisher | null, readonly maxFailures: number, readonly application?: { apply(receiptId: string): Promise<unknown> }) {
    channel.on('error', () => this.stopAccepting()); channel.on('close', () => this.stopAccepting());
    model.on('error', () => this.stopAccepting()); model.on('close', () => this.stopAccepting());
  }
  static async start(input: { url: string; namespace: string; journal: IngressJournal; publisher: () => ConfirmedIngressPublisher | null; prefetch?: number; maxFailures?: number; signal?: AbortSignal; setupDeadlineMs?: number; application?: { apply(receiptId: string): Promise<unknown> } }) {
    const prefetch = input.prefetch ?? 8, maxFailures = input.maxFailures ?? 3;
    if (!Number.isSafeInteger(prefetch) || prefetch < 1 || prefetch > 128 || !Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 10) throw new Error('Invalid consumer bounds');
    transportTopology(input.namespace);
    return setupOwnedAmqpConnection(input.url, input, async (model, step) => {
      const topology = await declareTransport(model, input.namespace, step), channel = await step(() => model.createChannel());
      const consumer = new IngressTransportConsumer(model, channel, input.journal, input.namespace, input.publisher, maxFailures, input.application);
      await step(() => channel.prefetch(prefetch));
      for (const queue of [topology.incoming, topology.retry]) {
        await step(() => channel.consume(queue, message => {
          if (!message) { consumer.stopAccepting(); return; }
          const work = consumer.deliver(message).catch(error => { reportFailure('transport_delivery', error); consumer.stopAccepting(); });
          consumer.inflight.add(work);
          void work.finally(() => consumer.inflight.delete(work));
        }, { noAck: false }));
      }
      return consumer;
    });
  }
  get alive() { return this.running; }
  private stopAccepting() {
    if (!this.running) return;
    this.running = false;
    // Closing the ORIGINAL channel requeues unacknowledged deliveries. Never ACK
    // those delivery tags on a replacement connection.
    this.closed = closeOwnedAmqpConnection(this.model);
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
  private async settledPublication(receiptId: string, deadline: number) {
    let pollMs = 10;
    while (this.running) {
      if (Date.now() >= deadline) { this.stopAccepting(); return null; }
      const state = await this.journal.db.ingressDelivery.findUniqueOrThrow({ where: { receiptId } });
      if (!this.running) return null;
      if (state.state === 'dead_letter' || state.state === 'pending_application') return state;
      if (!state.leaseToken || !state.leaseUntil || state.leaseUntil.getTime() <= Date.now()) return state;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      pollMs = Math.min(250, pollMs * 2);
    }
    return null;
  }
  private async deliver(message: ConsumeMessage) {
    const reference = decodeReference(message);
    if (!reference || !('receiptId' in reference)) return this.quarantine(message, 'invalid_transport_reference');
    const receipt = await this.journal.db.ingressReceipt.findUnique({ where: { id: reference.receiptId } });
    if (!receipt) return this.quarantine(message, 'unknown_receipt');
    if (receipt.transportNamespace !== this.namespace || (this.journal.workspaceAllowlist && !this.journal.workspaceAllowlist.has(receipt.workspaceId))) return this.quarantine(message, 'foreign_transport_scope');
    const state = await this.journal.db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: receipt.id } });
    if (!this.running) return;
    if (state.state === 'dead_letter') { this.ack(message); return; }
    try {
      if (this.application) await this.application.apply(receipt.id);
      else await this.journal.handoff(receipt.id);
    } catch (error) {
      reportFailure('application_retry', error);
      // Successful durable handoff never waits for publication bookkeeping. Only
      // a failed application must wait before incrementing and publishing retry.
      const deadline = Date.now() + (this.publisher()?.deadlineMs ?? 2000) + 10000;
      let counted = false;
      while (this.running) {
        let failure = await this.settledPublication(receipt.id, deadline);
        if (!failure || !this.running) return; // Closing the original channel requeues this reference.
        if (failure.state === 'dead_letter' || failure.state === 'pending_application') { this.ack(message); return; }
        if (!counted) {
          const changed = await this.journal.db.ingressDelivery.updateMany({ where: { receiptId: receipt.id, state: { in: ['staged', 'routed'] },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { failures: { increment: 1 }, lastError: 'application_handoff_failed' } });
          if (!changed.count) continue; // A duplicate completed or claimed publication meanwhile.
          counted = true;
          failure = await this.journal.db.ingressDelivery.findUniqueOrThrow({ where: { receiptId: receipt.id } });
        }
        if (!this.running) return;
        if (failure.state === 'dead_letter' || failure.state === 'pending_application') { this.ack(message); return; }
        const publisher = this.publisher();
        if (!publisher?.ready) { this.stopAccepting(); return; }
        try {
          // Confirm replacement AND its SQL evidence before acknowledging this
          // reference. Concurrent duplicate deliveries may claim the lease first.
          await this.journal.publish(receipt.id, publisher, failure.failures >= this.maxFailures ? 'dead' : 'retry');
        } catch (publishError) {
          if (publishError instanceof IngressBackpressure && publishError.code === 'publication_in_progress') continue;
          throw publishError;
        }
        if (failure.failures >= this.maxFailures) reportFailure('application_dead_letter', error);
        this.ack(message);
        return;
      }
      return;
    }
    this.ack(message);
  }
  close(): Promise<void> {
    if (this.drained) return this.drained;
    // Do not await basic.cancel: it also needs a response from the silent peer.
    // Retire first; in-flight commits may finish, but can never ACK a replacement
    // channel. Their original receipts will be safely redelivered after close.
    this.stopAccepting();
    this.drained = (async () => {
      await this.closed;
      await new Promise<void>(resolve => {
        const deadline = setTimeout(resolve, 2000);
        void Promise.allSettled([...this.inflight]).then(() => { clearTimeout(deadline); resolve(); });
      });
    })();
    return this.drained;
  }
}
