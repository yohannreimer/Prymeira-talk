import { insertWhatsAppDraft } from './insert-draft';
import { canonicalPhone, ownAddress } from './identity';
import { observeWhatsApp, SelectionTracker } from './observation';

const tracker = new SelectionTracker(() => observeWhatsApp(document, localStorage), selection => {
  void chrome.runtime.sendMessage({ type: 'WA_CHANGED', selection }).catch(() => {});
});
let scheduled = false;
const refresh = () => {
  if (scheduled) return; scheduled = true;
  requestAnimationFrame(() => { scheduled = false; tracker.refresh(); });
};
const observer = new MutationObserver(refresh);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
  attributeFilter: ['data-id', 'title', 'aria-selected'] });
document.addEventListener('pointerdown', event => {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest('#pane-side [role="row"], #pane-side [role="listitem"], [data-testid="chat-list"] [role="row"]');
  if (row || target?.closest('#main footer')) void chrome.runtime.sendMessage({type:'WA_NAVIGATION_INTENT'}).catch(()=>{});
  if (row && row.getAttribute('aria-selected') !== 'true') tracker.switching();
}, true);
document.addEventListener('keydown', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (['Enter', 'ArrowUp', 'ArrowDown'].includes(event.key) && target?.closest('#pane-side, [data-testid="chat-list"]')) { tracker.switching(); void chrome.runtime.sendMessage({type:'WA_NAVIGATION_INTENT'}).catch(()=>{}); }
  if ((event.ctrlKey || event.metaKey) && ['Tab', '[', ']'].includes(event.key)) tracker.switching();
}, true);
document.addEventListener('beforeinput',event=>{ if(event.isTrusted && event.target instanceof Element && event.target.closest('#main footer')) void chrome.runtime.sendMessage({type:'WA_NAVIGATION_INTENT'}).catch(()=>{}); },true);
window.addEventListener('storage', () => { tracker.switching(); refresh(); });
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', refresh);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'WA_CAN_OPEN') {
    const self=ownAddress(localStorage),composer=document.querySelector<HTMLElement>('#main footer [contenteditable="true"][role="textbox"]');
    respond(!self || canonicalPhone(self)!==canonicalPhone(message.selfAddress ?? '') ? {ok:false,error:'A conta do WhatsApp mudou.'} : composer?.innerText.trim() ? {ok:false,error:'Há um rascunho no WhatsApp. Termine ou limpe o campo antes de abrir outra conversa.'} : {ok:true}); return;
  }
  if (message?.type === 'WA_READ') { tracker.refresh(); respond(tracker.selection); }
  if (message?.type === 'WA_INSERT') {
    tracker.refresh();
    const selection = tracker.selection;
    if (selection.key !== message.key || selection.phase !== 'ready') { respond({ ok: false, error: 'A conversa mudou. Atualize o painel.' }); return; }
    if (typeof message.body !== 'string' || !message.body.trim() || message.body.length > 4000) { respond({ ok: false, error: 'Mensagem inválida.' }); return; }
    void insertWhatsAppDraft(document,message.body,()=>{tracker.refresh();return tracker.selection.key===message.key&&tracker.selection.phase==='ready';})
      .then(respond).catch(()=>respond({ok:false,error:'Não foi possível confirmar o preenchimento. Confira o campo do WhatsApp antes de tentar novamente.'}));
    return true;
  }
});
tracker.start();
