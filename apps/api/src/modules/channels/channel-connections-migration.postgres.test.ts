import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.CONNECTIONS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('connection migration on legacy PostgreSQL channels', () => {
  it('backfills Evolution physical identities and writers while preserving logical data, settings, history and Meta', async () => {
    const target = new URL(databaseUrl!);
    if (!['postgresql:', 'postgres:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname) || !['/campaign_test', '/connections_test'].includes(target.pathname)) throw new Error('Allowlisted local disposable connection database required.');
    const client = new Client({ connectionString: databaseUrl });
    const schema = `connection_backfill_${randomUUID().replaceAll('-', '')}`;
    const evolutionId = randomUUID(); const metaId = randomUUID();
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TYPE "ChannelStatus" AS ENUM ('connected', 'connecting', 'disconnected', 'failed');
        CREATE TABLE channels (id UUID PRIMARY KEY, workspace_id TEXT NOT NULL, provider TEXT NOT NULL, provider_key TEXT NOT NULL, status "ChannelStatus" NOT NULL, phone_number TEXT, settings JSONB, created_at TIMESTAMP(3) NOT NULL, updated_at TIMESTAMP(3) NOT NULL, UNIQUE(workspace_id, id));
        CREATE TABLE history (channel_id UUID REFERENCES channels(id), content TEXT);`);
      await client.query('INSERT INTO channels VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8), ($9,$2,$10,$11,$5,$6,$7,$8,$8)', [evolutionId, 'tenant', 'evolution', 'existing-session', 'connected', '+55 47 99999-0000', { setting: 'preserved' }, '2026-09-01T00:00:00.000Z', metaId, 'meta_cloud', 'meta-existing']);
      await client.query('INSERT INTO history VALUES ($1,$2)', [evolutionId, 'existing conversation']);
      const columns = 'id,workspace_id,provider,provider_key,status,phone_number,settings,created_at,updated_at';
      const before = (await client.query(`SELECT ${columns} FROM channels ORDER BY id`)).rows;
      const migration = await readFile(new URL('../../../prisma/migrations/20260930005000_channel_connections/migration.sql', import.meta.url), 'utf8');
      await client.query(migration);
      expect((await client.query(`SELECT ${columns} FROM channels ORDER BY id`)).rows).toEqual(before);
      const physical = (await client.query('SELECT * FROM channel_connections')).rows;
      expect(physical).toHaveLength(1);
      expect(physical[0]).toMatchObject({ workspace_id: 'tenant', channel_id: evolutionId, provider: 'evolution', session_name: 'existing-session', status: 'connected', eligible: true, health: 'unknown', verified_phone_number: null });
      expect((await client.query('SELECT id,active_connection_id,redundancy_enabled FROM channels ORDER BY provider')).rows).toEqual([
        { id: evolutionId, active_connection_id: physical[0].id, redundancy_enabled: false },
        { id: metaId, active_connection_id: null, redundancy_enabled: false }
      ]);
      expect((await client.query('SELECT * FROM history')).rows).toEqual([{ channel_id: evolutionId, content: 'existing conversation' }]);
    } finally {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
