import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildExtension } from '../scripts/build.mjs';

// All contacts, messages and credentials in this test are synthetic. All HTTP is intercepted.
const waOrigin = 'https://web.whatsapp.com';
const output = resolve(process.env.BROWSER_OUTPUT_DIR ?? '../../.validation/extension-browser');
const fixtureDir = resolve('../../.validation/extension-fixture');
await mkdir(output, { recursive: true }); await mkdir(fixtureDir, { recursive: true });
const bridgeHtml = () => `<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script>window.__PRYMEIRA_TALK_CONFIG__={VITE_API_URL:'${origin}/api'};</script><script type="module" src="/fixture.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === '/extension') { response.setHeader('Content-Type', 'text/html'); response.end(bridgeHtml()); }
  else if (request.url === '/fixture.js' || request.url === '/fixture.css') { response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(await readFile(`${fixtureDir}/bridge${request.url.endsWith('.js') ? '.js' : '.css'}`)); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const channelId = '00000000-0000-4000-8000-000000000001';
const ids = { A: '00000000-0000-4000-8000-000000000002', B: '00000000-0000-4000-8000-000000000003' };
const peers = { A: '5547987654321@s.whatsapp.net', B: '5511987654321@s.whatsapp.net' };
const bodies = { A: 'Olá, Ana! Posso ajudar com o orçamento de teste?', B: 'Olá, João! Podemos revisar sua proposta de teste?' };
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ExtensionBridgePage} from '../web/src/features/browser-extension/ExtensionBridgePage'; createRoot(document.getElementById('root')).render(React.createElement(ExtensionBridgePage));`, resolveDir: resolve('.'), loader: 'tsx' },
  outfile: `${fixtureDir}/bridge.js`, bundle: true, format: 'esm', jsx: 'automatic', plugins: [{ name: 'synthetic-auth', setup(builder) {
    builder.onResolve({ filter: /\/app\/auth$/ }, () => ({ path: 'synthetic-auth', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import {useSyncExternalStore} from 'react'; const subscribe=f=>{window.addEventListener('fixture-auth',f);return()=>window.removeEventListener('fixture-auth',f)};const snapshot=()=>window.fixtureUser||'test-user';const getToken=async()=> 'fixture-token';export function useTalkAuth(){const user=useSyncExternalStore(subscribe,snapshot);return {userId:user,sessionId:user+'-session',orgId:'',getToken}}`, loader: 'js', resolveDir: resolve('../web') }));
  } }], define: { 'process.env.NODE_ENV': '"production"' } });

const profile = resolve('../../.validation/extension-browser-profile');
const extensionDist = `${fixtureDir}/extension`;
await buildExtension({ origin, outdir: extensionDist });
await rm(profile, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 380, height: 900 },
  args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`] });
const failures = [], checks = [], mutations = [], networkFailures = []; let holdRead = false, pendingRelease = null, accessDenied = false, followupActive = true, staleSuggestion = false;
context.on('page', page => page.on('pageerror', error => failures.push(error.message)));
context.on('requestfailed', request => networkFailures.push({ url: request.url(), failure: request.failure() }));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  if (url.origin === origin && url.pathname === '/extension') return route.fulfill({ contentType: 'text/html', body: bridgeHtml() });
  if (url.origin === origin && url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: await readFile(`${fixtureDir}/bridge.js`) });
  if (url.origin === origin && url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: await readFile(`${fixtureDir}/bridge.css`) });
  if (url.origin === origin && url.pathname.startsWith('/api/')) {
    assert.equal(route.request().headers().authorization, 'Bearer fixture-token');
    if (accessDenied) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Acesso removido no teste.' }) });
    const path = url.pathname.slice(4), body = route.request().postDataJSON();
    if (path === '/browser-extension/channels') return json({ workspaceId: 'test-workspace', role: 'owner', channels: [{ id: channelId, phoneNumber: '5547991234567', displayName: 'Canal de teste', status: 'connected' }] });
    if (path === '/browser-extension/resolve') {
      const which = body.peerAddress === peers.A ? 'A' : 'B';
      return json({ id: ids[which], channelId, contactName: which === 'A' ? 'Ana · teste' : 'João · teste', phone: body.peerAddress.split('@')[0] });
    }
    const which = path.includes(ids.A) ? 'A' : 'B';
    if (path.endsWith('/followup')) return json({ followup: followupActive ? { id: '00000000-0000-4000-8000-000000000004', workspaceId: 'test-workspace', conversationId: ids[which], agentId: channelId,
      kind: 'human_commercial', status: 'review', stepIndex: 1, scheduledAt: '2026-10-27T13:00:00.000Z', draftBody: 'Retorno preparado no ambiente de teste.', contact: { name: 'Contato de teste', phone: null }, channel: { displayName: 'Canal de teste' },
      anchorMessage: { id: null, body: null, type: null, createdAt: null }, purpose: null, reasonCode: null,
      analysis: { situation: 'waiting_customer', pendingItem: 'Cliente está avaliando o orçamento de teste.', nextStep: 'Retomar a conversa após a avaliação.', timingNote: null, rationale: 'Dados sintéticos.', confidence: 1 }, createdAt: '2026-10-26T10:00:00.000Z', updatedAt: '2026-10-26T10:00:00.000Z' } : null });
    if (path.startsWith('/followups/')) { mutations.push({ path, body }); followupActive = false; return json({}); }
    if (path.endsWith('/suggestions')) { mutations.push({ path, body }); return json({ status: 'pending' }); }
    if (path.startsWith('/assistant/conversations/')) {
      if (holdRead && which === 'A') { holdRead = false; await new Promise(resolve => { pendingRelease = resolve; }); }
      return json({ settings: { mode: 'on_demand', agentId: channelId }, status: 'ready', humanControlled: false, humanSupport: true, awaitingCustomer: false,
        currentContextKey: staleSuggestion ? 'new-context' : `context-${which}`, agentName: 'IA de teste', error: null, history: [], suggestion: { id: ids[which], conversationId: ids[which], agentId: channelId,
          revision: 1, contextKey: `context-${which}`, body: bodies[which], instruction: null, createdAt: '2026-10-26T10:00:00.000Z', warnings: [], actorName: null, finalBody: null, messageId: null, sendStatus: null } });
    }
    throw new Error(`Unexpected fixture API path ${path}`);
  }
  if (url.origin === waOrigin) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="side"><div id="pane-side"><div role="row" aria-selected="true">Ana</div><div role="row">João</div></div></div><div id="main"></div><script>
    localStorage.setItem('last-wid-md',JSON.stringify('5547991234567:3@c.us'));
    window.selectPeer=(peer,name)=>{document.getElementById('main').innerHTML='<header><span title="'+name+'">'+name+'</span></header><div data-id="false_'+peer+'_stanza">Mensagem sintética</div><footer><div contenteditable="true" role="textbox" aria-label="Mensagem"></div></footer>'};
    selectPeer('${peers.A}','Ana');
    </script></body></html>` });
  if (url.protocol === 'chrome-extension:') return route.continue();
  return route.abort();
});
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;
const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
const waitFor = async (assertion, timeout = 15_000) => { const start = Date.now(); while (true) { if (await assertion()) return; if (Date.now() - start > timeout) throw new Error('Condition timed out'); await new Promise(r => setTimeout(r, 100)); } };
try {
  await panel.getByRole('button', { name: 'Conectar minha conta' }).waitFor();
  await panel.screenshot({ path: `${output}/extensao-inicio.png` }); checks.push('Painel inicial renderizado sem dados fictícios no produto.');
  const newBridge = context.waitForEvent('page'); await panel.getByRole('button', { name: 'Conectar minha conta' }).click();
  const talk = await newBridge; await talk.waitForURL(`${origin}/extension`);
  await talk.getByRole('button', { name: 'Conectar minha conta' }).click();
  await talk.getByRole('heading', { name: 'Talk conectado ao seu navegador.' }).waitFor();
  checks.push('Login reaproveitado pela página real de conexão, com autorização explícita.');
  const wa = await context.newPage(); await wa.goto(waOrigin); await wa.bringToFront();
  await panel.getByRole('heading', { name: 'Ana · teste' }).waitFor({ timeout: 20_000 });
  await panel.locator('#reply').waitFor(); assert.equal(await panel.locator('#reply').inputValue(), bodies.A);
  await panel.screenshot({ path: `${output}/extensao-conversa-teste.png` }); checks.push('Conversa identificada; sugestão e follow-up carregados pelos dois content scripts e pelo service worker.');
  await panel.locator('#reply').fill('Texto editado no painel de teste.');
  await panel.getByRole('button', { name: 'Atualizar contexto' }).click();
  await waitFor(async () => await panel.locator('#reply').inputValue() === 'Texto editado no painel de teste.');
  checks.push('Atualização preserva a edição do vendedor.');
  await panel.getByRole('button', { name: 'Inserir no WhatsApp' }).click();
  await waitFor(async () => (await wa.locator('[contenteditable]').innerText()) === 'Texto editado no painel de teste.');
  checks.push('Sugestão inserida no campo nativo, sem envio automático.');
  await panel.getByRole('button', { name: 'Inserir no WhatsApp' }).click();
  await panel.getByRole('alert').filter({ hasText: 'campo de mensagem vazio' }).waitFor();
  checks.push('Rascunho existente protegido contra sobrescrita.');
  await wa.locator('[contenteditable]').fill(''); staleSuggestion = true;
  await panel.getByRole('button', { name: 'Inserir no WhatsApp' }).click();
  await panel.getByRole('alert').filter({ hasText: 'sugestão mudou' }).waitFor();
  assert.equal((await wa.locator('[contenteditable]').innerText()).trim(), ''); staleSuggestion = false;
  checks.push('Contexto revalidado no Talk antes de inserir; sugestão desatualizada bloqueada.');
  await panel.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await waitFor(async () => mutations.some(m => m.path.includes('/cancel')));
  assert.deepEqual(mutations.find(m => m.path.includes('/cancel')).body, { expectedUpdatedAt: '2026-10-26T10:00:00.000Z', reason: 'manual_cancelled' });
  checks.push('Cancelamento de follow-up usa revisão esperada e endpoint existente.');
  holdRead = true; await panel.getByRole('button', { name: 'Atualizar contexto' }).click(); await waitFor(async () => !!pendingRelease);
  await wa.evaluate(({peer}) => window.selectPeer(peer, 'João'), { peer: peers.B });
  await panel.getByRole('heading', { name: 'João · teste' }).waitFor({ timeout: 20_000 });
  pendingRelease(); pendingRelease = null;
  await waitFor(async () => (await panel.locator('#reply').inputValue()) === bodies.B);
  assert.equal(await panel.getByRole('heading', { name: 'Ana · teste' }).count(), 0);
  checks.push('Resposta atrasada da conversa A não aparece na conversa B.');
  const other = await context.newPage(); await other.goto('about:blank'); await other.bringToFront();
  await panel.getByRole('heading', { name: 'Vamos abrir uma conversa?' }).waitFor();
  assert.equal(await panel.locator('#reply').count(), 0); await wa.bringToFront();
  await panel.getByRole('heading', { name: 'João · teste' }).waitFor();
  checks.push('Troca de aba limpa o contexto e voltar ao WhatsApp restaura a conversa correta.');
  const otherWindow = await worker.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: true }));
  const ownWindowStatus = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'STATUS', windowId: (await chrome.windows.getCurrent()).id }));
  assert.equal(ownWindowStatus.data.selection.peerAddress, peers.B);
  await worker.evaluate(id => chrome.windows.remove(id), otherWindow.id); await wa.bringToFront();
  checks.push('Outra janela focada não troca a conversa do painel desta janela.');
  await talk.evaluate(() => { window.fixtureUser = 'other-user'; window.dispatchEvent(new Event('fixture-auth')); });
  await talk.getByRole('button', { name: 'Conectar minha conta' }).waitFor();
  await panel.getByRole('button', { name: 'Conectar minha conta' }).waitFor({ timeout: 15_000 });
  assert.equal(await panel.locator('#reply').count(), 0); checks.push('Troca de conta revoga a conexão e limpa a conversa.');
  await talk.getByRole('button', { name: 'Conectar minha conta' }).click(); await wa.bringToFront();
  await panel.getByRole('heading', { name: 'João · teste' }).waitFor({ timeout: 20_000 });
  accessDenied = true; await panel.getByRole('button', { name: 'Atualizar contexto' }).click();
  await panel.getByRole('button', { name: 'Conectar minha conta' }).waitFor({ timeout: 15_000 });
  assert.equal(await panel.locator('#reply').count(), 0); checks.push('Revogação do acesso na API limpa os dados do painel.');
  assert.deepEqual(failures, []);
  await writeFile(`${output}/browser-test-results.json`, JSON.stringify({ passed: checks.length, checks, pageErrors: failures, environment: 'Chromium headless, extension real, authentication and HTTP fixtures, synthetic data only' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: failures }, null, 2));
} catch (error) {
  console.error('Original browser failure:', error);
  await panel.screenshot({ path: `${output}/extensao-falha.png` }).catch(failure => console.error('Failure screenshot unavailable:', failure.message));
  console.error('Panel text:', await panel.locator('body').innerText()); console.error('Page errors:', failures);
  for (const open of context.pages()) if (open.url().startsWith(origin)) {
    console.error('Talk fixture:', open.url(), await open.locator('body').innerText());
    console.error('Talk fixture HTML:', await open.content());
  }
  console.error('Network failures:', networkFailures); throw error;
} finally { if (pendingRelease) pendingRelease(); await context.close(); await new Promise(resolve => server.close(resolve)); }
