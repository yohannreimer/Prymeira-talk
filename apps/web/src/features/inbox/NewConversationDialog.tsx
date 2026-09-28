import { useEffect, useState, type FormEvent } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import type { ChannelDto, ConversationDto } from '@prymeira-talk/shared';
import { apiStartContactConversation } from '../../app/api';
import { findOrCreateRecipient, normalizeRecipientPhone } from './send-helpers';

export function NewConversationDialog({ channels, getToken, onClose, onOpened }: {
  channels: ChannelDto[];
  getToken: () => Promise<string | null>;
  onClose(): void;
  onOpened(conversation: ConversationDto): void;
}) {
  const availableChannels = channels.filter((channel) => channel.provider === 'evolution' && channel.status === 'connected');
  const [channelId, setChannelId] = useState(availableChannels[0]?.id ?? '');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedPhone = normalizeRecipientPhone(phone);

  useEffect(() => {
    if (!availableChannels.some((channel) => channel.id === channelId)) setChannelId(availableChannels[0]?.id ?? '');
  }, [channels, channelId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  async function openConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedPhone || !channelId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const contact = await findOrCreateRecipient(getToken, normalizedPhone);
      const conversation = await apiStartContactConversation(getToken, contact.id, { channelId });
      onOpened(conversation);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Não foi possível abrir a conversa.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="inbox-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="inbox-action-dialog" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title" onSubmit={(event) => void openConversation(event)}>
      <header><span className="inbox-action-dialog-icon"><MessageSquarePlus size={20} /></span><div><h2 id="new-conversation-title">Nova conversa</h2><p>Abra um atendimento pelo número de WhatsApp</p></div><button type="button" aria-label="Fechar" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="inbox-action-dialog-body">
        <label className="inbox-field-label" htmlFor="new-conversation-phone">Número com DDD</label>
        <div className="inbox-dialog-search"><input id="new-conversation-phone" autoFocus type="tel" inputMode="tel" autoComplete="tel" placeholder="55 79 99139-6920" value={phone} onChange={(event) => { setPhone(event.target.value); setError(null); }} /></div>
        {availableChannels.length > 1 ? <><label className="inbox-field-label" htmlFor="new-conversation-channel">Canal de envio</label><select id="new-conversation-channel" value={channelId} onChange={(event) => setChannelId(event.target.value)}>{availableChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.displayName || channel.phoneNumber || 'WhatsApp'}</option>)}</select></> : null}
        {availableChannels.length === 0 ? <p className="inbox-dialog-error" role="alert">Conecte um canal WhatsApp para iniciar uma conversa.</p> : <p className="inbox-dialog-review">A conversa será aberta para você escrever a primeira mensagem. Nada será enviado agora.</p>}
        {phone.trim() && !normalizedPhone ? <p className="inbox-dialog-error" role="alert">Digite um número brasileiro válido com DDD.</p> : null}
        {error ? <p className="inbox-dialog-error" role="alert">{error}</p> : null}
      </div>
      <footer><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancelar</button><button type="submit" className="primary-button" disabled={!normalizedPhone || !channelId || busy}>{busy ? 'Abrindo...' : 'Abrir conversa'}</button></footer>
    </form>
  </div>;
}
