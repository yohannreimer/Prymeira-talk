import { PrismaClient } from '@prisma/client';
import { readIngressEnvironment } from './modules/ingress/runtime.js';
import { IngressPrivateStore } from './modules/ingress/private-store.js';
import { IngressJournal } from './modules/ingress/journal.js';
import { record } from './modules/messaging/whatsapp-identity.js';
import { normalizeWhatsappPhone } from './modules/channels/channel-connections.js';

/** Bounded operator recovery. Raw and event digests are verified; application keeps original receipts and uses
 * recovered_live, never agents/automation or historical connection controls. Dry-run is the default. */
const args = process.argv.slice(2), apply = args.includes('--apply'), all = args.includes('--all-workspaces');
const workspaceId = args.find(a => !a.startsWith('--'));
const limit = Number(args.find(a => a.startsWith('--limit='))?.slice(8) ?? (apply ? 20 : 200));
const after = args.find(a => a.startsWith('--after-ordinal='))?.slice(16) ?? '0';
const config = readIngressEnvironment();
if ((!workspaceId && !all) || !Number.isSafeInteger(limit) || limit < 1 || limit > (apply ? 20 : 200) || !/^[0-9]+$/.test(after)
  || (all && !config.allowAllWorkspaces) || (workspaceId && !config.allowAllWorkspaces && !config.workspaceAllowlist.has(workspaceId))) {
  throw Error('Usage: repair-ingress <allowlisted-workspace>|--all-workspaces [--limit=20] [--after-ordinal=0] [--apply]');
}
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const files = new IngressPrivateStore(config.privateRoot);
  const journal = new IngressJournal(db, files, config.allowAllWorkspaces ? undefined : config.workspaceAllowlist);
  const rows = await db.ingressReceipt.findMany({ where: { ordinal: { gt: BigInt(after) }, transportNamespace: config.namespace,
    ...(workspaceId ? { workspaceId } : {}), delivery: { is: { state: 'dead_letter' } }, application: { is: null } },
    orderBy: { ordinal: 'asc' }, take: limit, include: { channel: { select: { archivedAt: true } } } });
  const counts: Record<string, number> = {};
  let requeued = 0;
  for (const receipt of rows) {
    let disposition = 'eligible';
    try {
      await files.read(receipt.rawRef, receipt.rawDigest); await journal.readPayload(receipt.id);
      if (receipt.channel.archivedAt) disposition = 'archived_channel';
      const original = record(receipt.source), accepted = normalizeWhatsappPhone(record(original.acceptedFacts).verifiedPhoneNumber as string | null | undefined);
      const physical = typeof original.connectionId === 'string' ? await db.channelConnection.findFirst({ where: { id: original.connectionId, workspaceId: receipt.workspaceId, channelId: receipt.channelId } }) : null;
      if (disposition === 'eligible' && (!physical || physical.status !== 'connected' || physical.lifecycleGeneration % 2 !== 0)) disposition = 'source_unavailable';
      if (disposition === 'eligible' && (!accepted || accepted !== normalizeWhatsappPhone(physical!.verifiedPhoneNumber) || original.sessionName !== physical!.sessionName)) disposition = 'number_or_session_unproven';
      if (apply && disposition === 'eligible') requeued += (await journal.recoverDeadLetter({ namespace: config.namespace, workspaceId: receipt.workspaceId, channelId: receipt.channelId, receiptId: receipt.id })).count;
    } catch { disposition = 'integrity_or_read_failure'; }
    counts[disposition] = (counts[disposition] ?? 0) + 1;
  }
  console.info(JSON.stringify({ apply, examined: rows.length, dispositions: counts, requeued, nextOrdinal: rows.at(-1)?.ordinal.toString() ?? after }));
} finally { await db.$disconnect(); }
