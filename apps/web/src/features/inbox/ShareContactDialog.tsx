import { useEffect, useRef, useState } from 'react';
import { ContactRound, Search, Send, X } from 'lucide-react';
import type { ContactDto, ConversationDto } from '@prymeira-talk/shared';
import { ApiRequestError, apiCreateConversationMessage, apiGetContacts, apiGetConversationMessages, apiStartContactConversation } from '../../app/api';
import { findOrCreateRecipient, normalizeRecipientPhone } from './send-helpers';
import { createConversationContextImages } from './conversation-context-image';

export function ShareContactDialog({ source, getToken, onClose, onSent }: {
  source: ConversationDto;
  getToken: () => Promise<string | null>;
  onClose(): void;
  onSent(name: string, contextImages: number): void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactDto[]>([]);
  const [recipient, setRecipient] = useState<ContactDto | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardSent, setCardSent] = useState(false);
  const [sentImages, setSentImages] = useState(0);
  const [deliveryUncertain, setDeliveryUncertain] = useState(false);
  const preparedImagesRef = useRef<ReturnType<typeof createConversationContextImages> | null>(null);
  const targetRef = useRef<{ conversationId: string; name: string } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void apiGetContacts(getToken, query).then((contacts) => {
        if (active) setResults(contacts.filter((contact) => contact.id !== source.contactId).slice(0, 12));
      }).catch(() => { if (active) setError('Não foi possível buscar contatos.'); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [getToken, query, source.contactId]);

  const manualPhone = normalizeRecipientPhone(query);
  const sourcePhone = normalizeRecipientPhone(source.contactPhone ?? '');
  const chosenPhone = recipient?.phone ?? phone;
  const chosenLabel = recipient?.name?.trim() || chosenPhone;

  async function send() {
    if (!chosenPhone || busy || deliveryUncertain) return;
    setBusy(true); setError(null);
    try {
      // Capture the source once, before sending anything, so retries cannot change the image or duplicate the card.
      if (!preparedImagesRef.current) {
        const sourceMessages = await apiGetConversationMessages(source.id, getToken);
        preparedImagesRef.current = createConversationContextImages(sourceMessages, source);
      }
      const contextImages = preparedImagesRef.current;
      if (!targetRef.current) {
        const contact = recipient ?? await findOrCreateRecipient(getToken, chosenPhone);
        const conversation = await apiStartContactConversation(getToken, contact.id, { channelId: source.channelId });
        targetRef.current = { conversationId: conversation.id, name: contact.name?.trim() || contact.phone };
      }
      const target = targetRef.current;
      if (!cardSent) {
        const message = await apiCreateConversationMessage(target.conversationId, { contactCard: { sourceConversationId: source.id } }, getToken);
        if (message.status === 'pending') { setDeliveryUncertain(true); throw new Error('O envio do contato não foi confirmado. Verifique a conversa do destinatário.'); }
        if (message.status === 'failed') throw new Error('Não foi possível enviar o contato.');
        setCardSent(true);
      }
      for (let index = sentImages; index < contextImages.length; index += 1) {
        const image = contextImages[index]!;
        const message = await apiCreateConversationMessage(target.conversationId, {
          body: `Histórico recente de ${source.contactName?.trim() || source.contactPhone || 'contato'} (${index + 1}/${contextImages.length})`,
          attachment: image
        }, getToken);
        if (message.status === 'pending') { setDeliveryUncertain(true); throw new Error('O envio da imagem não foi confirmado. Verifique a conversa do destinatário.'); }
        if (message.status === 'failed') throw new Error('Não foi possível enviar a imagem do histórico.');
        setSentImages(index + 1);
      }
      onSent(target.name, contextImages.length);
    } catch (sendError) {
      if (sendError instanceof ApiRequestError && sendError.code === 'EVOLUTION_CONNECTION_CLOSED') {
        setDeliveryUncertain(true);
      }
      setError(sendError instanceof Error ? sendError.message : 'Não foi possível enviar o contato.');
    } finally { setBusy(false); }
  }

  return <div className="inbox-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="inbox-action-dialog" role="dialog" aria-modal="true" aria-labelledby="share-contact-title">
      <header><span className="inbox-action-dialog-icon"><ContactRound size={20} /></span><div><h2 id="share-contact-title">Enviar contato e contexto</h2><p>Compartilhe o cartão e o histórico recente pelo WhatsApp</p></div><button type="button" aria-label="Fechar" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="inbox-action-dialog-body">
        <div className="inbox-share-source"><small>CONTATO A ENVIAR</small><strong>{source.contactName?.trim() || source.contactPhone}</strong><span>{source.contactPhone}</span></div>
        <label className="inbox-field-label" htmlFor="share-recipient-search">Enviar para</label>
        <div className="inbox-dialog-search"><Search size={16} /><input id="share-recipient-search" autoFocus disabled={busy || cardSent} placeholder="Busque um contato ou digite o número com DDD" value={query} onChange={(event) => { targetRef.current = null; setQuery(event.target.value); setRecipient(null); setPhone(null); setResults([]); setError(null); }} /></div>
        {query && !recipient && !phone && !cardSent ? <div className="inbox-recipient-results">
          {results.map((contact) => <button key={contact.id} type="button" onClick={() => { setRecipient(contact); setQuery(contact.name?.trim() || contact.phone); }}><strong>{contact.name?.trim() || contact.phone}</strong><span>{contact.phone}</span></button>)}
          {manualPhone && manualPhone !== sourcePhone && !results.some((contact) => normalizeRecipientPhone(contact.phone) === manualPhone) ? <button type="button" onClick={() => { setPhone(manualPhone); setQuery(manualPhone); }}><strong>Usar {manualPhone}</strong><span>Número informado</span></button> : null}
        </div> : null}
        {chosenPhone ? <p className="inbox-dialog-review">O cartão de <strong>{source.contactName?.trim() || source.contactPhone}</strong> e o contexto visual das últimas 14 mensagens serão enviados para <strong>{chosenLabel}</strong> pelo canal {source.channelName ?? 'atual'}. Conversas longas podem gerar mais de uma imagem. Notas internas não entram.</p> : null}
        {cardSent ? <p className="inbox-dialog-review">Cartão enviado. {sentImages ? `${sentImages} imagem(ns) do histórico enviada(s).` : 'Aguardando imagem do histórico.'}</p> : null}
        {error ? <p className="inbox-dialog-error" role="alert">{error}</p> : null}
      </div>
      <footer><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancelar</button><button type="button" className="primary-button" disabled={!chosenPhone || normalizeRecipientPhone(chosenPhone) === sourcePhone || busy || deliveryUncertain} onClick={() => void send()}><Send size={15} />{busy ? 'Enviando...' : cardSent ? 'Enviar contexto' : 'Enviar contato e contexto'}</button></footer>
    </section>
  </div>;
}
