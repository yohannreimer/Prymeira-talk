import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import type { HistoryRecord } from '../modules/evolution/evolution-history.js';
import { evolutionExactPage } from './evolution-exact-page.js';

/** Faithful loopback provider contract: an ID-only query returns a fixed owned
 * native tuple, which the caller must validate before requesting its bytes with
 * that original tuple. Never echo arbitrary requested keys. */
export function createExactEvolutionMediaFixture(input: { sessionName: string; key: HistoryRecord['key']; bytes: Buffer }) {
  const requests: string[] = [], keys: unknown[] = [];
  const queries: Array<{ where: unknown; page: unknown; offset: unknown }> = [];
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
        queries.push({ where: body.where, page: body.page, offset: body.offset });
        if (!isDeepStrictEqual(body?.where?.key, { id: input.key.id })) { res.statusCode = 400; res.end('{}'); return; }
        res.end(JSON.stringify(evolutionExactPage([message], body))); return;
      }
      if (req.url === `/chat/getBase64FromMediaMessage/${instance}`) {
        keys.push(body?.message?.key);
        if (!isDeepStrictEqual(body?.message?.key, input.key)) { res.statusCode = 400; res.end('{}'); return; }
        res.end(JSON.stringify({ base64: input.bytes.toString('base64'), mimetype: 'image/png' })); return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return { server, requests, keys, queries };
}
