import { useEffect, useState } from 'react';
import { Check, Search, Send, Users, X } from 'lucide-react';
import type { ChannelDto, ContactDto } from '@prymeira-talk/shared';
import { apiCreateConversationMessage, apiGetContacts, apiStartContactConversation } from '../../app/api';
import { findOrCreateRecipient, normalizeRecipientPhone } from './send-helpers';

type Recipient = { phone: string; name: string; contactId?: string };
type SendResult = { recipient: Recipient; status: 'sent' | 'check'; error?: string };

export function QuickSendDialog({ channels, initialChannelId, getToken, onClose, onSent }: {
  channels: ChannelDto[];
  initialChannelId?: string;
  getToken: () => Promise<string | null>;
  onClose(): void;
  onSent(): void;
}) {
  const availableChannels = channels.filter((channel) => channel.provider === 'evolution' && channel.status === 'connected');
  const [channelId, setChannelId] = useState(initialChannelId && availableChannels.some((channel) => channel.id === initialChannelId) ? initialChannelId : availableChannels[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ContactDto[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [body, setBody] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<SendResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending) onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sending, onClose]);

  useEffect(() => {
    if (!query.trim() || query.includes('\n')) { setMatches([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void apiGetContacts(getToken, query).then((contacts) => {
        if (active) setMatches(contacts.slice(0, 10));
      }).catch(() => { if (active) setError('Não foi possível buscar contatos.'); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [getToken, query]);

  function addRecipient(recipient: Recipient) {
    const phone = normalizeRecipientPhone(recipient.phone);
    if (!phone) { setError('Digite um telefone brasileiro válido com DDD.'); return; }
    if (recipients.some((item) => item.phone === phone)) { setError('Este número já foi escolhido.'); return; }
    if (recipients.length >= 10) { setError('Escolha até 10 destinatários por envio.'); return; }
    setRecipients((current) => [...current, { ...recipient, phone }]);
    setQuery(''); setMatches([]); setError(null);
  }

  function addNumbers() {
    const entries = query.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
    if (entries.length === 0) return;
    const next = [...recipients];
    for (const entry of entries) {
      const phone = normalizeRecipientPhone(entry);
      if (!phone) { setError(`Número inválido: ${entry}`); return; }
      if (!next.some((recipient) => recipient.phone === phone)) next.push({ phone, name: phone });
    }
    if (next.length > 10) { setError('Escolha até 10 destinatários por envio.'); return; }
    setRecipients(next); setQuery(''); setMatches([]); setError(null);
  }

  async function sendAll() {
    if (!channelId || !body.trim() || recipients.length === 0 || sending) return;
    setSending(true); setResults([]); setError(null);
    const sent: SendResult[] = [];
    for (const recipient of recipients) {
      try {
        const contact = recipient.contactId
          ? { id: recipient.contactId }
          : await findOrCreateRecipient(getToken, recipient.phone);
        const conversation = await apiStartContactConversation(getToken, contact.id, { channelId });
        const message = await apiCreateConversationMessage(conversation.id, { body: body.trim() }, getToken);
        if (message.status === 'pending') throw new Error('O canal não confirmou o envio.');
        sent.push({ recipient, status: 'sent' });
      } catch (sendError) {
        sent.push({ recipient, status: 'check', error: sendError instanceof Error ? sendError.message : 'Envio não confirmado.' });
      }
      setResults([...sent]);
    }
    setSending(false);
    if (sent.some((result) => result.status === 'sent')) onSent();
  }

  return <div className="inbox-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose(); }}>
    <section className="inbox-action-dialog inbox-action-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="quick-send-title">
      <header><span className="inbox-action-dialog-icon"><Users size={20} /></span><div><h2 id="quick-send-title">Enviar para várias pessoas</h2><p>Escolha até 10 destinatários e revise antes de enviar</p></div><button type="button" aria-label="Fechar" disabled={sending} onClick={onClose}><X size={18} /></button></header>
      <div className="inbox-action-dialog-body">
        {results.length === recipients.length && results.length > 0 && !sending ? <div className="inbox-bulk-results" role="status"><strong>Envio concluído</strong>{results.map(({ recipient, status, error }) => <p key={recipient.phone}><span>{status === 'sent' ? <Check size={15} /> : <X size={15} />}</span>{recipient.name}: {status === 'sent' ? 'enviado' : `verificar antes de tentar novamente${error ? ` — ${error}` : ''}`}</p>)}</div> : <>
          <label className="inbox-field-label" htmlFor="quick-channel">Canal de envio</label>
          <select id="quick-channel" value={channelId} disabled={reviewing || sending} onChange={(event) => setChannelId(event.target.value)}><option value="">Selecione um canal</option>{availableChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.displayName ?? channel.phoneNumber ?? 'Canal'}</option>)}</select>
          {availableChannels.length === 0 ? <p className="inbox-dialog-error">Conecte um canal WhatsApp Evolution para usar este envio.</p> : null}
          {!reviewing ? <>
            <label className="inbox-field-label" htmlFor="quick-recipient-search">Destinatários</label>
            <div className="inbox-dialog-search"><Search size={16} /><textarea id="quick-recipient-search" placeholder="Busque um contato ou cole números, um por linha" value={query} onChange={(event) => { setQuery(event.target.value); setError(null); }} /></div>
            {matches.length > 0 && query.trim() && !query.includes('\n') ? <div className="inbox-recipient-results">{matches.map((contact) => <button key={contact.id} type="button" onClick={() => addRecipient({ phone: contact.phone, name: contact.name?.trim() || contact.phone, contactId: contact.id })}><strong>{contact.name?.trim() || contact.phone}</strong><span>{contact.phone}</span></button>)}</div> : null}
            {query.trim() ? <button type="button" className="inbox-add-numbers" onClick={addNumbers}>Adicionar número{query.includes('\n') ? 's' : ''}</button> : null}
            <div className="inbox-recipient-chips">{recipients.map((recipient) => <span key={recipient.phone}>{recipient.name}<button type="button" aria-label={`Remover ${recipient.name}`} onClick={() => setRecipients((current) => current.filter((item) => item.phone !== recipient.phone))}><X size={13} /></button></span>)}</div>
            <label className="inbox-field-label" htmlFor="quick-message">Mensagem</label>
            <textarea id="quick-message" className="inbox-bulk-message" maxLength={4000} placeholder="Escreva a mensagem para todos os destinatários" value={body} onChange={(event) => setBody(event.target.value)} />
          </> : <div className="inbox-bulk-review"><small>REVISÃO DO ENVIO</small><p><strong>Canal:</strong> {availableChannels.find((channel) => channel.id === channelId)?.displayName ?? 'Canal selecionado'}</p><p><strong>Destinatários ({recipients.length}):</strong> {recipients.map((recipient) => recipient.name === recipient.phone ? recipient.phone : `${recipient.name} (${recipient.phone})`).join(', ')}</p><blockquote>{body.trim()}</blockquote><p>As mensagens serão enviadas individualmente e registradas nas conversas.</p></div>}
        </>}
        {error ? <p className="inbox-dialog-error" role="alert">{error}</p> : null}
      </div>
      <footer>{results.length === recipients.length && results.length > 0 && !sending ? <button type="button" className="primary-button" onClick={onClose}>Fechar</button> : <><button type="button" className="secondary-button" disabled={sending} onClick={reviewing ? () => setReviewing(false) : onClose}>{reviewing ? 'Voltar' : 'Cancelar'}</button><button type="button" className="primary-button" disabled={!channelId || !body.trim() || recipients.length === 0 || sending} onClick={reviewing ? () => void sendAll() : () => { setReviewing(true); setError(null); }}><Send size={15} />{sending ? `Enviando ${results.length + 1} de ${recipients.length}...` : reviewing ? `Confirmar ${recipients.length} envios` : 'Revisar envio'}</button></>}</footer>
    </section>
  </div>;
}
