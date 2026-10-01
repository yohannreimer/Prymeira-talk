import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

export function guardedMessagingDatabase(value: string) {
  const target = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost'].includes(target.hostname)
    || target.pathname !== '/messaging_test') throw new Error('Only local messaging_test is permitted');
  return value;
}

const url = process.env.MESSAGING_TEST_DATABASE_URL;
describe('messaging test database guard', () => {
  it.each(['postgresql://localhost/production', 'postgresql://remote/messaging_test', 'https://localhost/messaging_test', 'postgresql://localhost/other_test'])('rejects %s', value => {
    expect(() => guardedMessagingDatabase(value)).toThrow();
  });
});
describe.skipIf(!url)('canonical messaging schema on PostgreSQL', () => {
  it('adds the canonical store without removing legacy message unique indexes', async () => {
    const db = new Client({ connectionString: guardedMessagingDatabase(url!) });
    await db.connect();
    try {
      const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename);
      expect(tables).toEqual(expect.arrayContaining(['canonical_addresses', 'canonical_address_aliases', 'canonical_address_evidence', 'canonical_chats', 'canonical_chat_members', 'canonical_message_identities', 'canonical_native_aliases', 'canonical_observations', 'canonical_actions', 'canonical_recipient_receipts']));
      const indexes = (await db.query("SELECT indexdef FROM pg_indexes WHERE tablename='messages'")).rows.map(r => r.indexdef).join('\n');
      expect(indexes).toContain('UNIQUE INDEX messages_workspace_id_provider_message_id_key');
      expect(indexes).toContain('UNIQUE INDEX messages_workspace_id_provider_event_id_key');
    } finally { await db.end(); }
  });
});

describe.skipIf(!url)('canonical additive legacy backfill', () => {
  it('preserves legacy UUIDs, controls, metadata and IDs while recording proven chat members', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const db = new Client({ connectionString: guardedMessagingDatabase(url!) });
    const schema = `canonical_fixture_${randomUUID().replaceAll('-', '')}`;
    const channel = randomUUID(), contact = randomUUID(), conversation = randomUUID(), message = randomUUID();
    const migrations = new URL('../../../prisma/migrations/', import.meta.url);
    await db.connect();
    try {
      await db.query(`CREATE SCHEMA "${schema}"`);
      await db.query(`SET search_path TO "${schema}"`);
      for (const entry of (await readdir(migrations)).sort().filter(n => n.startsWith('20') && n < '20260930012000')) {
        await db.query(await readFile(new URL(`${entry}/migration.sql`, migrations), 'utf8'));
      }
      await db.query(`INSERT INTO channels(id,workspace_id,provider,provider_key,encrypted_config,updated_at) VALUES ($1,'fixture','evolution','fixture','{"keep":true}',now());
      `, [channel]);
      await db.query(`INSERT INTO contacts(id,workspace_id,phone,custom_fields,updated_at) VALUES ($1,'fixture','15550001111','{"evolutionLid":"700001@lid","keep":true}',now())`, [contact]);
      await db.query(`INSERT INTO conversations(id,workspace_id,channel_id,contact_id,unread_count,ai_control_status,updated_at) VALUES ($1,'fixture',$2,$3,7,'human_controlled',now())`, [conversation, channel, contact]);
      await db.query(`INSERT INTO messages(id,workspace_id,conversation_id,direction,type,body,provider_message_id,metadata,updated_at) VALUES ($1,'fixture',$2,'inbound','text','legacy','LEGACY','{"keep":true}',now())`, [message, conversation]);
      const groupContact=randomUUID(), groupConversation=randomUUID(), groupMessage=randomUUID();
      await db.query(`INSERT INTO contacts(id,workspace_id,phone,is_group,updated_at) VALUES ($1,'fixture','120000-100@g.us',true,now())`,[groupContact]);
      await db.query(`INSERT INTO conversations(id,workspace_id,channel_id,contact_id,updated_at) VALUES ($1,'fixture',$2,$3,now())`,[groupConversation,channel,groupContact]);
      await db.query(`INSERT INTO messages(id,workspace_id,conversation_id,direction,type,provider_message_id,updated_at) VALUES ($1,'fixture',$2,'inbound','text','GROUP_LEGACY',now())`,[groupMessage,groupConversation]);
      const before = []; for (const t of ['channels','contacts','conversations','messages']) before.push(await db.query(`SELECT * FROM ${t} ORDER BY id`));
      await db.query(await readFile(new URL('20260930012000_canonical_messaging/migration.sql', migrations), 'utf8'));
      await db.query(await readFile(new URL('20260930013000_canonical_address_review/migration.sql', migrations), 'utf8'));
      for (const entry of (await readdir(migrations)).sort().filter(n => n.startsWith('20260930') && n >= '20260930014000')) {
        await db.query(await readFile(new URL(`${entry}/migration.sql`, migrations), 'utf8'));
      }
      const after = []; for (const t of ['channels','contacts','conversations','messages']) after.push(await db.query(`SELECT * FROM ${t} ORDER BY id`));
      expect(after.map(r => r.rows)).toEqual(before.map(r => r.rows));
      expect((await db.query('SELECT operation_conversation_id,state FROM canonical_chats')).rows).toEqual(expect.arrayContaining([{ operation_conversation_id: conversation, state: 'active' }, { operation_conversation_id: groupConversation, state: 'active' }]));
      expect((await db.query('SELECT conversation_id FROM canonical_chat_members')).rows).toEqual(expect.arrayContaining([{ conversation_id: conversation }, { conversation_id: groupConversation }]));
      expect((await db.query('SELECT address FROM canonical_address_aliases')).rows).toEqual(expect.arrayContaining([{ address: '15550001111@s.whatsapp.net' }, { address: '120000-100@g.us' }]));
      // Editable evolutionLid is deliberately not proof. Existing native IDs remain legacy.
      expect((await db.query('SELECT count(*)::int AS n FROM canonical_address_evidence')).rows[0].n).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM canonical_native_aliases')).rows[0].n).toBe(2);
      expect((await db.query("SELECT full_tuple FROM canonical_native_aliases WHERE full_tuple->>'messageId'=$1",[groupMessage])).rows[0].full_tuple).toMatchObject({messageId:groupMessage,groupSender:null});
      expect((await db.query('SELECT state FROM canonical_native_aliases')).rows[0].state).toBe('unresolved');
      expect((await db.query("SELECT count(*)::int n FROM pg_constraint WHERE connamespace=$1::regnamespace AND contype='f' AND conrelid::regclass::text LIKE '%canonical%';", [schema])).rows[0].n).toBeGreaterThan(15);
    } finally {
      await db.query('SET search_path TO public');
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
    }
  });
});
