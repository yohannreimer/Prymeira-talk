import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { IngressPrivateStore } from './private-store.js';
import { IngressJournal } from './journal.js';
import { IngressApplicationService } from './application.js';
import { normalizeReceipt } from './normalization.js';
import { deriveTrustedMessagingContext } from '../messaging/canonical-source.js';
import { createEffectHandlers } from './effect-handlers.js';
import { createEffectRunner } from './effect-runner.js';
import { writeQualificationEvidence } from '../../test/qualification-evidence.js';
const url = process.env.MIGRATION_TEST_DATABASE_URL;
const BASE = '27fa3a06513d459e594f69c883fd777913764c5d';
const MIGRATION = '20261019150000_history_realtime_effects';
describe.skipIf(!url)('immutable 82 -> 83 migration upgrade qualification', () => {
  it('preserves populated media, receipts, canonical IDs and checkpoints and runs compatible presentation obligations', async () => {
    const startedAt = new Date().toISOString(), target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.port !== (process.env.TALK_TEST_POSTGRES_PORT ?? '55439') || target.pathname !== '/talk_upgrade_test') throw Error('Owned dedicated upgrade fixture required');
    const db = new PrismaClient({ datasources: { db: { url } } }), sql = new Client({ connectionString: url }), blocker = new Client({ connectionString: url });
    await sql.connect(); await blocker.connect();
    const root = resolve(process.cwd(), '../..'), workspaceId = `upgrade-${randomUUID()}`;
    await mkdir(resolve(process.cwd(), '../../validation-artifacts'), { recursive: true });
    const privateRoot = await mkdtemp(resolve(process.cwd(), '../../validation-artifacts/upgrade-private-'));
    try {
      const ledger = await sql.query('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name');
      expect(ledger.rows).toHaveLength(82); expect(ledger.rows.some(r => r.migration_name === MIGRATION)).toBe(false);
      for (const row of ledger.rows) {
        const immutable = execFileSync('git', ['show', `${BASE}:apps/api/prisma/migrations/${row.migration_name}/migration.sql`], { cwd: root });
        expect(createHash('sha256').update(immutable).digest('hex')).toBe(row.checksum);
      }
      expect(await readFile(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')).toBe(execFileSync('git', ['show', `${BASE}:apps/api/prisma/schema.prisma`], { cwd: root, encoding: 'utf8' }));
      const unchangedSources = ['effect-handlers.ts', 'effect-runner.ts'];
      for (const file of unchangedSources) expect(await readFile(resolve(process.cwd(), `src/modules/ingress/${file}`), 'utf8')).toBe(execFileSync('git', ['show', `${BASE}:apps/api/src/modules/ingress/${file}`], { cwd: root, encoding: 'utf8' }));
      const checkpoint = new Date('2026-10-19T13:31:31.133Z');
      const channel = await db.channel.create({ data: { workspaceId, provider: 'evolution', providerKey: randomUUID(), verifiedMessagingPhoneNumber: '15550008888', historyImportStatus: 'completed' } });
      const connection = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'evolution', sessionName: channel.providerKey, verifiedPhoneNumber: '15550008888', status: 'connected', eligible: true, recoveredThroughAt: checkpoint } });
      const files = new IngressPrivateStore(privateRoot); await files.initialize();
      const journal = new IngressJournal(db, files, new Set([workspaceId]));
      const source = await db.$transaction(tx => deriveTrustedMessagingContext(tx, { workspaceId, channelId: channel.id, authenticatedSource: { provider: 'evolution', connectionId: connection.id }, mode: 'live', observedAt: new Date().toISOString() }));
      const raw = { event: 'messages.upsert', instance: connection.sessionName, data: { key: { id: 'upgrade-original', remoteJid: '15550001111@s.whatsapp.net', fromMe: false }, messageTimestamp: 1700000010, message: { conversation: 'synthetic immutable upgrade fixture' } } };
      const receipt = await journal.stage({ transportNamespace: 'talk.isolated.upgrade', source, raw: Buffer.from(JSON.stringify(raw)), payload: normalizeReceipt(source, raw), authentication: 'synthetic', reauthenticate: async () => {} });
      await new IngressApplicationService(journal).apply(receipt.id);
      const message = await db.message.findFirstOrThrow({ where: { workspaceId } });
      const media = await db.messageMedia.create({ data: { workspaceId, conversationId: message.conversationId, messageId: message.id, state: 'stored', sourceKind: 'synthetic', mimeType: 'image/png', sha256: 'a'.repeat(64), originalRef: 'synthetic-upgrade.png', sizeBytes: 1 } });
      const identities = await db.canonicalMessageIdentity.findMany({ where: { workspaceId } });
      const oldEffects = await db.ingressEffect.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }); expect(oldEffects.length).toBeGreaterThan(0);
      const migrationSql = await readFile(resolve(process.cwd(), `prisma/migrations/${MIGRATION}/migration.sql`), 'utf8');
      const firstPhase = migrationSql.slice(0, migrationSql.indexOf('COMMIT;') + 7);
      const originalConstraint = (await sql.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='ingress_effects_origin_check'")).rows[0].definition;
      await blocker.query('BEGIN'); await blocker.query('LOCK TABLE ingress_effects IN ACCESS SHARE MODE');
      try { await expect(sql.query(firstPhase)).rejects.toMatchObject({ code: '55P03' }); } finally { await sql.query('ROLLBACK'); await blocker.query('ROLLBACK'); }
      expect((await sql.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='ingress_effects_origin_check'")).rows[0].definition).toBe(originalConstraint);
      execFileSync('pnpm', ['exec','prisma','migrate','deploy','--schema','prisma/schema.prisma'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000 });
      const candidateLedger = await sql.query('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name');
      expect(candidateLedger.rows).toHaveLength(83); expect(candidateLedger.rows.slice(0,82)).toEqual(ledger.rows);
      expect(candidateLedger.rows[82].checksum).toBe(createHash('sha256').update(migrationSql).digest('hex'));
      expect((await sql.query("SELECT convalidated FROM pg_constraint WHERE conname='ingress_effects_origin_check'")).rows).toEqual([{ convalidated: true }]);
      expect(await db.messageMedia.findUniqueOrThrow({ where: { messageId: message.id } })).toEqual(media);
      expect(await db.canonicalMessageIdentity.findMany({ where: { workspaceId } })).toEqual(identities);
      expect(await db.ingressEffect.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } })).toEqual(oldEffects);
      expect((await db.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })).recoveredThroughAt).toEqual(checkpoint);
      expect(await db.ingressReceipt.count({ where: { id: receipt.id } })).toBe(1);
      const effectData = { workspaceId, channelId: channel.id, messageId: message.id, conversationId: message.conversationId, kind: 'realtime.message', logicalKey: randomUUID(), cause: { origin: 'canonical_history' }, frozen: { presentationOnly: true, dependsOn: [] } };
      for (const invalid of [ { eventIndex: 0 }, { receiptId: receipt.id }, { messageId: null }, { conversationId: null }, { kind: 'assistant.message' }, { cause: { origin: 'unknown' } }, { workspaceId: 'wrong-tenant' } ])
        await expect(db.ingressEffect.create({ data: { ...effectData, ...invalid, logicalKey: randomUUID() } })).rejects.toThrow();
      // VALIDATE's SHARE UPDATE EXCLUSIVE lock remains compatible with ordinary DML.
      await blocker.query('BEGIN'); await blocker.query('LOCK TABLE ingress_effects IN SHARE UPDATE EXCLUSIVE MODE');
      let presentation;
      try { presentation = await db.ingressEffect.create({ data: effectData }); } finally { await blocker.query('ROLLBACK'); }
      const published: unknown[] = [], handlers = createEffectHandlers({ db, realtime: { publish: event => published.push(event) } });
      const runner = createEffectRunner({ db, workerId: 'synthetic-upgrade', workspaceIds: [workspaceId], handlers: { 'realtime.message': handlers['realtime.message']! } });
      await runner.drain(100);
      expect((await db.ingressEffect.findUniqueOrThrow({ where: { id: presentation.id } })).state).toBe('done'); expect(published.length).toBeGreaterThan(0);
      // Execute the actual immutable old WAHA reader with the new cursor. Unknown v2 is
      // discarded and rescanned from the unchanged original checkpoint.
      const oldSource = execFileSync('git', ['show', `${BASE}:apps/api/src/modules/channels/waha-history-recovery.ts`], { cwd: root, encoding: 'utf8' });
      const oldPath = resolve(process.cwd(), 'src/modules/channels/.upgrade-old-waha.ts');
      await writeFile(oldPath, oldSource);
      try {
        const old = await import(/* @vite-ignore */ oldPath);
        const waha = await db.channelConnection.create({ data: { workspaceId, channelId: channel.id, provider: 'waha', sessionName: randomUUID(), status: 'connected', eligible: true, verifiedPhoneNumber: '15550008888', recoveredThroughAt: checkpoint,
          historyRecoveryCursor: { version: 2, generation: 0, checkpoint: checkpoint.toISOString(), from: 0, to: 1, offset: 100, pages: [], previousPages: null, changedPasses: 0 } } });
        const reads: Array<{ from: number; offset: number }> = [];
        await old.recoverWahaWindow(db, waha, { read: async (query: { from: number; offset: number }) => { reads.push(query); return { messages: [], rawDigest: 'a'.repeat(64), rawCount: 0, nextOffset: query.offset, exhausted: true }; }, persist: async () => ({ inserted: 0, held: 0 }) }, { maxPages: 1, now: checkpoint.getTime() + 600_000 });
        expect(reads[0]).toMatchObject({ offset: 0, from: Math.floor((checkpoint.getTime() - 600_000)/1000) });
        expect((await db.channelConnection.findUniqueOrThrow({ where: { id: waha.id } })).recoveredThroughAt).toEqual(checkpoint);
      } finally { await rm(oldPath, { force: true }); }
      await writeQualificationEvidence('upgrade', startedAt, { baselineSha: BASE, baselineMigrations: 82, candidateMigrations: 83, preservedCanonicalIdentities: identities.length,
        preservedReceiptBackedEffects: oldEffects.length, preservedMedia: 1, checkpointPreserved: true, validatedConstraint: true, ledgerChecksumsVerified: true,
        lockTimeoutAtomicRollback: true, validationLockDmlCompatible: true, invalidCoordinatesRejected: 7, unchangedHandlers: unchangedSources,
        presentationObligationCompleted: true, oldWahaCursorRescannedOriginalCheckpoint: true, realProviderImageQualified: false });
    } finally {
      const where = { workspaceId };
      await db.ingressEffect.deleteMany({ where }); await db.ingressReceipt.deleteMany({ where });
      await db.canonicalChatAuthorityResolution.deleteMany({ where }); await db.canonicalAction.deleteMany({ where }); await db.canonicalRecipientReceipt.deleteMany({ where });
      await db.canonicalAddressEvidence.deleteMany({ where }); await db.canonicalObservation.deleteMany({ where }); await db.canonicalNativeAlias.deleteMany({ where }); await db.canonicalMessageIdentity.deleteMany({ where });
      await db.canonicalChatMember.deleteMany({ where }); await db.canonicalChat.deleteMany({ where }); await db.canonicalAddressAlias.deleteMany({ where });
      await db.canonicalAddress.updateMany({ where, data: { redirectId: null } }); await db.canonicalAddress.deleteMany({ where }); await db.channel.deleteMany({ where }); await db.contact.deleteMany({ where });
      await db.$disconnect(); await sql.end(); await blocker.end(); await rm(privateRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
