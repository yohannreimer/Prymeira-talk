import { build } from 'esbuild';
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function buildExtension({ origin = process.env.TALK_EXTENSION_ORIGIN ?? 'https://talk.prymeiradigital.com.br', outdir = 'dist', clerkPublishableKey, clerkOrigin, plugins = [] } = {}) {
const talkOrigin = new URL(origin).origin;
const production=JSON.parse(await readFile(new URL('../production-auth.json',import.meta.url),'utf8'));
clerkPublishableKey??=process.env.TALK_EXTENSION_CLERK_PUBLISHABLE_KEY??(talkOrigin===production.talkOrigin?production.clerkPublishableKey:'');
clerkOrigin??=process.env.TALK_EXTENSION_CLERK_ORIGIN??(talkOrigin===production.talkOrigin?production.clerkOrigin:'');
const nativeAuth=Boolean(clerkPublishableKey&&clerkOrigin);
if(Boolean(clerkPublishableKey)!==Boolean(clerkOrigin))throw new Error('Configure a chave pública e a origem Clerk juntas.');
if(nativeAuth&&(!clerkPublishableKey.startsWith('pk_live_')||new URL(clerkOrigin).protocol!=='https:'))throw new Error('Use a chave pública e a origem HTTPS de produção do Clerk.');
if(nativeAuth){const host=Buffer.from(clerkPublishableKey.slice('pk_live_'.length),'base64').toString().replace(/\$$/,'');if(new URL(clerkOrigin).hostname!==host)throw new Error('A origem Clerk não corresponde à chave pública.');}
if (!talkOrigin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(talkOrigin)) throw new Error('Use HTTPS ou localhost para o Talk.');
await rm(outdir, { recursive: true, force: true }); await mkdir(outdir, { recursive: true });
const common = { bundle: true, plugins, target: 'chrome116', define: { __TALK_ORIGIN__: JSON.stringify(talkOrigin), __CLERK_PUBLISHABLE_KEY__:JSON.stringify(clerkPublishableKey), __CLERK_ORIGIN__:JSON.stringify(clerkOrigin), 'process.env.NODE_ENV': '"production"' }, minify: true, legalComments: 'eof' };
await build({ ...common, entryPoints: { 'panel': 'src/panel.tsx', 'background': 'src/background.ts' }, outdir, format: 'esm' });
await build({ ...common, entryPoints: { 'whatsapp-content': 'src/whatsapp/content.ts', 'talk-content': 'src/talk-content.ts' }, outdir, format: 'iife' });
await cp('panel.html', `${outdir}/panel.html`);
await cp('assets', `${outdir}/assets`, {recursive:true});
await writeFile(`${outdir}/manifest.json`, JSON.stringify({ manifest_version: 3, name: 'Prymeira Talk para WhatsApp', version: '0.3.1',
  description: 'Sugestões de resposta e follow-ups do seu Talk ao lado da conversa no WhatsApp Web.', minimum_chrome_version: '116',
  permissions: ['sidePanel', 'storage', ...(nativeAuth?['cookies']:[])], host_permissions: ['https://web.whatsapp.com/*', `${talkOrigin}/*`, ...(nativeAuth?[`${new URL(clerkOrigin).origin}/*`]:[])],
  icons: {16:'assets/icon-16.png',32:'assets/icon-32.png',48:'assets/icon-48.png',128:'assets/icon-128.png'},
  action: { default_title: 'Abrir Prymeira Talk', default_icon: {16:'assets/icon-16.png',32:'assets/icon-32.png',48:'assets/icon-48.png'} }, side_panel: { default_path: 'panel.html' },
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [{ matches: ['https://web.whatsapp.com/*'], js: ['whatsapp-content.js'], run_at: 'document_idle' },
    { matches: [`${talkOrigin}/extension*`], js: ['talk-content.js'], run_at: 'document_idle' }],
  content_security_policy: { extension_pages: `script-src 'self'; object-src 'none'; connect-src ${nativeAuth?`${talkOrigin} ${new URL(clerkOrigin).origin}`:"'none'"}; base-uri 'none'` },
}, null, 2) + '\n');
console.log(`Extensão criada em ${outdir} (Talk: ${talkOrigin}).`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildExtension();
