import { useEffect, useState } from 'react';
import { ChevronRight, ContactRound, MessageSquarePlus, X } from 'lucide-react';
import { ContactAvatar } from './ContactAvatar';
import type { ChannelDto, ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { apiStartContactConversation } from '../../app/api';
import { findOrCreateRecipient, normalizeRecipientPhone } from './send-helpers';

type ContactCard = NonNullable<MessageDto['contactCards']>[number];

/** A shared contact like WhatsApp shows it: the person's picture and name, a chevron to see it, then "Conversar". */
export function ContactCardMessage({ cards, conversationId, onSelect }: { cards: ContactCard[]; conversationId?: string; onSelect(card: ContactCard): void }) {
  return <div className="talk-shared-contacts">{cards.map((card, index) => <button
    key={`${card.phoneNumber ?? card.fullName}-${index}`} type="button" className="talk-shared-contact"
    onClick={() => onSelect(card)} aria-label={`Ver contato ${card.fullName}`}>
    <ContactAvatar conversationId={conversationId} cardPhone={card.phoneNumber ?? undefined} name={card.fullName} className="talk-shared-contact-avatar" />
    <strong className="talk-shared-contact-name">{card.fullName}</strong>
    <ChevronRight size={18} aria-hidden="true" />
  </button>)}</div>;
}

/** Below the time, like WhatsApp: one tap opens (or starts) the conversation with the shared number. */
export function ContactCardActions({ cards, busy, onChat }: { cards: ContactCard[]; busy: boolean; onChat(card: ContactCard): void }) {
  const card = cards.length === 1 && cards[0]!.phoneNumber ? cards[0]! : null;
  if (!card) return null;
  return <div className="talk-shared-contact-actions"><button type="button" disabled={busy} onClick={() => onChat(card)}>{busy ? 'Abrindo…' : 'Conversar'}</button></div>;
}

/** Saves the shared number in Talk if needed and opens its conversation on the channel given. */
export async function startCardConversation(card: ContactCard, channelId: string, getToken: () => Promise<string | null>) {
  const phone = card.phoneNumber ? normalizeRecipientPhone(card.phoneNumber) : null;
  if (!phone) throw new Error('Este cartão não contém um telefone válido.');
  const contact = await findOrCreateRecipient(getToken, phone, card.fullName);
  return apiStartContactConversation(getToken, contact.id, { channelId });
}

export function ContactCardDialog({ card, conversationId, channels, currentChannelId, getToken, onClose, onOpened }: {
  card: ContactCard;
  conversationId?: string;
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
        <div className="talk-shared-contact-detail"><ContactAvatar conversationId={conversationId} cardPhone={card.phoneNumber ?? undefined} name={card.fullName} className="talk-shared-contact-avatar" /><div><strong>{card.fullName}</strong><p>{card.phoneNumber || 'Número não informado'}</p></div></div>
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
