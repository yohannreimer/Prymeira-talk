import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import type { HistoryRecord } from '../modules/evolution/evolution-history.js';

/** Faithful loopback provider contract: a fixed owned message tuple must be found
 * before its original bytes can be requested. Echoing arbitrary requested keys
 * here would hide identity regressions in the compiled worker. */
export function createExactEvolutionMediaFixture(input: { sessionName: string; key: HistoryRecord['key']; bytes: Buffer }) {
  const requests: string[] = [], keys: unknown[] = [];
  const message: HistoryRecord = { key: input.key, messageTimestamp: 1700000000,
    message: { imageMessage: { url: 'https://media.invalid/expired', mimetype: 'image/png' } } };
  const instance = encodeURIComponent(input.sessionName);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json');
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.statusCode = 400; res.end('{}'); return; }
      if (req.method !== 'POST' || req.headers.apikey !== 'test-only') { res.statusCode = 403; res.end('{}'); return; }
      if (req.url === `/chat/findMessages/${instance}`) {
        keys.push(body?.where?.key);
        if (!isDeepStrictEqual(body?.where?.key, input.key)) { res.statusCode = 400; res.end('{}'); return; }
        res.end(JSON.stringify({ messages: { records: [message], pages: 1, total: 1 } })); return;
      }
      if (req.url === `/chat/getBase64FromMediaMessage/${instance}`) {
        keys.push(body?.message?.key);
        if (!isDeepStrictEqual(body?.message?.key, input.key)) { res.statusCode = 400; res.end('{}'); return; }
        res.end(JSON.stringify({ base64: input.bytes.toString('base64'), mimetype: 'image/png' })); return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return { server, requests, keys };
}
