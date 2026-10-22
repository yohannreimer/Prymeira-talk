import { PrismaClient } from '@prisma/client';
import { IngressPrivateStore } from './modules/ingress/private-store.js';
import { CtwaReceiptImportError, ctwaReceiptImportInput, prepareCtwaReceipt } from './modules/attribution/ctwa-receipt-import.js';

const args = process.argv.slice(2);
const values: Record<string, string | boolean> = {};
for (let index = 0; index < args.length; index++) {
  const flag = args[index]!;
  if (!['--workspace', '--receipt', '--event-index', '--apply'].includes(flag) || Object.hasOwn(values, flag))
    throw new Error('Usage: prepare-ctwa-receipt --workspace <id> --receipt <uuid> --event-index <n> [--apply]');
  if (flag === '--apply') values[flag] = true;
  else {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing operator argument');
    values[flag] = value;
  }
}
const index = values['--event-index'];
if (typeof index !== 'string' || !/^\d+$/.test(index)) throw new Error('Explicit event index required');
const input = ctwaReceiptImportInput.parse({ workspaceId: values['--workspace'], receiptId: values['--receipt'],
  eventIndex: Number(index), apply: values['--apply'] === true });
if (!process.env.DATABASE_URL || !process.env.INGRESS_PRIVATE_ROOT) throw new Error('DATABASE_URL and INGRESS_PRIVATE_ROOT required');
const db = new PrismaClient();
try {
  // Do not initialize/mkdir storage: dry run reads existing objects only.
  const result = await prepareCtwaReceipt(db, new IngressPrivateStore(process.env.INGRESS_PRIVATE_ROOT), input);
  console.info(JSON.stringify(result));
} catch (error) {
  // Database and filesystem errors can contain connection strings or private paths.
  console.error(JSON.stringify({ error: error instanceof CtwaReceiptImportError ? error.reason : 'ctwa_receipt_import_failed' }));
  process.exitCode = 1;
} finally { await db.$disconnect(); }
