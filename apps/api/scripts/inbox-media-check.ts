import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInboxMediaService } from '../src/modules/conversations/inbox-media.js';
import type { PrismaClient } from '@prisma/client';
const folder = await mkdtemp(join(tmpdir(), 'talk-media-check-'));
execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=12','-c:a','libopus',join(folder,'voice.ogg')]);
execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=0x9dbeb0:s=600x420','-frames:v','1',join(folder,'picture.png')]);
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { jsPDF } = require('jspdf');
const pdf = new jsPDF(); pdf.text('DOCUMENTO DE TESTE - SEM DADOS REAIS', 20, 30); pdf.text('10 chapas - somente demonstracao de visualizacao', 20, 45); pdf.addPage(); pdf.text('Segunda pagina - teste de navegacao',20,30);
const bytes = { audio: await readFile(join(folder,'voice.ogg')), image: await readFile(join(folder,'picture.png')), file: Buffer.from(pdf.output('arraybuffer')) };
const mime = { audio: 'audio/ogg', image: 'image/png', file: 'application/pdf' };
const prisma = {
  conversation: { findFirst: async () => ({ contact: { phone: '5500000000000' }, channel: { provider: 'evolution', providerKey: 'fixture' } }) },
  message: { findFirst: async ({ where }: { where: { id: keyof typeof bytes } }) => bytes[where.id] ? ({ type: where.id, mediaUrl: `data:${mime[where.id]};base64,${bytes[where.id].toString('base64')}`, providerMessageId: null }) : null }
};
const service = createInboxMediaService({ prisma: prisma as unknown as PrismaClient });
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:57217');
  res.setHeader('Access-Control-Allow-Headers', 'authorization');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.headers.authorization !== 'Bearer fixture') { res.statusCode = 401; res.end(); return; }
  try {
    if (req.url?.endsWith('/contact-photo')) { res.setHeader('Content-Type','image/png'); res.end(bytes.image); return; }
    const id = req.url?.match(/\/messages\/([^/]+)\/(?:media|preview)/)?.[1];
    if (req.url?.includes('/preview')) {
      const result = await service.preview('fixture', 'conversation', id!, Number(new URL(req.url, 'http://localhost').searchParams.get('page')) || 1);
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({imageUrl:`data:image/png;base64,${result.bytes.toString('base64')}`,pages:result.pageCount})); return;
    }
    const result = await service.media('fixture', 'conversation', id ?? 'missing');
    res.setHeader('Content-Type', result.mimeType); res.end(result.bytes);
  } catch { res.statusCode = 422; res.end('Fixture unavailable'); }
}).listen(57218, '127.0.0.1', () => console.log('Synthetic media API ready on 57218; real OGG-to-MP3 conversion, no WhatsApp.'));
process.on('SIGINT', async () => { await rm(folder,{recursive:true,force:true}); process.exit(); });
