import { extensionCommandSchema, type ExtensionCommand, type ExtensionReply, type ExtensionSession, type ExtensionAccount } from '@prymeira-talk/shared';
import { BRIDGE_URL, TALK_ORIGIN, WHATSAPP_ORIGIN } from './config';
import { persistentConnection } from './clerk-connection';
import { selectionSchema, type PanelRequest, type PanelState, type SelectedContext, type AccountContext } from './protocol';
import { withSelectionFence } from './selection-fence';
import { canonicalPhone } from './whatsapp/identity';
import { NavigationIntents, assertAccountContext, followupForPreparation, whatsappConversationUrl } from './navigation';
const navigationIntents = new NavigationIntents();
const navigationVersions = new Map<number,number>();
const invalidateNavigation = (windowId:number) => { const version=(navigationVersions.get(windowId)??0)+1;navigationVersions.set(windowId,version);return version; };

const notify = () => { void chrome.runtime.sendMessage({ type: 'PANEL_CHANGED' }).catch(() => {}); };
function talkBridge(tab: chrome.tabs.Tab) {
  if (!tab.url) return false;
  const url = new URL(tab.url); return url.origin === TALK_ORIGIN && url.pathname === '/extension';
}
function whatsapp(tab: chrome.tabs.Tab) { try { return !!tab.url && new URL(tab.url).origin === WHATSAPP_ORIGIN; } catch { return false; } }
async function readSelection(windowId: number) {
  if (!Number.isInteger(windowId) || windowId < 0) throw new Error('Janela do Chrome inválida.');
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id || !whatsapp(tab)) return { windowId, tabId: null, selection: null };
  try { return { windowId, tabId: tab.id, selection: selectionSchema.parse(await chrome.tabs.sendMessage(tab.id, { type: 'WA_READ' })) }; }
  catch { return { windowId, tabId: tab.id, selection: null }; }
}
async function bridge(command: ExtensionCommand) {
  if(persistentConnection){const result=await persistentConnection.execute(command);if(!result.ok)throw new Error(result.error);return result.data;}
  const { bridgeTabId, bridgeConnected } = await chrome.storage.session.get(['bridgeTabId', 'bridgeConnected']);
  if (typeof bridgeTabId !== 'number' || !bridgeConnected) throw new Error('Conecte sua conta pela aba do Talk.');
  let tab: chrome.tabs.Tab;
  try { tab = await chrome.tabs.get(bridgeTabId); } catch { throw new Error('A aba de conexão foi fechada. Conecte o Talk novamente.'); }
  if (!talkBridge(tab)) throw new Error('A aba de conexão mudou. Conecte o Talk novamente.');
  const response = await chrome.tabs.sendMessage(bridgeTabId, { type: 'BRIDGE_EXECUTE', command }) as ExtensionReply;
  if (!response?.ok) throw new Error(response?.error ?? 'Não foi possível consultar o Talk.');
  return response.data;
}
async function status(windowId: number): Promise<PanelState> {
  const live = await readSelection(windowId);
  if(persistentConnection){
    let session=await persistentConnection.session();
    const pending=await chrome.storage.session.get('nativeConnectPendingUntil');
    if(!session&&typeof pending.nativeConnectPendingUntil==='number'&&pending.nativeConnectPendingUntil>Date.now()){
      const connected=await persistentConnection.connect();
      if(connected?.ok&&'channels' in connected.data){session=connected.data;await chrome.storage.session.remove('nativeConnectPendingUntil');}
    }
    return {...await readSelection(windowId),connected:!!session,session};
  }
  const { bridgeConnected } = await chrome.storage.session.get('bridgeConnected');
  if (!bridgeConnected) return { ...live, connected: false, session: null };
  try { const session = await bridge({ action: 'session' });
    if (!('channels' in session)) throw new Error('Sessão inválida.');
    return { ...await readSelection(windowId), connected: true, session };
  } catch { await chrome.storage.session.set({ bridgeConnected: false }); return { ...live, connected: false, session: null }; }
}
async function connect(windowId: number) {
  if(persistentConnection){
    const connected=await persistentConnection.connect();
    if(connected?.ok){await chrome.storage.session.remove('nativeConnectPendingUntil');notify();return;}
    await chrome.storage.session.set({nativeConnectPendingUntil:Date.now()+5*60_000});
  }
  const saved = await chrome.storage.session.get('bridgeTabId');
  if (typeof saved.bridgeTabId === 'number') {
    try { const existing = await chrome.tabs.get(saved.bridgeTabId);
      if (talkBridge(existing)) { await chrome.tabs.update(existing.id!, { active: true });
        await chrome.tabs.sendMessage(existing.id!, { type: 'BRIDGE_PING' }).catch(() => {}); return; }
    } catch { /* closed tab */ }
  }
  const tab = await chrome.tabs.create({ url: BRIDGE_URL, windowId });
  await chrome.storage.session.set({ bridgeTabId: tab.id, bridgeConnected: false });
}
async function command(context: SelectedContext, raw: unknown) {
  const parsed = extensionCommandSchema.parse(raw);
  if (parsed.action === 'session' || parsed.action === 'queue' || parsed.action === 'navigate') throw new Error('Comando inválido para esta conversa.');
  return withSelectionFence(context, () => readSelection(context.windowId), async () => {
    const live = await readSelection(context.windowId);
    if (live.selection?.selfAddress !== parsed.chat.selfAddress || live.selection?.peerAddress !== parsed.chat.peerAddress || (live.selection?.lastMessageId ?? null) !== (parsed.chat.lastMessageId ?? null))
      throw new Error('A identidade da conversa mudou.');
    const session = await bridge({ action: 'session' }) as ExtensionSession;
    if (session.scope !== context.scope) throw new Error('Sua conta mudou. Conecte o Talk novamente.');
    const result = await bridge(parsed);
    if (result.scope !== context.scope) throw new Error('Sua conta mudou. Atualize o painel.');
    return result;
  });
}
async function accountCommand(context: AccountContext, account: ExtensionAccount, raw: unknown) {
  assertAccountContext(context, await readSelection(context.windowId));
  if (canonicalPhone(account.selfAddress) !== canonicalPhone(context.selfAddress)) throw new Error('A conta mudou.');
  const session = await bridge({ action: 'session' }) as ExtensionSession;
  if (session.scope !== context.scope || !session.channels.some(c => c.id === account.channelId && canonicalPhone(c.phoneNumber) === canonicalPhone(context.selfAddress)))
    throw new Error('Canal indisponível para este WhatsApp.');
  assertAccountContext(context, await readSelection(context.windowId));
  const result=await bridge(extensionCommandSchema.parse(raw));
  assertAccountContext(context, await readSelection(context.windowId));
  if(result.scope!==context.scope)throw new Error('Sua conta mudou. Atualize a fila.');
  return result;
}
async function handlePanel(message: PanelRequest) {
  if (message.type === 'STATUS') return status(message.windowId ?? -1);
  if (message.type === 'CONNECT') { await connect(message.windowId ?? -1); return null; }
  if (message.type === 'DISCONNECT') {
    navigationIntents.clear();
    await chrome.storage.session.remove('nativeConnectPendingUntil');
    if(persistentConnection)await persistentConnection.disconnect();
    const { bridgeTabId } = await chrome.storage.session.get('bridgeTabId');
    await chrome.storage.session.set({ bridgeConnected: false });
    if (typeof bridgeTabId === 'number') await chrome.tabs.sendMessage(bridgeTabId, { type: 'BRIDGE_DISCONNECT' }).catch(() => {});
    notify(); return null;
  }
  if (message.type === 'QUEUE') return accountCommand(message.context, message.account, { action: 'queue', account: message.account, kind: message.kind, cursor: message.cursor });
  if (message.type === 'OPEN_CHAT') {
    const navigationVersion=invalidateNavigation(message.context.windowId);
    navigationIntents.cancelWindow(message.context.windowId);
    const target=await accountCommand(message.context,message.account,{action:'navigate',account:message.account,kind:message.kind,id:message.id,expectedUpdatedAt:message.expectedUpdatedAt});
    if(!('conversation' in target) || !('prepare' in target))throw new Error('Destino inválido.');
    const url=whatsappConversationUrl(target);
    assertAccountContext(message.context,await readSelection(message.context.windowId));
    const token=target.prepare?navigationIntents.create(message.context,target):null;
    try {
      const canOpen=await chrome.tabs.sendMessage(message.context.tabId,{type:'WA_CAN_OPEN',selfAddress:message.context.selfAddress,phone:target.conversation.phone});
      if(!canOpen?.ok)throw new Error(canOpen?.error??'Não foi possível abrir a conversa.');
      let opened=canOpen.opened===true;
      if(!opened){
        // A name-only header can still be the target. Resolve its canonical identity before reloading.
        const live=await readSelection(message.context.windowId),selection=live.selection;
        if(selection?.phase==='ready'&&selection.selfAddress&&(selection.peerAddress||selection.lastMessageId)){
          try {
            const current=await command({...message.context,key:selection.key},{action:'read',chat:{channelId:message.account.channelId,selfAddress:selection.selfAddress,peerAddress:selection.peerAddress,lastMessageId:selection.lastMessageId}});
            opened='conversation' in current&&current.conversation.id===target.conversation.id;
          } catch { /* An unresolved source must not prevent opening a verified target. */ }
        }
      }
      if(navigationVersions.get(message.context.windowId)!==navigationVersion)throw new Error('Preparação interrompida pela navegação ou edição no WhatsApp.');
      if(!opened){assertAccountContext(message.context,await readSelection(message.context.windowId));await chrome.tabs.update(message.context.tabId,{url});}
    } catch(cause) { navigationIntents.cancelTab(message.context.tabId);throw cause; }
    return {token,target};
  }
  if (message.type === 'PREPARE_FOLLOWUP') {
    const accountContext={...message.context,selfAddress:message.chat.selfAddress};
    const job=navigationIntents.require(message.token,accountContext);
    const latest=await command(message.context,{action:'read',chat:message.chat});
    if(!('assistant' in latest))throw new Error('Conversa inválida.');
    const body=followupForPreparation(latest,job.target);
    navigationIntents.consume(message.token,accountContext);
    return withSelectionFence(message.context,()=>readSelection(message.context.windowId),async()=>{
      const result=await chrome.tabs.sendMessage(message.context.tabId,{type:'WA_INSERT',key:message.context.key,body});
      if(!result?.ok)throw new Error(result?.error ?? 'Não foi possível preparar a mensagem.');
      return null;
    });
  }
  if (message.type === 'COMMAND') return command(message.context, message.command);
  if (message.type === 'INSERT') return withSelectionFence(message.context, () => readSelection(message.context.windowId), async () => {
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
    if (message?.type === 'WA_NAVIGATION_INTENT' && whatsapp(sender.tab)) {
      invalidateNavigation(sender.tab.windowId);
      for(const token of navigationIntents.cancelTab(sender.tab.id)) void chrome.runtime.sendMessage({type:'NAVIGATION_CANCELLED',token}).catch(()=>{});
    }
    if (message?.type === 'WA_CHANGED' && whatsapp(sender.tab) && selectionSchema.safeParse(message.selection).success) notify();
    if (message?.type === 'BRIDGE_STATUS' && talkBridge(sender.tab)) {
      if(persistentConnection){
        if(message.connected===false&&['user','revoked'].includes(message.reason))void persistentConnection.disconnect().then(()=>notify());
        else notify();
        return;
      }
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
chrome.tabs.onActivated.addListener(({windowId}) => { invalidateNavigation(windowId);const token=navigationIntents.cancelWindow(windowId);if(token)void chrome.runtime.sendMessage({type:'NAVIGATION_CANCELLED',token}).catch(()=>{});notify(); });
chrome.tabs.onRemoved.addListener(tabId => {
  navigationIntents.cancelTab(tabId);
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
