import { assertCurrentMessagingSource, StaleMessagingSourceError } from './canonical-source.js';
import { Prisma, type CanonicalMessageIdentity, type Message } from '@prisma/client';
import type { CanonicalStoreResult } from './canonical-store.js';
import type { MessageEditPatch, NormalizedMessagingEvent, TrustedMessagingContext } from './normalized-event.js';
import { normalizeChatAddress, record, type WhatsAppMessageKey } from './whatsapp-identity.js';
import { json, equal, scopeOf, nativeLookupTuple } from './canonical-values.js';
import { enrichPresentation, prepareSnapshotFields, snapshotFieldConflict } from './canonical-presentation.js';
type Tx = Prisma.TransactionClient;
type Scope = { workspaceId: string; channelId: string };
type MessageEvent = Extract<NormalizedMessagingEvent, { kind: 'message' }>;
export type ActionEvent = Exclude<NormalizedMessagingEvent, { kind: 'message' | 'control' }>;
/** Trusted recovery result, never accepted directly from a webhook. The caller fetches
 * outside the transaction, then certifies the current revision against the captured
 * pending frontier and revisionVersion. Order timestamps are never certification.
 * Default calls require the complete frontier (at most 100 per collection). For
 * larger frontiers, read reconciliationFrontierInTransaction, fetch current proof
 * outside the transaction, then set partial:true to cover that page. Repeat with
 * a fresh requestId and CAS version; remaining items keep contentState pending.
 * Certificates append private observations. Receipts/media mirrors do not advance
 * the content revisionVersion. Never use receivedAt or cursor order as causality. */
export interface CanonicalRevisionEvidence {
  actionId: string; expectedRevisionVersion: number; pendingActionIds: string[]; pendingObservationIds?: string[]; partial?: boolean;
  target: WhatsAppMessageKey; revision: WhatsAppMessageKey; patch: MessageEditPatch;
  proof: { source: 'provider_current_revision'; requestId: string }
    | { source: 'authenticated_decryption'; requestId: string; currentRevisionRequestId: string; authorAddress: string; ivBase64: string; payloadBase64: string };
}
export interface CanonicalSnapshotEvidence {
  observationId: string; expectedRevisionVersion: number; pendingObservationIds: string[]; pendingActionIds?: string[]; partial?: boolean;
  target: WhatsAppMessageKey; proof: { source: 'provider_current_revision'; requestId: string };
}
interface IdentityOperations {
  digest(value: unknown): string;
  pendingTargetWhere(tx: Tx, identity: CanonicalMessageIdentity): Promise<Prisma.CanonicalActionWhereInput>;
  lockAndScope(tx: Tx, context: TrustedMessagingContext): Promise<unknown>;
  resolveActionTarget(tx: Tx, event: ActionEvent): Promise<{ reason?: string; identity?: CanonicalMessageIdentity }>;
  revisionTuple(tx: Tx, event: ActionEvent, identity: CanonicalMessageIdentity, key: WhatsAppMessageKey): Promise<unknown[] | null>;
  address(tx: Tx, scope: Scope, value: string): Promise<string>;
  graph(tx: Tx, scope: Scope): Promise<{ root(id: string): string; family(id: string): string[] }>;
}
/** State reducers share the store's identity graph, hash buckets and lock discipline.
 * No provider I/O belongs here. All evidence must be gathered before opening the transaction. */
export function createCanonicalReducers({ digest, lockAndScope, resolveActionTarget, revisionTuple, address, graph, pendingTargetWhere }: IdentityOperations) {
  const actionLookupHash = (revision: unknown[]) => digest([revision[3], revision[4], revision[5]]);
  /** A stores current chat/sender roots atomically in identity.fullTuple. Historical
   * action caches retain their immutable fields; never use their old roots as truth.
   * This keeps applied/superseded history queryable without rewriting it on a union. */
  function sameAction(scope: Scope, revision: unknown[]): Prisma.CanonicalActionWhereInput {
    return { ...scope, actionLookupHash: actionLookupHash(revision), AND: [
      ...[0, 1, 3, 4, 5, 6].map(index => ({ actionTuple: { path: [String(index)], equals: json(revision[index]) } })),
      { identity: { AND: [2, 7].map(index => ({ fullTuple: { path: [String(index)], equals: json(revision[index]) } })) } }
    ] };
  }
  function targetHash(event: ActionEvent | MessageEvent) {
    const key = event.kind === 'message' ? event.key : event.target;
    return digest([key.identityFormat, key.identityFormat === 'provider_native' ? event.context.provider : '',
      key.identityFormat === 'provider_native' ? key.nativeId : key.rawId]);
  }
  const contentActions = (scope: Scope, identityId: string): Prisma.CanonicalActionWhereInput => ({ ...scope, identityId,
    OR: [{ state: 'pending' }, { observation: { reason: 'receipt_key_conflict' } }], kind: { in: ['edit', 'encrypted_edit'] } });
  const contentSnapshots = (scope: Scope, identityId: string): Prisma.CanonicalObservationWhereInput => ({ ...scope, identityId, kind: 'message', state: 'held' });
  async function unboundContent(tx: Tx, identity: CanonicalMessageIdentity) {
    return tx.canonicalAction.count({ where: { ...await pendingTargetWhere(tx, identity), identityId: null,
      state: 'pending', kind: { in: ['edit', 'encrypted_edit', 'revoke'] } } });
  }

  /** Shared readiness gate for recovery and both certificate APIs. Content proof
   * never resolves a conflicting ingress receipt, even when it is a status event. */
  async function unfinishedContent(tx: Tx, identity: CanonicalMessageIdentity, { ignoreRecoveryBudget = false } = {}) {
    const scope = { workspaceId: identity.workspaceId, channelId: identity.channelId };
    if (await tx.canonicalAction.count({ where: contentActions(scope, identity.id) })) return true;
    if (await tx.canonicalObservation.count({ where: { ...contentSnapshots(scope, identity.id),
      ...(ignoreRecoveryBudget ? { OR: [{ reason: null }, { reason: { not: 'pending_recovery_budget_exhausted' } }] } : {}) } })) return true;
    if (await tx.canonicalObservation.count({ where: { ...scope, identityId: identity.id, reason: 'receipt_key_conflict' } })) return true;
    return await unboundContent(tx, identity) > 0;
  }
  async function certificate(tx: Tx, context: TrustedMessagingContext, identity: CanonicalMessageIdentity,
    sourceObservationId: string, evidence: CanonicalRevisionEvidence | CanonicalSnapshotEvidence, save = false) {
    const scope = scopeOf(context);
    const receiptTuple = ['canonical_reconciliation', context.provider, context.connectionId, context.sessionName, evidence.proof.source, evidence.proof.requestId, identity.id];
    const receiptHash = digest(receiptTuple);
    const bucket = await tx.canonicalObservation.findMany({ where: { ...scope, receiptHash, kind: 'reconciliation' } });
    const previous = bucket.find(row => equal(row.receiptTuple, receiptTuple));
    if (previous) {
      if (!equal(record(previous.payload).request, evidence)) throw new Error('Stale certificate: a fresh current-revision proof is required for each new page');
      return true;
    }
    if (save) await tx.canonicalObservation.create({ data: { ...scope, identityId: identity.id,
      channelProvider: context.channelProvider === 'meta' ? 'meta_cloud' : 'evolution', provider: context.provider,
      connectionProvider: context.connectionId ? context.provider : null, connectionId: context.connectionId,
      receiptHash, receiptTuple: json(receiptTuple), kind: 'reconciliation', eventType: 'canonical.reconciliation', mode: context.mode,
      source: evidence.proof.source, sessionName: context.sessionName, lifecycleGeneration: context.lifecycleGeneration,
      receivedAt: new Date(context.observedAt), sourceOrder: {}, state: 'resolved',
      payload: json({ request: evidence, certifiedBy: context, sourceObservationId }) } });
    return false;
  }
  async function reconciliationFrontierInTransaction(tx: Tx, context: TrustedMessagingContext, target: WhatsAppMessageKey) {
    await lockAndScope(tx, context);
    const probe: ActionEvent = { context, kind: 'revoke', target, action: target, providerEventId: null, providerEventType: 'canonical.frontier', addressMappings: [], order: { timestampMs: null, sequence: null } };
    const resolved = await resolveActionTarget(tx, probe);
    if (!resolved.identity) throw new Error(`Unresolved frontier: ${resolved.reason}`);
    const identity = resolved.identity, scope = scopeOf(context);
    const actions = await tx.canonicalAction.findMany({ where: contentActions(scope, identity.id), orderBy: { id: 'asc' }, take: 101, select: { id: true } });
    const snapshots = await tx.canonicalObservation.findMany({ where: contentSnapshots(scope, identity.id), orderBy: { id: 'asc' }, take: 101, select: { id: true } });
    const unresolvedTargets = await unboundContent(tx, identity);
    return { identityId: identity.id, revisionVersion: identity.revisionVersion, currentRevision: identity.currentRevision,
      pendingActionIds: actions.slice(0, 100).map(row => row.id), pendingObservationIds: snapshots.slice(0, 100).map(row => row.id),
      hasMore: actions.length > 100 || snapshots.length > 100 || unresolvedTargets > 0, unresolvedTargets };
  }
  async function applyPatch(tx: Tx, stored: Message, patch: MessageEditPatch, editedAt?: string) {
    const metadata = record(stored.metadata), attachment = record(metadata.attachment);
    if (patch.field === 'body' && stored.type !== 'text') return 'edit_type_conflict';
    if (patch.field === 'caption' && !['audio', 'image', 'file'].includes(stored.type)) return 'edit_type_conflict';
    let body = patch.field === 'body' ? patch.body : patch.caption;
    if (patch.field === 'caption') {
      if (stored.type === 'audio' && record(metadata.transcription).status === 'completed') body = stored.body ?? '';
      else if (!body) body = stored.type === 'audio' ? 'Áudio recebido' : stored.type === 'image' ? 'Imagem recebida'
        : String(attachment.mimeType ?? '').startsWith('video/') ? 'Vídeo recebido' : String(attachment.fileName ?? 'Arquivo recebido');
    }
    await tx.message.update({ where: { id: stored.id }, data: { body,
      metadata: json({ ...metadata, ...(editedAt ? { editedAt } : {}), ...(patch.field === 'caption' ? { attachment: { ...attachment, caption: patch.caption } } : {}) }) } });
    await tx.conversation.updateMany({ where: { id: stored.conversationId, lastMessageAt: stored.createdAt }, data: { lastMessagePreview: body } });
    return null;
  }
  async function reduceAction(tx: Tx, event: ActionEvent, observationId: string): Promise<CanonicalStoreResult> {
    const scope = scopeOf(event.context);
    const result: CanonicalStoreResult = { outcome: 'held', observationId, messageId: null, conversationId: null,
      chatId: null, identityId: null, allowOperationalEffects: false, changes: [], reconciliationReasons: [] };
    try { await assertCurrentMessagingSource(tx, event.context); } catch (error) {
      if (!(error instanceof StaleMessagingSourceError)) throw error;
      result.reconciliationReasons.push('stale_source'); return result;
    }
    const observation = await tx.canonicalObservation.findUniqueOrThrow({ where: { id: observationId } });
    if (observation.reason === 'receipt_key_conflict') { result.reconciliationReasons.push(observation.reason); return result; }
    const action = await tx.canonicalAction.upsert({ where: { observationId }, create: { ...scope, observationId,
      kind: event.kind, targetHash: targetHash(event), nativeTargetHash: digest(nativeLookupTuple(event.context, event.target)), target: json(event.target), actionKey: 'action' in event ? json(event.action) : Prisma.DbNull }, update: {} });
    result.actionId = action.id;
    if (action.state === 'applied' || action.state === 'superseded') {
      result.outcome = 'duplicate';
      if (action.identityId) {
        const identity = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: action.identityId } });
        Object.assign(result, { identityId: identity.id, messageId: identity.messageId, conversationId: identity.conversationId, chatId: identity.chatId });
      }
      return result;
    }
    const resolved = await resolveActionTarget(tx, event);
    let reason = resolved.reason;
    if (resolved.identity) {
      const identity = resolved.identity;
      Object.assign(result, { identityId: identity.id, messageId: identity.messageId, conversationId: identity.conversationId, chatId: identity.chatId });
      const stored = await tx.message.findUniqueOrThrow({ where: { id: identity.messageId } });
      if (event.kind === 'revoke') {
        if (!record(stored.metadata).deletedAt) {
          const body = stored.direction === 'outbound' ? 'Você apagou esta mensagem' : 'Esta mensagem foi apagada';
          await tx.message.update({ where: { id: stored.id }, data: { type: 'system', body, mediaUrl: null,
            metadata: { deletedAt: event.context.observedAt } } });
          await tx.conversation.updateMany({ where: { id: stored.conversationId, lastMessageAt: stored.createdAt }, data: { lastMessagePreview: body } });
          await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'deleted', revisionVersion: { increment: 1 } } });
          result.changes.push('message_revoked');
        }
      } else if (event.kind === 'receipt') {
        const group = identity.senderAddressId !== null;
        const recipient = event.recipient ? normalizeChatAddress(event.recipient) : '';
        if (recipient === null || (group && !recipient)) reason = 'receipt_recipient_missing';
        else {
          const recipientId = recipient ? await address(tx, scope, recipient) : '';
          const ranks = { failed: 0, pending: 0, sent: 1, delivered: 2, read: 3 };
          const family = recipientId ? (await graph(tx, scope)).family(recipientId) : [''];
          const rollups = await tx.canonicalRecipientReceipt.findMany({ where: { ...scope, identityId: identity.id, recipient: { in: family } } });
          const previous = rollups.find(row => row.recipient === recipientId);
          const played = String(event.providerStatus).toLowerCase() === 'played' || String(event.providerStatus) === (event.context.provider === 'waha' ? '4' : '5') || rollups.some(row => row.played);
          let status = played ? 'read' as const : event.status;
          for (const row of rollups) if (ranks[row.status] >= ranks[status]) status = row.status;
          if (!previous || previous.status !== status || (played && !previous.played)) {
            await tx.canonicalRecipientReceipt.upsert({ where: { workspaceId_channelId_identityId_recipient: { ...scope, identityId: identity.id, recipient: recipientId } },
              create: { ...scope, identityId: identity.id, recipient: recipientId, status, played }, update: { status, played } });
            result.changes.push('recipient_receipt_advanced');
          }
          const redirected = rollups.filter(row => row.recipient !== recipientId);
          if (redirected.length) {
            // Only derived rollups are compacted. Every provider observation/action
            // remains intact, and their Message UUIDs are never moved or replaced.
            await tx.canonicalRecipientReceipt.deleteMany({ where: { ...scope, id: { in: redirected.map(row => row.id) } } });
            result.changes.push('recipient_receipts_unified');
          }
          // A group receipt says nothing about the remaining recipients. Keep the
          // aggregate conservative until a certified membership denominator exists.
          if (!group && ranks[status] > ranks[stored.status]) {
            await tx.message.update({ where: { id: stored.id }, data: { status } });
            result.changes.push('message_status_advanced');
          }
        }
      } else if (!record(stored.metadata).deletedAt) {
        const revision = await revisionTuple(tx, event, identity, event.action);
        if (!revision) reason = 'incomplete_edit_authorship';
        else {
          await tx.canonicalAction.update({ where: { id: action.id }, data: { identityId: identity.id, actionHash: digest(revision), actionLookupHash: actionLookupHash(revision), actionTuple: json(revision) } });
          // Hashes select a bucket; full JSON tuples prove the action. Ask the
          // database for aggregate decisions, never materialize the historical
          // bucket (which can contain thousands of provider mirror observations).
          const same: Prisma.CanonicalActionWhereInput = { ...sameAction(scope, revision), id: { not: action.id } };
          const targetConflict = await tx.canonicalAction.count({ where: { ...same,
            OR: [{ identityId: null }, { identityId: { not: identity.id } }] } }) > 0;
          const payloadField = event.kind === 'edit' ? 'patch' : 'encrypted';
          const payloadValue = event.kind === 'edit' ? event.patch : event.encrypted;
          const conflict = await tx.canonicalAction.count({ where: { ...same, observation: {
            kind: event.kind, NOT: { payload: { path: [payloadField], equals: json(payloadValue) } }
          } } }) > 0;
          const knownResolvedPayload = await tx.canonicalAction.count({ where: { ...same, state: { in: ['applied', 'superseded'] },
            observation: { kind: event.kind, payload: { path: [payloadField], equals: json(payloadValue) } }
          } }) > 0;
          // Superseding an opaque ciphertext proves only that its exact bytes were
          // already handled. An unseen plaintext mirror needs the authenticated
          // patch certified for THIS action, never a newer identity revision.
          let certifiedPatchMatches = false, certifiedPatchConflicts = false, mixedEvidenceMissing = false;
          if (event.kind === 'edit' && !knownResolvedPayload) {
            const mixed: Prisma.CanonicalActionWhereInput = { ...same, state: { in: ['applied', 'superseded'] }, observation: { kind: 'encrypted_edit' } };
            const certified: Prisma.CanonicalActionWhereInput = { ...mixed,
              evidence: { path: ['request', 'proof', 'source'], equals: 'authenticated_decryption' } };
            const patch: Prisma.CanonicalActionWhereInput = { evidence: { path: ['request', 'patch'], equals: json(event.patch) } };
            certifiedPatchMatches = await tx.canonicalAction.count({ where: { AND: [certified, patch] } }) > 0;
            certifiedPatchConflicts = await tx.canonicalAction.count({ where: { ...certified, NOT: patch } }) > 0;
            mixedEvidenceMissing = !certifiedPatchMatches && await tx.canonicalAction.count({ where: mixed }) > 0;
          }
          // Compare the full cached revision and patch in SQL. Counting exact
          // conflicts is bounded in memory even for hundreds of identical mirrors.
          const unordered = identity.currentRevision === null && !record(stored.metadata).editedAt && await tx.canonicalAction.count({ where: {
            ...scope, identityId: identity.id, kind: { in: ['edit', 'encrypted_edit'] }, id: { not: action.id }, state: 'pending',
            OR: [{ actionTuple: { equals: Prisma.DbNull } }, { actionLookupHash: null }, { NOT: sameAction(scope, revision) },
              { observation: { kind: { not: 'edit' } } }, { observation: { reason: 'receipt_key_conflict' } },
              ...(event.kind === 'edit' ? [{ observation: { NOT: { payload: { path: ['patch'], equals: json(event.patch) } } } }] : [{}])]
          } }) > 0;
          if (targetConflict) reason = 'action_target_conflict';
          else if (knownResolvedPayload) { /* exact replay stays inert, including superseded actions */ }
          else if (conflict || certifiedPatchConflicts) reason = 'action_revision_conflict';
          else if (certifiedPatchMatches) { /* verified mixed-format mirror, no second application */ }
          else if (mixedEvidenceMissing) reason = 'mixed_revision_evidence_required';
          else if (event.kind === 'encrypted_edit') reason = 'decrypt_reconciliation_required';
          else if (identity.currentRevision !== null || record(stored.metadata).editedAt || unordered) reason = 'edit_order_unproven';
          else if (await unboundContent(tx, identity)) reason = 'edit_frontier_incomplete';
          else {
            reason = await applyPatch(tx, stored, event.patch, event.context.observedAt) ?? undefined;
            if (!reason) {
              await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { currentRevision: json(event.action), contentState: identity.contentState === 'pending_reconciliation' ? 'pending_reconciliation' : 'ready', revisionVersion: { increment: 1 } } });
              result.changes.push('message_edited');
            }
          }
        }
        if (reason) await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'pending_reconciliation' } });
      }
    }
    await tx.canonicalAction.update({ where: { id: action.id }, data: { identityId: result.identityId,
      attempts: { increment: 1 }, state: reason ? 'pending' : 'applied', reason: reason ?? null, appliedAt: reason ? null : new Date() } });
    await tx.canonicalObservation.update({ where: { id: observationId }, data: { identityId: result.identityId,
      state: reason ? 'held' : 'resolved', reason: reason ?? null } });
    if (reason) result.reconciliationReasons.push(reason);
    else result.outcome = result.changes.length ? 'enriched' : 'duplicate';
    return result;
  }
  async function bindPending(tx: Tx, pending: Prisma.CanonicalActionGetPayload<{ include: { observation: true } }>[], identityId?: string) {
    // Bind the entire bounded frontier before choosing any reduction. UUID/arrival
    // order cannot turn one of several pre-original edits into the current revision.
    const matching = [];
    for (const action of pending) {
      try { await assertCurrentMessagingSource(tx, (action.observation.payload as unknown as ActionEvent).context); } catch (error) {
        if (!(error instanceof StaleMessagingSourceError)) throw error;
        continue;
      }
      const resolved = await resolveActionTarget(tx, action.observation.payload as unknown as ActionEvent);
      if (resolved.identity && (!identityId || resolved.identity.id === identityId)) {
        matching.push(action);
        const payload = action.observation.payload as unknown as ActionEvent;
        const revision = payload.kind === 'edit' || payload.kind === 'encrypted_edit' ? await revisionTuple(tx, payload, resolved.identity, payload.action) : null;
        await tx.canonicalAction.update({ where: { id: action.id }, data: { identityId: resolved.identity.id,
          ...(revision ? { actionTuple: json(revision), actionHash: digest(revision), actionLookupHash: actionLookupHash(revision) } : {}) } });
        if (action.observation.reason === 'receipt_key_conflict') await tx.canonicalMessageIdentity.updateMany({ where: { id: resolved.identity.id, contentState: { not: 'deleted' } }, data: { contentState: 'pending_reconciliation' } });
      }
    }
    return matching;
  }
  async function recoverForMessage(tx: Tx, event: MessageEvent, result: CanonicalStoreResult) {
    const targetIdentity = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: result.identityId! } });
    const pending = await tx.canonicalAction.findMany({ where: { ...await pendingTargetWhere(tx, targetIdentity), state: 'pending' }, orderBy: { id: 'asc' }, take: 100, include: { observation: true } });
    const matching = await bindPending(tx, pending, result.identityId!);
    for (const action of matching) {
      const reduced = await reduceAction(tx, action.observation.payload as unknown as ActionEvent, action.observationId);
      if (reduced.identityId === result.identityId) result.changes.push(...reduced.changes);
    }
    const stored = await tx.message.findUniqueOrThrow({ where: { id: result.messageId! } });
    const identity = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: result.identityId! } });
    if (await unboundContent(tx, identity)) {
      if (!record(stored.metadata).deletedAt) await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'pending_reconciliation' } });
      result.outcome = 'held'; result.allowOperationalEffects = false;
      if (!result.reconciliationReasons.length) {
        result.reconciliationReasons.push('pending_recovery_budget_exhausted');
        await tx.canonicalObservation.update({ where: { id: result.observationId }, data: { state: 'held', reason: 'pending_recovery_budget_exhausted' } });
      }
    }
    if (record(stored.metadata).deletedAt || identity.contentState === 'pending_reconciliation') result.allowOperationalEffects = false;
  }
  async function recoverPendingInTransaction(tx: Tx, context: TrustedMessagingContext, options: { afterId?: string; limit?: number } = {}) {
    await lockAndScope(tx, context);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Recovery limit must be 1..100');
    const rows = await tx.canonicalAction.findMany({ where: { ...scopeOf(context), state: 'pending', ...(options.afterId ? { id: { gt: options.afterId } } : {}) }, orderBy: { id: 'asc' }, take: limit + 1, include: { observation: true } });
    await bindPending(tx, rows.slice(0, limit));
    const results: CanonicalStoreResult[] = [];
    for (const row of rows.slice(0, limit)) {
      const result = await reduceAction(tx, row.observation.payload as unknown as ActionEvent, row.observationId);
      if (result.identityId) {
        const identity = await tx.canonicalMessageIdentity.findUniqueOrThrow({ where: { id: result.identityId } });
        const scope = scopeOf(context);
        // Readiness is derived from the actual remaining frontier, regardless of
        // whether the original ever acquired a recovery-budget observation.
        if (!await unfinishedContent(tx, identity, { ignoreRecoveryBudget: true })) {
          const cleared = await tx.canonicalObservation.updateMany({ where: { ...contentSnapshots(scope, identity.id), reason: 'pending_recovery_budget_exhausted' }, data: { state: 'resolved', reason: null } });
          let becameReady = false;
          if (identity.contentState === 'pending_reconciliation') {
            const message = await tx.message.findUniqueOrThrow({ where: { id: identity.messageId }, select: { metadata: true } });
            becameReady = !record(message.metadata).deletedAt;
            await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: becameReady ? 'ready' : 'deleted' } });
          }
          if (becameReady || cleared.count) { result.changes.push('pending_recovery_completed'); result.outcome = 'enriched'; }
        }
      }
      results.push(result);
    }
    // A newly applied revision/tombstone may settle earlier pages. Finish this
    // cursor sweep, then revisit from the start when this flag is returned.
    return { results, revisitFromStart: results.some(result => result.changes.some(change => ['message_edited', 'message_revoked'].includes(change))), hasMore: rows.length > limit, nextCursor: rows.length ? rows[Math.min(rows.length, limit) - 1]!.id : null };
  }
  async function reconcileRevisionInTransaction(tx: Tx, context: TrustedMessagingContext, evidence: CanonicalRevisionEvidence): Promise<CanonicalStoreResult> {
    await lockAndScope(tx, context);
    const scope = scopeOf(context);
    if (!evidence.proof.requestId || evidence.pendingActionIds.length > 100 || (evidence.pendingObservationIds?.length ?? 0) > 100) throw new Error('Invalid revision proof');
    const action = await tx.canonicalAction.findFirst({ where: { ...scope, id: evidence.actionId }, include: { observation: true } });
    if (!action || !['edit', 'encrypted_edit'].includes(action.kind) || ['receipt_key_conflict', 'action_target_conflict'].includes(action.observation.reason ?? '')) throw new Error('Invalid revision action');
    const original = action.observation.payload as unknown as Extract<ActionEvent, { kind: 'edit' | 'encrypted_edit' }>;
    const scoped = { ...original, context, target: evidence.target };
    const resolved = await resolveActionTarget(tx, scoped);
    if (!resolved.identity || resolved.identity.id !== action.identityId) throw new Error('Invalid revision target scope');
    const identity = resolved.identity;
    const revision = await revisionTuple(tx, scoped, identity, evidence.revision);
    const expected = await revisionTuple(tx, original, identity, original.action);
    if (!revision || !expected || !equal(revision, expected)) throw new Error('Invalid certified revision');
    const result: CanonicalStoreResult = { outcome: 'duplicate', actionId: action.id, observationId: action.observationId,
      identityId: identity.id, messageId: identity.messageId, conversationId: identity.conversationId, chatId: identity.chatId,
      allowOperationalEffects: false, reconciliationReasons: [], changes: [] };
    if (await certificate(tx, context, identity, action.observationId, evidence)) return result;
    if ((!evidence.partial && action.state !== 'pending') || identity.revisionVersion !== evidence.expectedRevisionVersion) throw new Error('Stale revision evidence');
    const pending = await tx.canonicalAction.findMany({ where: { ...contentActions(scope, identity.id), ...(evidence.partial ? { id: { in: evidence.pendingActionIds ?? [] } } : {}) }, orderBy: { id: 'asc' }, take: 101, include: { observation: true } });
    if (pending.length > 100 || !equal(pending.map(row => row.id).sort(), [...new Set(evidence.pendingActionIds)].sort())) throw new Error('Stale pending revision frontier');
    if (pending.some(row => row.observation.reason === 'receipt_key_conflict')) throw new Error('Conflicting ingress receipt requires separate review');
    const snapshots = await tx.canonicalObservation.findMany({ where: { ...contentSnapshots(scope, identity.id), ...(evidence.partial ? { id: { in: evidence.pendingObservationIds ?? [] } } : {}) }, orderBy: { id: 'asc' }, take: 101 });
    if (snapshots.length > 100 || !equal(snapshots.map(row => row.id).sort(), [...new Set(evidence.pendingObservationIds ?? [])].sort())) throw new Error('Stale snapshot frontier');
    if (snapshots.some(row => row.reason === 'receipt_key_conflict')) throw new Error('Conflicting ingress receipt requires separate review');
    if (original.kind === 'encrypted_edit') {
      const proof = evidence.proof;
      if (proof.source !== 'authenticated_decryption' || !proof.currentRevisionRequestId || proof.ivBase64 !== original.encrypted.ivBase64 || proof.payloadBase64 !== original.encrypted.payloadBase64
        || !normalizeChatAddress(proof.authorAddress) || !original.encrypted.senderJids.some(jid => normalizeChatAddress(jid) === normalizeChatAddress(proof.authorAddress))) throw new Error('Invalid decryption evidence');
      if (identity.senderAddressId) {
        const author = await address(tx, scope, proof.authorAddress), g = await graph(tx, scope);
        if (g.root(author) !== g.root(identity.senderAddressId)) throw new Error('Invalid decryption author');
      }
    } else if (evidence.proof.source !== 'provider_current_revision') throw new Error('Invalid snapshot evidence');
    const stored = await tx.message.findUniqueOrThrow({ where: { id: identity.messageId } });
    if (record(stored.metadata).deletedAt) {
      result.outcome = 'held'; result.reconciliationReasons.push('tombstone_dominates'); return result;
    }
    const fields = prepareSnapshotFields(stored, snapshots.map(row => row.payload as unknown as MessageEvent), evidence.patch, equal, { supersedeContent: true });
    if (fields.conflict) {
      result.outcome = 'held'; result.reconciliationReasons.push('snapshot_field_conflict'); return result;
    }
    const reason = await applyPatch(tx, fields.message, evidence.patch, context.observedAt);
    if (reason) throw new Error(reason);
    await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { currentRevision: json(evidence.revision), contentState: 'ready', revisionVersion: { increment: 1 } } });
    await tx.canonicalAction.updateMany({ where: { id: { in: pending.map(row => row.id) } }, data: { state: 'superseded', reason: 'certified_current_revision' } });
    await tx.canonicalObservation.updateMany({ where: { id: { in: pending.map(row => row.observationId) } }, data: { state: 'resolved', reason: 'certified_current_revision' } });
    await tx.canonicalObservation.updateMany({ where: { id: { in: snapshots.map(row => row.id) } }, data: { state: 'resolved', reason: 'certified_current_revision' } });
    await tx.canonicalAction.update({ where: { id: action.id }, data: { state: 'applied', reason: null, appliedAt: new Date(), evidence: json({ request: evidence, certifiedBy: context }) } });
    await certificate(tx, context, identity, action.observationId, evidence, true);
    if (await unfinishedContent(tx, identity)) {
      await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'pending_reconciliation' } });
      result.outcome = 'held'; result.reconciliationReasons.push('reconciliation_frontier_remaining'); result.changes.push('reconciliation_frontier_advanced'); return result;
    }
    result.outcome = 'enriched'; result.changes.push('revision_reconciled');
    return result;
  }
  async function reconcileSnapshotInTransaction(tx: Tx, context: TrustedMessagingContext, evidence: CanonicalSnapshotEvidence): Promise<CanonicalStoreResult> {
    await lockAndScope(tx, context);
    const scope = scopeOf(context);
    if (evidence.proof.source !== 'provider_current_revision' || !evidence.proof.requestId || evidence.pendingObservationIds.length > 100 || (evidence.pendingActionIds?.length ?? 0) > 100) throw new Error('Invalid snapshot proof');
    const observation = await tx.canonicalObservation.findFirst({ where: { ...scope, id: evidence.observationId, kind: 'message' } });
    if (!observation || observation.reason === 'receipt_key_conflict' || !observation.identityId) throw new Error('Invalid snapshot observation');
    const snapshot = observation.payload as unknown as MessageEvent;
    const targetEvent: ActionEvent = { ...snapshot, context, kind: 'revoke', target: evidence.target, action: evidence.target };
    const resolved = await resolveActionTarget(tx, targetEvent);
    if (!resolved.identity || resolved.identity.id !== observation.identityId) throw new Error('Invalid snapshot target scope');
    const identity = resolved.identity;
    const result: CanonicalStoreResult = { outcome: 'duplicate', observationId: observation.id, identityId: identity.id,
      messageId: identity.messageId, conversationId: identity.conversationId, chatId: identity.chatId,
      allowOperationalEffects: false, changes: [], reconciliationReasons: [] };
    if (await certificate(tx, context, identity, observation.id, evidence)) return result;
    if (identity.revisionVersion !== evidence.expectedRevisionVersion) throw new Error('Stale snapshot version');
    if (identity.currentRevision !== null && snapshot.currentRevision === null) throw new Error('Stale original snapshot');
    if (snapshot.currentRevision && !await revisionTuple(tx, targetEvent, identity, snapshot.currentRevision)) throw new Error('Invalid snapshot revision scope');
    const pendingActions = await tx.canonicalAction.findMany({ where: { ...contentActions(scope, identity.id), ...(evidence.partial ? { id: { in: evidence.pendingActionIds ?? [] } } : {}) }, orderBy: { id: 'asc' }, take: 101, include: { observation: true } });
    if (pendingActions.length > 100 || !equal(pendingActions.map(row => row.id).sort(), [...new Set(evidence.pendingActionIds ?? [])].sort())) throw new Error('Stale snapshot action frontier');
    if (await tx.canonicalAction.count({ where: { ...contentActions(scope, identity.id), kind: 'encrypted_edit' } })) throw new Error('Encrypted actions require decryption evidence');
    if (pendingActions.some(row => row.observation.reason === 'receipt_key_conflict')) throw new Error('Conflicting ingress receipt requires separate review');
    if (pendingActions.length && !snapshot.currentRevision) throw new Error('Current snapshot revision required');
    const pending = await tx.canonicalObservation.findMany({ where: { ...contentSnapshots(scope, identity.id), ...(evidence.partial ? { id: { in: evidence.pendingObservationIds ?? [] } } : {}) }, orderBy: { id: 'asc' }, take: 101 });
    if (pending.length > 100 || !equal(pending.map(row => row.id).sort(), [...new Set(evidence.pendingObservationIds)].sort())) throw new Error('Stale snapshot frontier');
    if (pending.some(row => row.reason === 'receipt_key_conflict')) throw new Error('Conflicting ingress receipt requires separate review');
    const stored = await tx.message.findUniqueOrThrow({ where: { id: identity.messageId } });
    if (record(stored.metadata).deletedAt) { result.outcome = 'held'; result.reconciliationReasons.push('tombstone_dominates'); return result; }
    if (stored.type !== snapshot.content.type) throw new Error('Snapshot type conflict');
    const patch: MessageEditPatch | null = stored.type === 'text' && snapshot.content.body !== null ? { field: 'body', body: snapshot.content.body }
      : typeof snapshot.attachment.caption === 'string' ? { field: 'caption', caption: snapshot.attachment.caption } : null;
    if (snapshotFieldConflict(stored, snapshot, patch, equal)) {
      await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'pending_reconciliation' } });
      await tx.canonicalObservation.update({ where: { id: observation.id }, data: { state: 'held', reason: 'snapshot_field_conflict' } });
      result.outcome = 'held'; result.reconciliationReasons.push('snapshot_field_conflict'); return result;
    }
    if (patch) {
      const reason = await applyPatch(tx, stored, patch, snapshot.currentRevision ? context.observedAt : undefined);
      if (reason) throw new Error(reason);
    }
    const current = await tx.message.findUniqueOrThrow({ where: { id: stored.id } });
    const { data } = enrichPresentation(current, snapshot, equal);
    if (Object.keys(data).length) await tx.message.update({ where: { id: stored.id }, data });
    await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { currentRevision: snapshot.currentRevision ? json(snapshot.currentRevision) : Prisma.DbNull, contentState: 'ready', revisionVersion: { increment: 1 } } });
    await tx.canonicalObservation.updateMany({ where: { id: { in: pending.map(row => row.id) } }, data: { state: 'resolved', reason: 'certified_current_snapshot' } });
    await tx.canonicalAction.updateMany({ where: { id: { in: pendingActions.map(row => row.id) } }, data: { state: 'superseded', reason: 'certified_current_snapshot' } });
    await tx.canonicalObservation.updateMany({ where: { id: { in: pendingActions.map(row => row.observationId) } }, data: { state: 'resolved', reason: 'certified_current_snapshot' } });
    await tx.canonicalObservation.update({ where: { id: observation.id }, data: { resolutionEvidence: json({ request: evidence, certifiedBy: context }) } });
    await certificate(tx, context, identity, observation.id, evidence, true);
    if (await unfinishedContent(tx, identity)) {
      await tx.canonicalMessageIdentity.update({ where: { id: identity.id }, data: { contentState: 'pending_reconciliation' } });
      result.outcome = 'held'; result.reconciliationReasons.push('reconciliation_frontier_remaining'); result.changes.push('reconciliation_frontier_advanced'); return result;
    }
    result.outcome = 'enriched'; result.changes.push('snapshot_reconciled');
    return result;
  }
  return { reduceAction, recoverForMessage, recoverPendingInTransaction, reconciliationFrontierInTransaction, reconcileRevisionInTransaction, reconcileSnapshotInTransaction };
}
