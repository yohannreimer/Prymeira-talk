import { PrismaClient } from '@prisma/client';
import { readIngressEnvironment } from './modules/ingress/runtime.js';
import { IngressPrivateStore } from './modules/ingress/private-store.js';
import { IngressJournal } from './modules/ingress/journal.js';
const config = readIngressEnvironment();
const [workspaceId, channelId, receiptId] = process.argv.slice(2);
if (!workspaceId || !channelId || !receiptId || !config.workspaceAllowlist.has(workspaceId)) throw new Error('Usage: ingress-recover <allowlisted-workspace> <channel-uuid> <receipt-uuid>');
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const files = new IngressPrivateStore(config.privateRoot); await files.initialize();
  const result = await new IngressJournal(db, files, config.workspaceAllowlist).recoverDeadLetter({ namespace: config.namespace, workspaceId, channelId, receiptId });
  console.info(JSON.stringify({ transportRecoveryQueued: result.count === 1, applicationCompleted: false }));
} finally { await db.$disconnect(); }
