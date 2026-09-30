import { useCallback, useEffect, useRef, useState } from "react";
import type { SupervisionConversation, SupervisionSummary, SupervisionThread } from "@prymeira-talk/shared";
import {
  apiSupervisionConversations, apiSupervisionSummary, apiSupervisionThread,
  SupervisionApiError, type SupervisionFilter
} from "../../app/supervision-api";

export const defaultSupervisionFilters: SupervisionFilter = { status: "active", nextAction: true, unread: false, unreadPeriod: "24h" };
export const conversationKey = (conversation: SupervisionConversation) => `${conversation.workspaceId}:${conversation.id}`;

export function useSupervision(getToken: () => Promise<string | null>) {
  const [filters, setFilters] = useState<SupervisionFilter>(defaultSupervisionFilters);
  const [summary, setSummary] = useState<SupervisionSummary | null>(null);
  const [conversations, setConversations] = useState<SupervisionConversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<SupervisionConversation | null>(null);
  const [thread, setThread] = useState<SupervisionThread | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const knownSellers = useRef<Set<string> | null>(null);
  const loadedPages = useRef(1);
  const blocked = useRef(false);
  const requests = useRef<{ queue?: AbortController; thread?: AbortController; page?: AbortController }>({});

  const clearSelection = useCallback(() => {
    requests.current.thread?.abort(); requests.current.thread = undefined;
    selectedRef.current = null;
    setSelected(null); setThread(null); setThreadError(null); setThreadLoading(false);
  }, []);

  const handleAccessError = useCallback((error: unknown) => {
    if (!(error instanceof SupervisionApiError)) return false;
    if (error.status === 401 || error.status === 403) {
      blocked.current = true;
      Object.values(requests.current).forEach(request => request?.abort());
      requests.current = {};
      knownSellers.current = null;
      setSummary(null); setConversations([]); setNextCursor(null); clearSelection();
      setQueueError(null); setUpdatedAt(null); setLoading(false); setLoadingMore(false);
      setDenied(error.status === 401
        ? "Sua sessão expirou. Entre novamente pelo Hub para consultar a supervisão."
        : "Você não tem acesso à supervisão destas contas. Consulte o responsável pelo acesso no Hub.");
      return true;
    }
    if (error.status === 404) {
      clearSelection();
      setThreadError("Esta conversa não está mais disponível para supervisão.");
      return true;
    }
    return false;
  }, [clearSelection]);

  const refreshQueue = useCallback(async (replace = false) => {
    if (blocked.current || (!replace && (requests.current.queue || requests.current.page))) return;
    requests.current.queue?.abort(); requests.current.page?.abort(); requests.current.page = undefined;
    setLoadingMore(false);
    const abort = new AbortController(); requests.current.queue = abort;
    const currentFilters = filtersRef.current;
    setLoading(true); setQueueError(null);
    let allowed: Set<string> | null = null;
    let scopedDenial = false;
    const applySummary = (data: SupervisionSummary) => {
      if (abort.signal.aborted || blocked.current) return;
      allowed = new Set(data.sellers.map(seller => seller.sellerCustomerId));
      knownSellers.current = allowed;
      setSummary(data);
      setConversations(previous => previous.filter(conversation => allowed!.has(conversation.sellerCustomerId)));
      const selectedSeller = selectedRef.current?.sellerCustomerId;
      if (selectedSeller && !allowed.has(selectedSeller)) clearSelection();
      if (currentFilters.sellerCustomerId && !allowed.has(currentFilters.sellerCustomerId)) {
        abort.abort(); setConversations([]); setNextCursor(null);
        filtersRef.current = { ...currentFilters, sellerCustomerId: undefined };
        loadedPages.current = 1;
        setFilters(filtersRef.current);
      }
    };
    const summaryJob = apiSupervisionSummary(() => tokenRef.current(), abort.signal, currentFilters.unreadPeriod).then(data => {
      // A scoped denial invalidates a summary authorized before that denial.
      // Only the subsequent revalidation may repopulate seller counts.
      if (!scopedDenial) applySummary(data);
    });
    const listJob = (async () => {
      const depth = loadedPages.current;
      let data = await apiSupervisionConversations(currentFilters, () => tokenRef.current(), abort.signal);
      const records = [...data.conversations];
      for (let page = 1; page < depth && data.nextCursor; page++) {
        abort.signal.throwIfAborted();
        data = await apiSupervisionConversations(currentFilters, () => tokenRef.current(), abort.signal, data.nextCursor);
        abort.signal.throwIfAborted();
        records.push(...data.conversations);
      }
      return { conversations: records, nextCursor: data.nextCursor };
    })().then(data => {
      if (abort.signal.aborted || blocked.current) return;
      const scope = allowed ?? knownSellers.current;
      const seen = new Set<string>();
      setConversations(data.conversations.filter(conversation => {
        const key = conversationKey(conversation);
        if (seen.has(key) || (scope && !scope.has(conversation.sellerCustomerId))) return false;
        seen.add(key); return true;
      }));
      setNextCursor(data.nextCursor);
    });
    const guard = (job: Promise<unknown>, scopedSeller?: string) => job.catch(async error => {
      if (abort.signal.aborted || blocked.current) return;
      if (scopedSeller && error instanceof SupervisionApiError && error.status === 403) {
        scopedDenial = true;
        // A seller filter may have lost its grant while other sellers remain
        // authorized. Remove cached data immediately, then let a live summary
        // distinguish that scope change from a denied session or all grants.
        clearSelection(); setConversations([]); setNextCursor(null); setSummary(null); setUpdatedAt(null);
        try {
          await summaryJob;
          if (abort.signal.aborted || blocked.current) return;
          // The parallel summary may have preceded the grant change. Recheck
          // after the scoped denial before choosing the remaining accounts.
          applySummary(await apiSupervisionSummary(() => tokenRef.current(), abort.signal, currentFilters.unreadPeriod));
          if (abort.signal.aborted || blocked.current) return;
          abort.abort();
          filtersRef.current = { ...currentFilters, sellerCustomerId: undefined };
          loadedPages.current = 1;
          setFilters(filtersRef.current);
        } catch (summaryError) {
          if (!abort.signal.aborted && !blocked.current && !handleAccessError(summaryError)) {
            setQueueError("Não foi possível verificar os vendedores autorizados. Tente novamente.");
          }
        }
        return;
      }
      if (!handleAccessError(error)) setQueueError("Não foi possível atualizar a supervisão. Tente novamente.");
      else if (error instanceof SupervisionApiError && error.status === 404) {
        setConversations([]); setNextCursor(null);
        setQueueError("Esta conta não está mais disponível para supervisão. Atualize para consultar os acessos atuais.");
      }
      throw error;
    });
    const result = await Promise.allSettled([guard(summaryJob), guard(listJob, currentFilters.sellerCustomerId)]);
    if (!abort.signal.aborted && !blocked.current && !scopedDenial && result.every(item => item.status === "fulfilled")) setUpdatedAt(new Date());
    if (requests.current.queue === abort) { requests.current.queue = undefined; setLoading(false); }
  }, [clearSelection, handleAccessError]);

  const refreshThread = useCallback(async (replace = false) => {
    const current = selectedRef.current;
    if (blocked.current || !current || (!replace && requests.current.thread)) return;
    requests.current.thread?.abort();
    const abort = new AbortController(); requests.current.thread = abort;
    setThreadLoading(true); setThreadError(null);
    try {
      const data = await apiSupervisionThread(current.workspaceId, current.id, () => tokenRef.current(), abort.signal);
      if (!abort.signal.aborted && !blocked.current && selectedRef.current && conversationKey(selectedRef.current) === conversationKey(current)) {
        setThread(data);
      }
    } catch (error) {
      if (!abort.signal.aborted && !blocked.current && !handleAccessError(error)) setThreadError("Não foi possível atualizar o histórico. Tente novamente.");
    } finally {
      if (requests.current.thread === abort) { requests.current.thread = undefined; setThreadLoading(false); }
    }
  }, [handleAccessError]);

  const selectConversation = useCallback((conversation: SupervisionConversation | null) => {
    clearSelection();
    selectedRef.current = conversation;
    setSelected(conversation);
  }, [clearSelection]);

  const changeFilters = useCallback((next: SupervisionFilter) => {
    requests.current.queue?.abort(); requests.current.page?.abort();
    if (next.sellerCustomerId !== filtersRef.current.sellerCustomerId) clearSelection();
    if (next.unreadPeriod !== filtersRef.current.unreadPeriod) { setSummary(null); setUpdatedAt(null); }
    filtersRef.current = next;
    loadedPages.current = 1;
    setConversations([]); setNextCursor(null); setFilters(next);
  }, [clearSelection]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || blocked.current || requests.current.page || requests.current.queue) return;
    const abort = new AbortController(); requests.current.page = abort;
    const currentFilters = filtersRef.current;
    setLoadingMore(true); setQueueError(null);
    try {
      const data = await apiSupervisionConversations(currentFilters, () => tokenRef.current(), abort.signal, nextCursor);
      if (abort.signal.aborted || blocked.current) return;
      loadedPages.current += 1;
      setConversations(previous => {
        const seen = new Set(previous.map(conversationKey));
        return [...previous, ...data.conversations.filter(conversation => {
          const key = conversationKey(conversation);
          if (seen.has(key) || (knownSellers.current && !knownSellers.current.has(conversation.sellerCustomerId))) return false;
          seen.add(key); return true;
        })];
      });
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (abort.signal.aborted || blocked.current) return;
      if (currentFilters.sellerCustomerId && error instanceof SupervisionApiError && error.status === 403) {
        clearSelection(); setConversations([]); setNextCursor(null); setSummary(null); setUpdatedAt(null);
        try {
          const data = await apiSupervisionSummary(() => tokenRef.current(), abort.signal, currentFilters.unreadPeriod);
          if (abort.signal.aborted || blocked.current) return;
          knownSellers.current = new Set(data.sellers.map(seller => seller.sellerCustomerId));
          setSummary(data);
          filtersRef.current = { ...currentFilters, sellerCustomerId: undefined };
          loadedPages.current = 1;
          setFilters(filtersRef.current);
        } catch (summaryError) {
          if (!abort.signal.aborted && !blocked.current && !handleAccessError(summaryError)) {
            setQueueError("Não foi possível verificar os vendedores autorizados. Tente novamente.");
          }
        }
      } else if (!handleAccessError(error)) setQueueError("Não foi possível carregar mais conversas. Tente novamente.");
    } finally {
      if (requests.current.page === abort) { requests.current.page = undefined; setLoadingMore(false); }
    }
  }, [nextCursor, handleAccessError, clearSelection]);

  const refresh = useCallback(() => {
    // Retry explicitly checks the server again after a denied session.
    blocked.current = false; setDenied(null);
    void refreshQueue(true); void refreshThread(true);
  }, [refreshQueue, refreshThread]);

  useEffect(() => { void refreshQueue(true); }, [filters, refreshQueue]);
  const selectedKey = selected ? conversationKey(selected) : null;
  useEffect(() => {
    void refreshThread(true);
    return () => { requests.current.thread?.abort(); requests.current.thread = undefined; };
  }, [selectedKey, refreshThread]);
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== "visible" || blocked.current) return;
      void refreshQueue(); void refreshThread();
    };
    const visibility = () => {
      if (document.visibilityState === "visible") poll();
      else {
        Object.values(requests.current).forEach(request => request?.abort()); requests.current = {};
        setLoading(false); setThreadLoading(false); setLoadingMore(false);
      }
    };
    const interval = window.setInterval(poll, 15_000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(interval); document.removeEventListener("visibilitychange", visibility);
      Object.values(requests.current).forEach(request => request?.abort()); requests.current = {};
    };
  }, [refreshQueue, refreshThread]);

  return { filters, changeFilters, summary, conversations, nextCursor, selected, selectConversation, thread,
    denied, queueError, threadError, loading, threadLoading, loadingMore, updatedAt, refresh, loadMore, handleAccessError };
}
