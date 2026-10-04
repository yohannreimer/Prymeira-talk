import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AssistantConversationDto } from '@prymeira-talk/shared';
import { apiGetAssistantConversation, apiRequestAssistantSuggestion } from '../../app/api';
import { useTalkSession } from '../../app/session/TalkSessionProvider';

/** This GET can process server work. Only the selected conversation's existing
 * polling/visibility/context triggers may invoke it; never prefetch or retry it. */
export function useAssistantConversation(conversationId: string | null, getToken: () => Promise<string | null>, contextTrigger = '') {
  const { session } = useTalkSession();
  const key = session.key('assistant', conversationId);
  const query = useQuery({ queryKey: key, enabled: Boolean(conversationId),
    queryFn: ({ signal }) => apiGetAssistantConversation(conversationId!, getToken, signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchInterval: query => query.state.error ? false
      : query.state.data?.status === 'pending' || query.state.data?.status === 'generating' ? 2_000 : 5_000,
    refetchIntervalInBackground: false
  });
  const active = useRef(conversationId); active.current = conversationId;
  const refetch = query.refetch;
  const refresh = useCallback(() => { void refetch({ cancelRefetch: false }); }, [refetch]);
  const previousTrigger = useRef({ conversationId, contextTrigger });
  useEffect(() => {
    const previous = previousTrigger.current;
    previousTrigger.current = { conversationId, contextTrigger };
    if (conversationId && previous.conversationId === conversationId && previous.contextTrigger !== contextTrigger) refresh();
  }, [conversationId, contextTrigger, refresh]);
  useEffect(() => {
    const visibility = () => { if (conversationId && !document.hidden) refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [conversationId, refresh]);
  const request = useCallback(async (instruction?: string) => {
    if (!conversationId) return;
    await apiRequestAssistantSuggestion(conversationId, instruction, getToken);
    if (session.isLive && active.current === conversationId) {
      session.client.setQueryData<AssistantConversationDto>(session.key('assistant', conversationId), current => current ? { ...current, status: 'pending' } : current);
      refresh();
    }
  }, [conversationId, getToken, session, refresh]);
  return { data: query.data ?? null, error: query.error?.message ?? null, loading: Boolean(conversationId) && query.isPending && !query.error, refresh, request };
}
