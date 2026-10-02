import { PrismaClient } from '@prisma/client';
import { repairWahaNotices } from './modules/channels/waha-notice-repair.js';

const [workspaceId, flag] = process.argv.slice(2);
if (!workspaceId || (flag !== undefined && flag !== '--apply')) throw new Error('Usage: repair-waha-notices <workspace-id> [--apply]   (without --apply it only counts)');
const db = new PrismaClient();
try {
  console.info(JSON.stringify({ workspaceId, apply: flag === '--apply', ...(await repairWahaNotices(db, { workspaceId, apply: flag === '--apply' })) }));
} finally { await db.$disconnect(); }
