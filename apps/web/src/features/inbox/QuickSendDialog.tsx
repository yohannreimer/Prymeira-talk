import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Search, Send, Users, X } from 'lucide-react';
import type { ChannelDto, ContactDto } from '@prymeira-talk/shared';
import { apiCancelInboxQuickSend, apiGetContactsPage, apiGetConversations, apiGetInboxQuickSend, apiGetLatestInboxQuickSend, apiResumeInboxQuickSend, apiStartInboxQuickSend, type CampaignProgressDto } from '../../app/api';
import { ContactAvatar } from './ContactAvatar';
import { normalizeRecipientPhone } from './send-helpers';

type Recipient = { phone: string; name: string; contactId?: string };

function ContactOption({ contact, checked, onToggle }: {
  contact: Pick<ContactDto, 'id' | 'name' | 'phone'>;
  checked: boolean;
  onToggle(): void;
}) {
  return <button type="button" role="option" aria-selected={checked} onClick={onToggle}>
    <ContactAvatar contactId={contact.id} name={contact.name || contact.phone} className="inbox-picker-avatar" />
    <span className="inbox-picker-label"><strong>{contact.name?.trim() || contact.phone}</strong><small>{contact.phone}</small></span>
    <span className={`inbox-picker-check${checked ? ' is-selected' : ''}`}>{checked ? <Check size={14} /> : null}</span>
  </button>;
}

export function QuickSendDialog({ channels, initialChannelId, getToken, onClose, onSent }: {
  channels: ChannelDto[];
  initialChannelId?: string;
  getToken: () => Promise<string | null>;
  onClose(): void;
  onSent(): void;
}) {
  const availableChannels = channels.filter((channel) => channel.provider === 'evolution' && (channel.status === 'connected' || channel.status === 'connecting'));
  const [channelId, setChannelId] = useState(initialChannelId && availableChannels.some((channel) => channel.id === initialChannelId) ? initialChannelId : availableChannels[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [contactsPanelOpen, setContactsPanelOpen] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const [matches, setMatches] = useState<ContactDto[]>([]);
  const [recentContacts, setRecentContacts] = useState<Array<Pick<ContactDto, 'id' | 'name' | 'phone'>>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [rawNumbers, setRawNumbers] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [body, setBody] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CampaignProgressDto | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const selectedChannel = availableChannels.find((channel) => channel.id === channelId);

  useEffect(() => {
    if (!channelId) return;
    let active = true;
    setRecentContacts([]);
    void apiGetConversations(getToken, { status: 'all', channelId }).then((conversations) => {
      if (!active) return;
      const seen = new Set<string>();
      setRecentContacts(conversations.filter((conversation) => {
        if (!conversation.contactPhone || seen.has(conversation.contactId)) return false;
        seen.add(conversation.contactId); return true;
      }).slice(0, 30).map((conversation) => ({
        id: conversation.contactId, name: conversation.contactName ?? null, phone: conversation.contactPhone!
      })));
    }).catch(() => { if (active) setRecentContacts([]); });
    return () => { active = false; };
  }, [getToken, channelId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || sending) return;
      if (contactsPanelOpen) setContactsPanelOpen(false);
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sending, onClose, contactsPanelOpen]);

  useEffect(() => {
    let active = true;
    void apiGetLatestInboxQuickSend(getToken).then((latest) => {
      if (active && latest.campaignId) setCampaignId((current) => current ?? latest.campaignId);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [getToken]);

  useEffect(() => {
    if (!contactsPanelOpen) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoadingContacts(true);
      void apiGetContactsPage(getToken, { search: query, limit: 50 }).then((page) => {
        if (!active) return;
        setMatches(page.items); setNextCursor(page.nextCursor); setError(null);
      }).catch(() => { if (active) setError('Não foi possível carregar os contatos.'); })
        .finally(() => { if (active) setLoadingContacts(false); });
    }, query ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [getToken, query, contactsPanelOpen]);

  useEffect(() => {
    if (!campaignId) return;
    let active = true;
    const refresh = () => { void apiGetInboxQuickSend(getToken, campaignId).then((next) => {
      if (active) setProgress(next);
    }).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [campaignId, getToken]);

  async function loadMore() {
    if (!nextCursor || moreLoading) return;
    const search = query;
    setMoreLoading(true);
    try {
      const page = await apiGetContactsPage(getToken, { search, cursor: nextCursor, limit: 50 });
      if (search !== queryRef.current) return;
      setMatches((current) => {
        const seen = new Set(current.map((contact) => contact.id));
        return [...current, ...page.items.filter((contact) => !seen.has(contact.id))];
      });
      setNextCursor(page.nextCursor);
    } catch { setError('Não foi possível carregar mais contatos.'); }
    finally { setMoreLoading(false); }
  }

  function toggleRecipient(contact: Pick<ContactDto, 'id' | 'name' | 'phone'>) {
    const phone = normalizeRecipientPhone(contact.phone);
    if (!phone) { setError('Este contato não tem um telefone válido.'); return; }
    setRecipients((current) => current.some((item) => item.phone === phone)
      ? current.filter((item) => item.phone !== phone)
      : [...current, { phone, name: contact.name?.trim() || contact.phone, contactId: contact.id }]);
    setError(null);
  }

  function addNumbers() {
    const entries = rawNumbers.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
    if (entries.length === 0) return;
    const next = [...recipients];
    for (const entry of entries) {
      const phone = normalizeRecipientPhone(entry);
      if (!phone) { setError(`Número inválido: ${entry}`); return; }
      if (!next.some((recipient) => recipient.phone === phone)) next.push({ phone, name: phone });
    }
    if (next.length > 5000) { setError('Selecione até 5.000 destinatários por envio.'); return; }
    setRecipients(next); setRawNumbers(''); setError(null);
  }

  async function startQueue() {
    if (!channelId || !body.trim() || recipients.length === 0 || sending) return;
    setSending(true); setError(null);
    try {
      const queued = await apiStartInboxQuickSend(getToken, {
        confirmation: true,
        idempotencyKey, channelId, body: body.trim(),
        recipients: recipients.map(({ contactId, phone, name }) => ({ contactId, phone, name }))
      });
      setCampaignId(queued.campaignId);
      setProgress({ status: 'sending', total: queued.recipientsQueued, sent: 0,
        pending: queued.recipientsQueued, skipped: 0, failed: 0, uncertain: 0, nextScheduledAt: null });
      onSent();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Não foi possível iniciar o envio.');
    } finally { setSending(false); }
  }

  async function cancelQueue() {
    if (!campaignId || sending) return;
    setSending(true); setError(null);
    try { setProgress(await apiCancelInboxQuickSend(getToken, campaignId)); }
    catch (cancelError) { setError(cancelError instanceof Error ? cancelError.message : 'Não foi possível cancelar a fila.'); }
    finally { setSending(false); }
  }

  async function resumeQueue() {
    if (!campaignId || sending) return;
    setSending(true); setError(null);
    try { setProgress(await apiResumeInboxQuickSend(getToken, campaignId)); }
    catch (resumeError) { setError(resumeError instanceof Error ? resumeError.message : 'Não foi possível retomar a fila.'); }
    finally { setSending(false); }
  }

  const queueFinished = progress && ['completed', 'canceled', 'failed'].includes(progress.status);
  return <div className="inbox-dialog-backdrop" onMouseDown={(event) => {
    if (event.target !== event.currentTarget || sending) return;
    if (contactsPanelOpen) setContactsPanelOpen(false);
    else onClose();
  }}>
    <div className={`inbox-quick-send-shell${contactsPanelOpen && !reviewing && !campaignId ? ' is-expanded' : ''}`} role="dialog" aria-modal="true" aria-label={contactsPanelOpen ? 'Selecionar contatos para envio' : 'Enviar para várias pessoas'}>
    <section className="inbox-action-dialog inbox-action-dialog--wide">
      <header><span className="inbox-action-dialog-icon"><Users size={20} /></span><div><h2 id="quick-send-title">Enviar para várias pessoas</h2><p>Selecione os contatos e confirme antes de iniciar a fila</p></div><button type="button" aria-label="Fechar" disabled={sending} onClick={onClose}><X size={18} /></button></header>
      <div className="inbox-action-dialog-body">
        {campaignId && progress ? <div className="inbox-bulk-results" role="status">
          <strong>{progress.status === 'paused' || progress.status === 'needs_attention' ? 'Fila pausada' : queueFinished ? 'Fila concluída' : 'Fila em andamento'}</strong>
          <p>{progress.sent} enviados · {progress.pending} pendentes · {progress.skipped} sem WhatsApp{progress.uncertain ? ` · ${progress.uncertain} para conferir` : ''}</p>
          {progress.nextScheduledAt && !queueFinished ? <p>Próximo envio: {new Date(progress.nextScheduledAt).toLocaleString('pt-BR')}</p> : null}
          <p>A fila continua no servidor mesmo se esta janela for fechada.</p>
        </div> : <>
          <label className="inbox-field-label" htmlFor="quick-channel">Canal de envio</label>
          <select id="quick-channel" value={channelId} disabled={reviewing || sending} onChange={(event) => setChannelId(event.target.value)}><option value="">Selecione um canal</option>{availableChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.displayName ?? channel.phoneNumber ?? 'Canal'}{channel.status === 'connecting' ? ' · conexão não confirmada' : ''}</option>)}</select>
          {availableChannels.length === 0 ? <p className="inbox-dialog-error">Conecte um canal WhatsApp Evolution para usar este envio.</p> : null}
          {selectedChannel?.status === 'connecting' ? <p className="inbox-dialog-error">A conexão deste canal ainda não foi confirmada. A fila pausará se o WhatsApp não responder.</p> : null}
          {!reviewing ? <>
            <span className="inbox-field-label">Escolher contatos · {recipients.length} selecionados</span>
            {recentContacts.length ? <><span className="inbox-picker-section-label">Conversas recentes</span><div className="inbox-contact-picker inbox-contact-picker--recent" role="listbox" aria-multiselectable="true" aria-label="Conversas recentes para envio">{recentContacts.map((contact) => {
              const checked = recipients.some((recipient) => recipient.phone === normalizeRecipientPhone(contact.phone));
              return <ContactOption key={contact.id} contact={contact} checked={checked} onToggle={() => toggleRecipient(contact)} />;
            })}</div></> : null}
            <button className="inbox-open-contacts" type="button" onClick={() => setContactsPanelOpen(true)}><Users size={18} /><span><strong>Todos os contatos</strong><small>Buscar e selecionar na lista completa</small></span><ChevronRight size={18} /></button>
            <label className="inbox-field-label" htmlFor="quick-unsaved-numbers">Números sem cadastro</label>
            <div className="inbox-dialog-search"><textarea id="quick-unsaved-numbers" placeholder="Cole números com DDD, um por linha" value={rawNumbers} onChange={(event) => setRawNumbers(event.target.value)} /></div>
            {rawNumbers.trim() ? <button type="button" className="inbox-add-numbers" onClick={addNumbers}>Adicionar números</button> : null}
            {recipients.length ? <div className="inbox-recipient-chips">{recipients.slice(0, 6).map((recipient) => <span key={recipient.phone}>{recipient.name}<button type="button" aria-label={`Remover ${recipient.name}`} onClick={() => setRecipients((current) => current.filter((item) => item.phone !== recipient.phone))}><X size={13} /></button></span>)}{recipients.length > 6 ? <button type="button" className="inbox-recipient-more" onClick={() => setContactsPanelOpen(true)}>+{recipients.length - 6} selecionados</button> : null}</div> : null}
            <label className="inbox-field-label" htmlFor="quick-message">Mensagem</label>
            <textarea id="quick-message" className="inbox-bulk-message" maxLength={2000} placeholder="Escreva a mensagem para todos os destinatários" value={body} onChange={(event) => setBody(event.target.value)} />
          </> : <div className="inbox-bulk-review"><small>REVISÃO DO ENVIO</small><p><strong>Canal:</strong> {selectedChannel?.displayName ?? 'Canal selecionado'}</p><strong>Destinatários ({recipients.length})</strong><div className="inbox-bulk-review-recipients">{recipients.map((recipient) => <span key={recipient.phone}>{recipient.name === recipient.phone ? recipient.phone : `${recipient.name} (${recipient.phone})`}</span>)}</div><blockquote>{body.trim()}</blockquote><p>O servidor enviará até 10 mensagens por lote e aguardará 3 minutos entre lotes. Você poderá cancelar as mensagens pendentes.</p></div>}
        </>}
        {error ? <p className="inbox-dialog-error" role="alert">{error}</p> : null}
      </div>
      <footer>{campaignId ? <><button type="button" className="secondary-button" onClick={onClose}>Fechar</button>{progress?.status === 'paused' ? <button type="button" className="secondary-button" disabled={sending} onClick={() => void resumeQueue()}>Retomar fila</button> : null}{!queueFinished ? <button type="button" className="secondary-button" disabled={sending} onClick={() => void cancelQueue()}>Cancelar pendentes</button> : null}</> : <><button type="button" className="secondary-button" disabled={sending} onClick={reviewing ? () => setReviewing(false) : onClose}>{reviewing ? 'Voltar' : 'Cancelar'}</button><button type="button" className="primary-button" disabled={!channelId || !body.trim() || recipients.length === 0 || sending} onClick={reviewing ? () => void startQueue() : () => { setContactsPanelOpen(false); setReviewing(true); setError(null); }}><Send size={15} />{sending ? 'Iniciando fila...' : reviewing ? `Confirmar ${recipients.length} envios` : 'Revisar envio'}</button></>}</footer>
    </section>
    {contactsPanelOpen && !reviewing && !campaignId ? <aside className="inbox-all-contacts-panel" aria-label="Selecionar todos os contatos">
      <header><div><h3>Todos os contatos</h3><p>{recipients.length} selecionados · escolha quantos precisar</p></div><button type="button" aria-label="Fechar lista de contatos" onClick={() => setContactsPanelOpen(false)}><X size={18} /></button></header>
      <div className="inbox-all-contacts-search"><Search size={17} /><input id="quick-recipient-search" type="search" aria-label="Buscar contatos por nome ou telefone" placeholder="Buscar nome ou telefone" value={query} onChange={(event) => { setQuery(event.target.value); setMatches([]); setNextCursor(null); setError(null); }} /></div>
      <div className="inbox-all-contacts-list" role="listbox" aria-multiselectable="true" aria-label="Contatos para envio">
        {loadingContacts ? <p className="list-note">Carregando contatos...</p> : matches.length === 0 && !nextCursor ? <p className="list-note">Nenhum contato encontrado.</p> : matches.map((contact) => {
          const checked = recipients.some((recipient) => recipient.phone === normalizeRecipientPhone(contact.phone));
          return <ContactOption key={contact.id} contact={contact} checked={checked} onToggle={() => toggleRecipient(contact)} />;
        })}
        {nextCursor ? <button className="inbox-picker-more" type="button" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? 'Carregando...' : 'Mostrar mais contatos'}</button> : null}
      </div>
      {error ? <p className="inbox-dialog-error" role="alert">{error}</p> : null}
      <footer><span>{recipients.length} selecionados</span><button type="button" className="primary-button" onClick={() => setContactsPanelOpen(false)}>Concluir seleção</button></footer>
    </aside> : null}
    </div>
  </div>;
}
