import { build } from 'esbuild';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function buildExtension({ origin = process.env.TALK_EXTENSION_ORIGIN ?? 'https://talk.prymeiradigital.com.br', outdir = 'dist' } = {}) {
const talkOrigin = new URL(origin).origin;
if (!talkOrigin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(talkOrigin)) throw new Error('Use HTTPS ou localhost para o Talk.');
await rm(outdir, { recursive: true, force: true }); await mkdir(outdir, { recursive: true });
const common = { bundle: true, target: 'chrome116', define: { __TALK_ORIGIN__: JSON.stringify(talkOrigin), 'process.env.NODE_ENV': '"production"' }, minify: true, legalComments: 'eof' };
await build({ ...common, entryPoints: { 'panel': 'src/panel.tsx', 'background': 'src/background.ts' }, outdir, format: 'esm' });
await build({ ...common, entryPoints: { 'whatsapp-content': 'src/whatsapp/content.ts', 'talk-content': 'src/talk-content.ts' }, outdir, format: 'iife' });
await cp('panel.html', `${outdir}/panel.html`);
await writeFile(`${outdir}/manifest.json`, JSON.stringify({ manifest_version: 3, name: 'Prymeira Talk para WhatsApp', version: '0.2.3',
  description: 'Sugestões de resposta e follow-ups do seu Talk ao lado da conversa no WhatsApp Web.', minimum_chrome_version: '116',
  permissions: ['sidePanel', 'storage'], host_permissions: ['https://web.whatsapp.com/*', `${talkOrigin}/*`],
  action: { default_title: 'Abrir Prymeira Talk' }, side_panel: { default_path: 'panel.html' },
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [{ matches: ['https://web.whatsapp.com/*'], js: ['whatsapp-content.js'], run_at: 'document_idle' },
    { matches: [`${talkOrigin}/extension*`], js: ['talk-content.js'], run_at: 'document_idle' }],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'" },
}, null, 2) + '\n');
console.log(`Extensão criada em ${outdir} (Talk: ${talkOrigin}).`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildExtension();
