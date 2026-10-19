import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
const guardedMessagingDatabase = (value: string) => {
    const u = new URL(value);
    if (u.hostname !== '127.0.0.1' || u.pathname !== '/messaging_test')
        throw Error('test DB only');
    return value;
};
const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe.skipIf(!url)('persistent outbound additive schema', () => {
    it('persists intents, attempts, append-only results, bindings and explicit correlations with scoped foreign keys', async () => {
        const db = new Client({ connectionString: guardedMessagingDatabase(url!) });
        await db.connect();
        try {
            const rows = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename);
            expect(rows).toEqual(expect.arrayContaining([
                'outbound_intents', 'outbound_attempts', 'outbound_results', 'outbound_bindings', 'outbound_correlations', 'outbound_recertifications'
            ]));
            const fks = (await db.query("SELECT conrelid::regclass::text AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text LIKE 'outbound_%'")).rows;
            expect(fks.length).toBeGreaterThanOrEqual(10);
            expect(fks.every(r => r.definition.includes('workspace_id') && (r.definition.includes('channel_id') || r.definition.includes('conversation_id, message_id')))).toBe(true);
            const unique = (await db.query("SELECT indexdef FROM pg_indexes WHERE tablename='outbound_intents'")).rows.map(r => r.indexdef).join('\n');
            expect(unique).toContain('origin_kind, origin_id, action_ordinal, request_key');
        }
        finally {
            await db.end();
        }
    });
});
