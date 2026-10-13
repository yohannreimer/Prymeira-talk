import { PrismaClient } from '@prisma/client';
import { repairPausedProspecting } from './modules/campaigns/paused-prospecting-repair.js';
const [workspaceId, ...args] = process.argv.slice(2);
const apply = args.includes('--apply'), names = args.filter(a => a !== '--apply');
if (!workspaceId || !names.length) throw new Error('Usage: repair-paused-prospecting <workspace-id> <exact-campaign-name> [...] [--apply]');
const db = new PrismaClient();
try { console.info(JSON.stringify(await repairPausedProspecting(db, { workspaceId, campaignNames: names, apply }))); }
finally { await db.$disconnect(); }
