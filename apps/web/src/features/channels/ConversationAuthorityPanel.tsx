import { useCallback, useEffect, useState } from 'react';
import { apiListConversationAuthority, apiResolveConversationAuthority, type AuthorityReviewConversation, type AuthorityReviewItem } from '../../app/api';

const label = (conversation: AuthorityReviewConversation) => conversation.contactName?.trim() || conversation.contactPhone;

/** One WhatsApp person with two conversations (for example a phone contact and a contact the provider only knew by a
 * hidden ID). Talk normally decides on its own: the phone-number conversation stays, the other is hidden and its
 * history shows inside the one that stays. Only cases it cannot decide safely land here (no phone conversation, a
 * send with an unknown outcome, an earlier manual choice). Renders nothing when there is nothing to decide. */
export function ConversationAuthorityPanel({ getToken, refreshKey }: { getToken: () => Promise<string | null>; refreshKey?: number }) {
  const [items, setItems] = useState<AuthorityReviewItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await apiListConversationAuthority(getToken)); setError(null); }
    catch { /* a failed refresh keeps what is on screen */ }
  }, [getToken]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function choose(item: AuthorityReviewItem, conversation: AuthorityReviewConversation) {
    setBusy(conversation.id); setError(null);
    try { await apiResolveConversationAuthority(getToken, item.chatId, conversation.id); setItems((current) => current.filter((candidate) => candidate.chatId !== item.chatId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível escolher a conversa.'); }
    finally { setBusy(null); }
  }

  if (items.length === 0) return null;
  return (
    <section className="context-card" aria-label="Conversas duplicadas" style={{ margin: '0 16px 12px' }}>
      <div className="context-card-title">Conversas duplicadas ({items.length})</div>
      <p className="list-note">O Talk já mantém sozinho a conversa do número de telefone. Estas ele não conseguiu decidir com segurança: escolha qual continua. A outra some da lista e o histórico dela aparece junto; nada é apagado.</p>
      {error ? <p className="error-note" role="alert">{error}</p> : null}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
        {items.map((item) => (
          <li key={item.chatId} data-chat-id={item.chatId} style={{ display: 'grid', gap: 6 }}>
            <strong>{item.address.split('@')[0]}</strong>
            {item.conversations.map((conversation) => (
              <div key={conversation.id} style={{ display: 'grid', gap: 4 }}>
                <div>
                  {label(conversation)} · {conversation.messageCount} mensagens{conversation.assignedTo ? ` · ${conversation.assignedTo}` : ''}
                  {conversation.lastMessagePreview ? <div className="list-note">“{conversation.lastMessagePreview}”</div> : null}
                </div>
                <div className="channel-row-actions">
                  <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void choose(item, conversation)}>Atender por esta</button>
                </div>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
