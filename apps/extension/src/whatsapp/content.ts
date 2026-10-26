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
  if (row && row.getAttribute('aria-selected') !== 'true') tracker.switching();
}, true);
document.addEventListener('keydown', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (['Enter', 'ArrowUp', 'ArrowDown'].includes(event.key) && target?.closest('#pane-side, [data-testid="chat-list"]')) tracker.switching();
  if ((event.ctrlKey || event.metaKey) && ['Tab', '[', ']'].includes(event.key)) tracker.switching();
}, true);
window.addEventListener('storage', () => { tracker.switching(); refresh(); });
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', refresh);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'WA_READ') { tracker.refresh(); respond(tracker.selection); }
  if (message?.type === 'WA_INSERT') {
    tracker.refresh();
    const selection = tracker.selection;
    if (selection.key !== message.key || selection.phase !== 'ready') { respond({ ok: false, error: 'A conversa mudou. Atualize o painel.' }); return; }
    if (typeof message.body !== 'string' || !message.body.trim() || message.body.length > 4000) { respond({ ok: false, error: 'Mensagem inválida.' }); return; }
    const composer = document.querySelector<HTMLElement>('#main footer [contenteditable="true"][role="textbox"]');
    if (!composer || composer.innerText.trim()) { respond({ ok: false, error: 'Deixe o campo de mensagem vazio antes de inserir a sugestão.' }); return; }
    composer.focus();
    const inserted = document.execCommand('insertText', false, message.body);
    respond(inserted && composer.innerText.trim() === message.body.trim() ? { ok: true } : { ok: false, error: 'Não foi possível inserir a mensagem no WhatsApp.' });
  }
});
tracker.start();
