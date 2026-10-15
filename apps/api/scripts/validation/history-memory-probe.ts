import assert from 'node:assert/strict';
import { recoverConnectionGap } from '../../src/modules/channels/provider-history.js';

async function main() {
  const now = 1_800_000_000_000, pages = 500, chatId = '15550000000@c.us';
  let messageReads = 0, advances = 0;
  const db = { channel: { findUniqueOrThrow: async () => ({ id: 'ch', workspaceId: 'ws', providerKey: 'evo' }) },
    channelConnection: { updateMany: async () => { advances++; return { count: 1 }; } } };
  const waha = { getChats: async ({ offset = 0 }) => offset ? [] : [{ id: chatId, timestamp: now / 1000 }],
    getMessages: async ({ offset = 0 }) => {
      messageReads++;
      // Generate fresh payloads on demand: never keep a fixture-sized array in the harness.
      return offset < pages ? [{ id: `false_${chatId}_M${offset}`, from: chatId, fromMe: false,
        timestamp: (now - 30 * 86_400_000) / 1000, body: Buffer.alloc(512 * 1024, 65 + offset % 26).toString('utf8') }] : [];
    } };
  const result = await recoverConnectionGap(db as never, { waha: waha as never }, { id: 'c', workspaceId: 'ws', channelId: 'ch', provider: 'waha',
    sessionName: 's', lifecycleGeneration: 0, recoveredThroughAt: new Date(now - 600_000) } as never, { now });
  assert.deepEqual(result, { recovered: 0, chats: 1, advanced: true });
  assert.equal(advances, 1);
  assert.equal(messageReads, 4 * (pages + 1)); // Two exhausted scans, repeated before the checkpoint.
  console.log(JSON.stringify({ pages, messageReads, advances, recovered: result.recovered }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
