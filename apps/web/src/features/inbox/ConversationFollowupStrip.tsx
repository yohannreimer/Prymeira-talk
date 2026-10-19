import type { ConversationFollowupDto } from '@prymeira-talk/shared';
import { BellRing, Check, MessageCircleReply, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGetConversationFollowup, apiMarkFollowupDone, apiMarkFollowupNoFollowup, FollowupStaleError } from '../../app/api';
import { formatFollowupDate } from '../followups/followup-display';
import './conversation-followup.css';

const activeStatuses = new Set<ConversationFollowupDto['status']>(['evaluating', 'scheduled', 'processing', 'review']);

/** The open conversation's active follow-up. The inbox feeds `apply` its realtime follow-up events (one connection). */
export function useConversationFollowup(conversationId: string | null, getToken: () => Promise<string | null>) {
  const [snapshot, setSnapshot] = useState<{ conversationId: string; followup: ConversationFollowupDto | null } | null>(null);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    void apiGetConversationFollowup(getToken, conversationId)
      .then(followup => { if (active) setSnapshot({ conversationId, followup }); })
      // Only a hint beside the composer: when it cannot load, the conversation simply shows no strip.
      .catch(() => { if (active) setSnapshot({ conversationId, followup: null }); });
    return () => { active = false; };
  }, [conversationId, getToken]);
  const apply = useCallback((followup: ConversationFollowupDto) => {
    if (followup.conversationId !== conversationRef.current) return;
    setSnapshot(current => {
      const known = current?.conversationId === followup.conversationId ? current.followup : null;
      if (known && known.id === followup.id && new Date(known.updatedAt).getTime() > new Date(followup.updatedAt).getTime()) return current;
      if (activeStatuses.has(followup.status)) return { conversationId: followup.conversationId, followup };
      // A finished follow-up only clears the strip when it is the one being shown.
      return known && known.id !== followup.id ? current : { conversationId: followup.conversationId, followup: null };
    });
  }, []);
  return { followup: snapshot && snapshot.conversationId === conversationId ? snapshot.followup : null, apply };
}

/** A discreet line above the composer: what the follow-up AI found pending in this conversation. */
export function ConversationFollowupStrip({ followup, getToken, onUseMessage, onUpdated }: {
  followup: ConversationFollowupDto | null;
  getToken: () => Promise<string | null>;
  onUseMessage: (body: string) => void;
  onUpdated: (followup: ConversationFollowupDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [followup?.id]);
  const pendingItem = followup?.analysis?.pendingItem?.trim();
  if (!followup || !followup.analysis || !pendingItem) return null;
  const isReminder = followup.kind === 'seller_reminder';
  if (isReminder ? followup.status !== 'review' : followup.status !== 'review' && followup.status !== 'scheduled') return null;
  const current = followup;

  async function run(action: () => Promise<ConversationFollowupDto>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { onUpdated(await action()); }
    catch (failure) {
      if (failure instanceof FollowupStaleError) onUpdated(failure.followup);
      else setError(failure instanceof Error ? failure.message : 'Não foi possível concluir a ação.');
    } finally { setBusy(false); }
  }
  const noFollowup = () => void run(() => apiMarkFollowupNoFollowup(getToken, current.id, current.updatedAt));

  return <div className={`assistant-composer-origin conversation-followup-strip${isReminder ? ' is-reminder' : ''}`}>
    {isReminder ? <BellRing size={14} aria-hidden="true" /> : <MessageCircleReply size={14} aria-hidden="true" />}
    <span className="conversation-followup-text">
      {isReminder ? <><strong>Lembrete:</strong> {pendingItem}</>
        : current.status === 'scheduled' ? <><strong>Follow-up:</strong> {pendingItem}. Sugestão pronta para {formatFollowupDate(current.scheduledAt)}</>
          : <><strong>Follow-up:</strong> {pendingItem}</>}
    </span>
    <span className="conversation-followup-actions">
      {isReminder ? <button type="button" disabled={busy} onClick={() => void run(() => apiMarkFollowupDone(getToken, current.id, current.updatedAt))}>
        <Check size={13} aria-hidden="true" />Já fiz</button> : null}
      {!isReminder && current.status === 'review' && current.draftBody?.trim() ? <button type="button" disabled={busy}
        onClick={() => onUseMessage(current.draftBody!)}>Usar mensagem</button> : null}
      {!isReminder ? <button type="button" disabled={busy} onClick={noFollowup}><X size={13} aria-hidden="true" />Não precisa</button> : null}
    </span>
    {error ? <span className="conversation-followup-error" role="alert">{error}</span> : null}
  </div>;
}
