import { PrismaClient } from '@prisma/client';
import { createCtwaTrackingBridge } from './modules/attribution/ctwa-tracking-bridge.js';
import { CtwaOperationError } from './modules/attribution/ctwa-service.js';
const args = process.argv.slice(2);
const values: Record<string, string | boolean> = {};
for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!['--workspace', '--event', '--apply'].includes(flag) || Object.hasOwn(values, flag))
        throw new Error('Usage: forward-ctwa-tracking --workspace <uuid> --event <conversion-row-uuid> [--apply]');
    if (flag === '--apply')
        values[flag] = true;
    else {
        const value = args[++index];
        if (!value || value.startsWith('--'))
            throw new Error('Missing operator argument');
        values[flag] = value;
    }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
if (typeof values['--workspace'] !== 'string' || typeof values['--event'] !== 'string' || !uuid.test(values['--workspace']) || !uuid.test(values['--event']))
    throw new Error('Explicit workspace UUID and conversion-row UUID required');
if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL required');
const db = new PrismaClient();
try {
    console.info(JSON.stringify(await createCtwaTrackingBridge(db, { secret: process.env.CTWA_TRACKING_CONFIG }).forward(values['--workspace'], values['--event'], values['--apply'] === true)));
}
catch (error) {
    console.error(JSON.stringify({ error: error instanceof CtwaOperationError ? error.reason : 'ctwa_tracking_failed' }));
    process.exitCode = 1;
}
finally {
    await db.$disconnect();
}
