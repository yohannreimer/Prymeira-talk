import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantConversationDto } from '@prymeira-talk/shared';
import { apiGetAssistantConversation, apiRequestAssistantSuggestion } from '../../app/api';

export function useAssistantConversation(conversationId: string | null, getToken: () => Promise<string | null>) {
  const [snapshot, setSnapshot] = useState<{ conversationId: string; data: AssistantConversationDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const active = useRef(conversationId); active.current = conversationId;
  const refresh = useCallback(() => setRefreshKey(n => n + 1), []);
  useEffect(() => {
    if (!conversationId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let busy = false;
    setError(null);
    async function poll() {
      if (disposed || busy || document.hidden) return;
      busy = true; controller = new AbortController();
      let delay = 5000;
      try {
        const data = await apiGetAssistantConversation(conversationId!, getToken, controller.signal);
        if (!disposed) { setSnapshot({ conversationId: conversationId!, data }); setError(null); }
        if (data.status === 'pending' || data.status === 'generating') delay = 2000;
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : 'Não foi possível carregar a IA de apoio.');
        delay = 15000;
      } finally { busy = false; if (!disposed) timer = setTimeout(() => void poll(), delay); }
    }
    function visibility() { clearTimeout(timer); if (document.hidden) controller?.abort(); else void poll(); }
    void poll(); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [conversationId, getToken, refreshKey]);
  const request = useCallback(async (instruction?: string) => {
    if (!conversationId) return;
    await apiRequestAssistantSuggestion(conversationId, instruction, getToken);
    if (active.current === conversationId) {
      setSnapshot(current => current?.conversationId === conversationId ? { ...current, data: { ...current.data, status: 'pending' } } : current);
      refresh();
    }
  }, [conversationId, getToken, refresh]);
  return { data: snapshot?.conversationId === conversationId ? snapshot.data : null, error, refresh, request };
}
