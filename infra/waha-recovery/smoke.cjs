'use strict';
// Exercises the pinned provider's actual compiled method/protobuf conversion with a
// synthetic backend. Never starts a WhatsApp session or accesses session storage.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WhatsappSessionGoWSCore } = require('/app/dist/core/engines/gows/session.gows.core');
const session = Object.create(WhatsappSessionGoWSCore.prototype);
session.session = { id: 'synthetic' };
session.media = { api: {} };
session.processIncomingMessage = async row => row.visible ? { id: row.id, timestamp: 1 } : null;
session.client = { GetMessages: (request, callback) => {
  assert.equal(request.filters.timestampGte.value, 1);
  assert.equal(request.filters.timestampLte.value, 2);
  const rows = request.pagination.offset === 0 ? [{ id: 'control', visible: false }, { id: 'message', visible: true }] : [];
  setTimeout(() => callback(null, { toObject: () => ({ elements: rows.map(row => ({ data: JSON.stringify(row) })) }) }), 5);
} };
(async () => {
  const server = http.createServer(async (request, response) => {
    try {
      const offset = Number(new URL(request.url, 'http://fixture').searchParams.get('offset') ?? 0);
      const result = await session.getChatMessages('all', { offset, limit: 50, sortOrder: 'asc', downloadMedia: false }, { 'filter.timestamp.gte': 1, 'filter.timestamp.lte': 2 });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const [ordinary, page, end] = await Promise.all([fetch(base), fetch(base, { headers: { 'x-talk-recovery-pagination': '1' } }), fetch(`${base}?offset=2`, { headers: { 'x-talk-recovery-pagination': '1' } })]);
    for (const response of [ordinary, page, end]) assert.equal(response.status, 200, await response.clone().text());
    assert.equal(ordinary.headers.get('x-talk-recovery-pagination'), null);
    assert.equal(page.headers.get('x-talk-recovery-raw-count'), '2');
    assert.equal(page.headers.get('x-talk-recovery-next-offset'), '2');
    assert.equal(page.headers.get('x-talk-recovery-exhausted'), 'false');
    assert.deepEqual(await page.json(), [{ id: 'message', timestamp: 1 }]);
    assert.equal(end.headers.get('x-talk-recovery-exhausted'), 'true');
    console.log('Pinned GOWS metadata contract passed: ordinary, filtered and exhausted requests; no WhatsApp sessions.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
