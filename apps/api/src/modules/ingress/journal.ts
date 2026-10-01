import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
import { enterCanonicalTransaction, enterCanonicalWorkspaceTransaction } from '../messaging/canonical-boundary.js';
import { json } from '../messaging/canonical-values.js';
import { IngressPrivateStore } from './private-store.js';
import { stripEnvelopeCredentials } from './credentials.js';
import { eventKey, type ReceiptPayload } from './normalization.js';
import { ConfirmedIngressPublisher, IngressBackpressure, type Destination } from './broker.js';

type Tx = Prisma.TransactionClient;
export class IngressJournal {
  constructor(readonly db: PrismaClient, readonly files: IngressPrivateStore, readonly workspaceAllowlist?: ReadonlySet<string>) {}
  private assertAllowed(workspaceId: string) {
    if (this.workspaceAllowlist && !this.workspaceAllowlist.has(workspaceId)) throw new Error("Ingress workspace not allowlisted");
  }
  /** Caller has verified the raw signature. Reauthenticate under the source locks
   * before commit; filesystem writes precede the SQL receipt and AMQP follows it. */
  async stage(input: { transportNamespace: string; source: TrustedMessagingContext; authentication: string; raw: Buffer; payload: ReceiptPayload;
    reauthenticate: (tx: Tx) => Promise<void> }) {
    this.assertAllowed(input.source.workspaceId);
    const authenticatedDigest = createHash('sha256').update(input.raw).digest('hex');
    const sanitizedRaw = Buffer.from(JSON.stringify(stripEnvelopeCredentials(JSON.parse(input.raw.toString('utf8')))));
    const raw = await this.files.put(sanitizedRaw), events = await this.files.put(Buffer.from(JSON.stringify(stripEnvelopeCredentials(input.payload))));
    const id = randomUUID(), source = input.source;
    return this.db.$transaction(async tx => {
      await enterCanonicalTransaction(tx, source);
      await input.reauthenticate(tx);
      const scope = { workspaceId: source.workspaceId, channelId: source.channelId };
      const channel = await tx.channel.findUniqueOrThrow({ where: { id: source.channelId } });
      const connection = source.connectionId ? await tx.channelConnection.findUniqueOrThrow({ where: { id: source.connectionId } }) : null;
      const config = !source.connectionId ? await tx.integrationConfig.findUnique({ where: { workspaceId_provider: { workspaceId: source.workspaceId, provider: 'meta_cloud' } } }) : null;
      const acceptedFacts = { channelProviderKey: channel.providerKey, channelLifecycleGeneration: channel.connectionLifecycleGeneration,
        verifiedPhoneNumber: connection?.verifiedPhoneNumber ?? null, connectionEligible: connection?.eligible ?? null,
        connectionStatus: connection?.status ?? null, integrationConfigId: config?.id ?? null };
      const receipt = await tx.ingressReceipt.create({ data: { id, ...scope, stageVersion: 1, transportNamespace: input.transportNamespace, source: json({ ...source, acceptedFacts }),
        authentication: input.authentication, authenticatedDigest, rawRef: raw.ref, rawDigest: raw.digest, eventRef: events.ref, eventDigest: events.digest,
        eventCount: input.payload.events.length } });
      await tx.ingressDelivery.create({ data: { ...scope, receiptId: id } });
      for (const [eventIndex, result] of input.payload.events.entries()) {
        const key = result.kind === 'accepted' ? eventKey(result.event) : null;
        await tx.ingressFrontier.create({ data: { ...scope, receiptId: id, eventIndex,
          kind: result.kind === 'accepted' ? result.event.kind : result.kind,
          chatAddress: key?.chatAddress ?? null, ...(key ? { exactKey: json(key) } : {}) } });
      }
      return receipt;
    });
  }
  async publish(receiptId: string, publisher: ConfirmedIngressPublisher, destination: Destination = 'incoming', leaseToken?: string) {
    const receipt = await this.db.ingressReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    this.assertAllowed(receipt.workspaceId);
    if (receipt.transportNamespace !== publisher.namespace) throw new Error('Ingress transport namespace mismatch');
    if (!leaseToken) {
      leaseToken = randomUUID();
      const claim = await this.db.ingressDelivery.updateMany({ where: { receiptId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
        data: { leaseToken, leaseUntil: new Date(Date.now() + publisher.deadlineMs + 10000) } });
      if (!claim.count) throw new IngressBackpressure('publication_in_progress');
    }
    const id = randomUUID(), scope = { workspaceId: receipt.workspaceId, channelId: receipt.channelId };
    await this.db.ingressPublishAttempt.create({ data: { id, receiptId, ...scope, destination } });
    try {
      await publisher.publish({ version: 1, receiptId }, destination, id);
    } catch (error) {
      const code = error instanceof IngressBackpressure ? error.code : 'publisher_error';
      await this.db.$transaction(async tx => {
        await tx.ingressPublishAttempt.update({ where: { id }, data: { outcome: ['unroutable','publisher_backpressure','publisher_unavailable','publish_nack','publication_in_progress'].includes(code) ? 'failed' : 'uncertain', errorCode: code, settledAt: new Date() } });
        await tx.ingressDelivery.updateMany({ where: { receiptId, ...(leaseToken ? { leaseToken } : {}), state: { in: ['staged','routed'] } },
          data: { lastError: code, nextAttemptAt: new Date(Date.now() + 5000) } });
        await tx.ingressDelivery.updateMany({ where: { receiptId, leaseToken }, data: { leaseToken: null, leaseUntil: null } });
      });
      throw error;
    }
    // Failure here is an HTTP 503, never an unrecorded 2xx. Recovery republishes
    // the same receipt; the application handoff is uniquely keyed by that UUID.
    await this.db.$transaction(async tx => {
      await tx.ingressPublishAttempt.update({ where: { id }, data: { outcome: 'confirmed', settledAt: new Date() } });
      await tx.ingressDelivery.updateMany({ where: { receiptId, confirmedAt: null }, data: { confirmedAt: new Date() } });
      await tx.ingressDelivery.updateMany({ where: { receiptId, state: { in: ['staged','routed'] }, ...(leaseToken ? { leaseToken } : {}) },
        data: { state: destination === 'dead' ? 'dead_letter' : 'routed', lastError: null, nextAttemptAt: new Date(Date.now() + 30000) } });
      await tx.ingressDelivery.updateMany({ where: { receiptId, leaseToken }, data: { leaseToken: null, leaseUntil: null } });
    });
  }
  async readPayload(receiptId: string) {
    const receipt = await this.db.ingressReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    this.assertAllowed(receipt.workspaceId);
    const bytes = await this.files.read(receipt.eventRef, receipt.eventDigest);
    const payload = JSON.parse(bytes.toString('utf8')) as ReceiptPayload;
    if (payload.version !== 1 || !Array.isArray(payload.events) || payload.events.length !== receipt.eventCount) throw new Error('Invalid staged event payload');
    return { receipt, payload };
  }
  /** Stage 1A's real sink. This is deliberately NOT Message/effects completion.
   * Accepted older source facts remain pending, independent of current lifecycle. */
  async handoff(receiptId: string) {
    const { receipt } = await this.readPayload(receiptId);
    // Also verify original conservation before acknowledging transport.
    await this.files.read(receipt.rawRef, receipt.rawDigest);
    return this.db.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, receipt.workspaceId);
      const result = await tx.ingressApplication.upsert({ where: { receiptId }, update: {},
        create: { receiptId, workspaceId: receipt.workspaceId, channelId: receipt.channelId } });
      await tx.ingressDelivery.update({ where: { receiptId }, data: { state: 'pending_application', consumedAt: new Date(), leaseToken: null, leaseUntil: null, lastError: null } });
      return result;
    });
  }
  /** Recovery may repeat a transport handoff, never create another receipt/source.
   * Leases protect publishers only, not lifecycle/domain authorization. */
  async recover(publisher: ConfirmedIngressPublisher, limit = 32) {
    const rows = await this.db.ingressDelivery.findMany({ where: { receipt: { transportNamespace: publisher.namespace }, ...(this.workspaceAllowlist ? { workspaceId: { in: [...this.workspaceAllowlist] } } : {}), state: { in: ['staged','routed'] }, nextAttemptAt: { lte: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, orderBy: { nextAttemptAt: 'asc' }, take: limit });
    let published = 0;
    for (const row of rows) {
      if (!publisher.ready) break;
      const token = randomUUID();
      const claimed = await this.db.ingressDelivery.updateMany({ where: { receiptId: row.receiptId, nextAttemptAt: { lte: new Date() }, state: { in: ['staged','routed'] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + publisher.deadlineMs + 10000) } });
      if (!claimed.count) continue;
      await this.publish(row.receiptId, publisher, 'incoming', token);
      published++;
    }
    return published;
  }
  async recoverDeadLetter(scope: { workspaceId: string; channelId: string; receiptId: string }) {
    // Explicit scoped operator command resets only transport retry budget. No
    // recertification, current eligibility or application completion is implied.
    this.assertAllowed(scope.workspaceId);
    return this.db.ingressDelivery.updateMany({ where: { ...scope, state: 'dead_letter' }, data: {
      state: 'staged', failures: 0, recoveries: { increment: 1 }, nextAttemptAt: new Date(), lastError: null, leaseToken: null, leaseUntil: null } });
  }
  /** Authorization belongs to the caller and runs before returning any scope/key.
   * Include unscoped events conservatively: they can affect this exact source.
   * A frontier only represents accepted transport facts, never history-live proof. */
  async frontier(input: { workspaceId: string; channelId: string; chatAddresses: string[];
    authorize: (tx: Tx) => Promise<void> }) {
    return this.db.$transaction(async tx => {
      await enterCanonicalWorkspaceTransaction(tx, input.workspaceId);
      await input.authorize(tx);
      this.assertAllowed(input.workspaceId);
      const rows = await tx.ingressFrontier.findMany({ where: { workspaceId: input.workspaceId, channelId: input.channelId,
        OR: [{ chatAddress: { in: input.chatAddresses } }, { chatAddress: null }],
        receipt: { delivery: { OR: [{ confirmedAt: { not: null } }, { consumedAt: { not: null } }] },
          OR: [{ application: null }, { application: { state: { not: 'applied' } } }] } }, orderBy: { id: 'asc' }, take: 1001,
        include: { receipt: { select: { id: true, source: true, ordinal: true, createdAt: true } } } });
      if (rows.length > 1000) throw new Error('Ingress frontier requires bounded catch-up before eligibility');
      return rows;
    });
  }
}
