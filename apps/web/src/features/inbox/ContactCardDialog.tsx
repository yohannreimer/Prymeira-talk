import { useEffect, useState } from 'react';
import { ContactRound, MessageSquarePlus, X } from 'lucide-react';
import type { ChannelDto, ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { apiStartContactConversation } from '../../app/api';
import { findOrCreateRecipient, normalizeRecipientPhone } from './send-helpers';

type ContactCard = NonNullable<MessageDto['contactCards']>[number];

export function ContactCardMessage({ cards, onSelect }: { cards: ContactCard[]; onSelect(card: ContactCard): void }) {
  return <div className="talk-shared-contacts">{cards.map((card, index) => <button
    key={`${card.phoneNumber ?? card.fullName}-${index}`} type="button" className="talk-shared-contact"
    onClick={() => onSelect(card)} aria-label={`Abrir contato ${card.fullName}`}>
    <span className="talk-shared-contact-avatar"><ContactRound size={20} /></span>
    <span className="talk-shared-contact-identity"><strong>{card.fullName}</strong><small>{card.phoneNumber || 'Número não informado'}</small></span>
    <span aria-hidden="true">›</span>
  </button>)}</div>;
}

export function ContactCardDialog({ card, channels, currentChannelId, getToken, onClose, onOpened }: {
  card: ContactCard;
  channels: ChannelDto[];
  currentChannelId?: string;
  getToken: () => Promise<string | null>;
  onClose(): void;
  onOpened(conversation: ConversationDto): void;
}) {
  const availableChannels = channels.filter((channel) => channel.provider === 'evolution' && channel.status === 'connected');
  const [channelId, setChannelId] = useState(availableChannels.find((channel) => channel.id === currentChannelId)?.id ?? availableChannels[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phone = card.phoneNumber ? normalizeRecipientPhone(card.phoneNumber) : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  async function act(action: 'save' | 'open') {
    if (!phone || busy || (action === 'open' && !channelId)) return;
    setBusy(true);
    setError(null);
    try {
      const contact = await findOrCreateRecipient(getToken, phone, card.fullName);
      if (action === 'save') { setSaved(true); return; }
      const conversation = await apiStartContactConversation(getToken, contact.id, { channelId });
      onOpened(conversation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível usar este contato.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="inbox-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="inbox-action-dialog" role="dialog" aria-modal="true" aria-labelledby="shared-contact-title">
      <header><span className="inbox-action-dialog-icon"><ContactRound size={20} /></span><div><h2 id="shared-contact-title">Contato compartilhado</h2><p>Salve no Talk ou abra uma conversa</p></div><button type="button" aria-label="Fechar" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="inbox-action-dialog-body">
        <div className="talk-shared-contact-detail"><span className="talk-shared-contact-avatar"><ContactRound size={26} /></span><div><strong>{card.fullName}</strong><p>{card.phoneNumber || 'Número não informado'}</p></div></div>
        {availableChannels.length > 1 ? <><label className="inbox-field-label" htmlFor="shared-contact-channel">Canal da conversa</label><select id="shared-contact-channel" value={channelId} onChange={(event) => setChannelId(event.target.value)}>{availableChannels.map((channel) => <option value={channel.id} key={channel.id}>{channel.displayName || channel.phoneNumber || 'WhatsApp'}</option>)}</select></> : null}
        {!phone ? <p className="inbox-dialog-error" role="alert">Este cartão não contém um telefone brasileiro válido.</p> : null}
        {phone && !channelId ? <p className="inbox-dialog-review">Conecte um canal WhatsApp para abrir a conversa.</p> : null}
        {saved ? <p className="inbox-dialog-review" role="status">Contato salvo no Talk.</p> : null}
        {error ? <p className="inbox-dialog-error" role="alert">{error}</p> : null}
      </div>
      <footer><button type="button" className="secondary-button" disabled={!phone || busy || saved} onClick={() => void act('save')}>{saved ? 'Salvo' : 'Salvar contato'}</button><button type="button" className="primary-button" disabled={!phone || !channelId || busy} onClick={() => void act('open')}><MessageSquarePlus size={16} />{busy ? 'Aguarde...' : 'Abrir conversa'}</button></footer>
    </div>
  </div>;
}
