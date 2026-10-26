import { extensionCommandSchema, type ExtensionCommand, type ExtensionReply, type ExtensionSession } from '@prymeira-talk/shared';
import { BRIDGE_URL, TALK_ORIGIN, WHATSAPP_ORIGIN } from './config';
import { selectionSchema, type PanelRequest, type PanelState, type SelectedContext } from './protocol';
import { withSelectionFence } from './selection-fence';

const notify = () => { void chrome.runtime.sendMessage({ type: 'PANEL_CHANGED' }).catch(() => {}); };
function talkBridge(tab: chrome.tabs.Tab) {
  if (!tab.url) return false;
  const url = new URL(tab.url); return url.origin === TALK_ORIGIN && url.pathname === '/extension';
}
function whatsapp(tab: chrome.tabs.Tab) { try { return !!tab.url && new URL(tab.url).origin === WHATSAPP_ORIGIN; } catch { return false; } }
async function readSelection() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !whatsapp(tab)) return { tabId: null, selection: null };
  try { return { tabId: tab.id, selection: selectionSchema.parse(await chrome.tabs.sendMessage(tab.id, { type: 'WA_READ' })) }; }
  catch { return { tabId: tab.id, selection: null }; }
}
async function bridge(command: ExtensionCommand) {
  const { bridgeTabId, bridgeConnected } = await chrome.storage.session.get(['bridgeTabId', 'bridgeConnected']);
  if (typeof bridgeTabId !== 'number' || !bridgeConnected) throw new Error('Conecte sua conta pela aba do Talk.');
  let tab: chrome.tabs.Tab;
  try { tab = await chrome.tabs.get(bridgeTabId); } catch { throw new Error('A aba de conexão foi fechada. Conecte o Talk novamente.'); }
  if (!talkBridge(tab)) throw new Error('A aba de conexão mudou. Conecte o Talk novamente.');
  const response = await chrome.tabs.sendMessage(bridgeTabId, { type: 'BRIDGE_EXECUTE', command }) as ExtensionReply;
  if (!response?.ok) throw new Error(response?.error ?? 'Não foi possível consultar o Talk.');
  return response.data;
}
async function status(): Promise<PanelState> {
  const live = await readSelection();
  const { bridgeConnected } = await chrome.storage.session.get('bridgeConnected');
  if (!bridgeConnected) return { ...live, connected: false, session: null };
  try { const session = await bridge({ action: 'session' });
    if (!('channels' in session)) throw new Error('Sessão inválida.');
    return { ...await readSelection(), connected: true, session };
  } catch { await chrome.storage.session.set({ bridgeConnected: false }); return { ...live, connected: false, session: null }; }
}
async function connect() {
  const saved = await chrome.storage.session.get('bridgeTabId');
  if (typeof saved.bridgeTabId === 'number') {
    try { const existing = await chrome.tabs.get(saved.bridgeTabId);
      if (talkBridge(existing)) { await chrome.tabs.update(existing.id!, { active: true });
        await chrome.tabs.sendMessage(existing.id!, { type: 'BRIDGE_PING' }).catch(() => {}); return; }
    } catch { /* closed tab */ }
  }
  const tab = await chrome.tabs.create({ url: BRIDGE_URL });
  await chrome.storage.session.set({ bridgeTabId: tab.id, bridgeConnected: false });
}
async function command(context: SelectedContext, raw: unknown) {
  const parsed = extensionCommandSchema.parse(raw);
  if (parsed.action === 'session') throw new Error('Comando inválido para esta conversa.');
  return withSelectionFence(context, readSelection, async () => {
    const live = await readSelection();
    if (live.selection?.selfAddress !== parsed.chat.selfAddress || live.selection?.peerAddress !== parsed.chat.peerAddress)
      throw new Error('A identidade da conversa mudou.');
    const session = await bridge({ action: 'session' }) as ExtensionSession;
    if (session.scope !== context.scope) throw new Error('Sua conta mudou. Conecte o Talk novamente.');
    const result = await bridge(parsed);
    if (result.scope !== context.scope) throw new Error('Sua conta mudou. Atualize o painel.');
    return result;
  });
}
async function handlePanel(message: PanelRequest) {
  if (message.type === 'STATUS') return status();
  if (message.type === 'CONNECT') { await connect(); return null; }
  if (message.type === 'DISCONNECT') {
    const { bridgeTabId } = await chrome.storage.session.get('bridgeTabId');
    await chrome.storage.session.set({ bridgeConnected: false });
    if (typeof bridgeTabId === 'number') await chrome.tabs.sendMessage(bridgeTabId, { type: 'BRIDGE_DISCONNECT' }).catch(() => {});
    notify(); return null;
  }
  if (message.type === 'COMMAND') return command(message.context, message.command);
  if (message.type === 'INSERT') return withSelectionFence(message.context, readSelection, async () => {
    const latest = await command(message.context, { action: 'read', chat: message.chat });
    if (!('assistant' in latest) || latest.assistant.status !== 'ready' || latest.assistant.suggestion?.id !== message.suggestionId
      || latest.assistant.currentContextKey !== message.contextKey || latest.assistant.suggestion.contextKey !== message.contextKey)
      throw new Error('A sugestão mudou. Atualize o painel antes de inserir.');
    const result = await chrome.tabs.sendMessage(message.context.tabId, { type: 'WA_INSERT', key: message.context.key, body: message.body });
    if (!result?.ok) throw new Error(result?.error ?? 'Não foi possível inserir a sugestão.');
    return null;
  });
  throw new Error('Comando não reconhecido.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Site scripts can publish selection/status only. The privileged command surface is extension-page-only.
  if (sender.id !== chrome.runtime.id) return;
  const fromPanel = sender.url === chrome.runtime.getURL('panel.html');
  if (!fromPanel && sender.tab?.id && sender.frameId === 0) {
    if (message?.type === 'WA_CHANGED' && whatsapp(sender.tab) && selectionSchema.safeParse(message.selection).success) notify();
    if (message?.type === 'BRIDGE_STATUS' && talkBridge(sender.tab)) {
      const tabId = sender.tab.id;
      void chrome.storage.session.get('bridgeTabId').then(async saved => {
        if (saved.bridgeTabId !== tabId) return;
        await chrome.storage.session.set({ bridgeConnected: message.connected === true }); notify();
      });
    }
    return;
  }
  if (!fromPanel) return;
  void handlePanel(message).then(data => respond({ ok: true, data })).catch(error =>
    respond({ ok: false, error: error instanceof Error ? error.message : 'Falha na conexão.' }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => { void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); });
chrome.tabs.onActivated.addListener(notify);
chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.get('bridgeTabId').then(async saved => {
    if (saved.bridgeTabId === tabId) await chrome.storage.session.remove(['bridgeTabId', 'bridgeConnected']); notify();
  });
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== 'loading') return;
  void chrome.storage.session.get('bridgeTabId').then(async saved => {
    if (saved.bridgeTabId === tabId && (!talkBridge(tab) || change.status === 'loading')) await chrome.storage.session.set({ bridgeConnected: false });
    notify();
  });
});
