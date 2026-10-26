import { EXTENSION_BRIDGE_REQUEST, EXTENSION_BRIDGE_RESPONSE, EXTENSION_BRIDGE_STATUS, EXTENSION_BRIDGE_PING, EXTENSION_BRIDGE_DISCONNECT, extensionCommandSchema } from '@prymeira-talk/shared';

if (location.pathname === '/extension') {
  const pending = new Map<string, (result: unknown) => void>();
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === EXTENSION_BRIDGE_STATUS) {
      void chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS', connected: event.data.connected === true }).catch(() => {});
    }
    if (event.data?.type === EXTENSION_BRIDGE_RESPONSE && typeof event.data.requestId === 'string') pending.get(event.data.requestId)?.(event.data.result);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'BRIDGE_PING' || message?.type === 'BRIDGE_DISCONNECT') {
      window.postMessage({ type: message.type === 'BRIDGE_PING' ? EXTENSION_BRIDGE_PING : EXTENSION_BRIDGE_DISCONNECT }, location.origin); respond({ ok: true }); return;
    }
    if (message?.type !== 'BRIDGE_EXECUTE') return;
    const parsed = extensionCommandSchema.safeParse(message.command);
    if (!parsed.success) { respond({ ok: false, error: 'Comando inválido.' }); return; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); respond({ ok: false, error: 'A conexão com o Talk expirou. Verifique a aba de conexão.' }); }, 35_000);
    pending.set(requestId, result => { clearTimeout(timer); pending.delete(requestId); respond(result); });
    window.postMessage({ type: EXTENSION_BRIDGE_REQUEST, requestId, command: parsed.data }, location.origin);
    return true;
  });
}
