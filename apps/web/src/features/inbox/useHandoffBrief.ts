import { useCallback, useEffect, useState } from "react";
import type { HandoffBriefDto } from "../../../../../packages/shared/src/assistant";
import { apiGetHandoffBrief } from "../../app/api";

export function useHandoffBrief(
  conversationId: string | null,
  enabled: boolean,
  lastMessageAt: string | null | undefined,
  getToken: () => Promise<string | null>
): { data: HandoffBriefDto | null; error: string | null; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<{ conversationId: string; lastMessageAt: string | null | undefined; data: HandoffBriefDto } | null>(null);
  const [failure, setFailure] = useState<{ conversationId: string; message: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(key => key + 1), []);
  useEffect(() => {
    if (!conversationId || !enabled) return;
    let disposed = false;
    let failed = false;
    setFailure(null);
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    async function poll() {
      if (disposed || failed || document.hidden) return;
      clearTimeout(timer);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      let delay = 5_000;
      try {
        const data = await apiGetHandoffBrief(conversationId!, getToken, current.signal);
        if (!disposed) { setSnapshot({ conversationId: conversationId!, lastMessageAt, data }); setFailure(null); }
        if (data.status === "pending" || data.status === "stale") delay = 2_000;
      } catch (error) {
        if (!disposed && !current.signal.aborted) {
          failed = true;
          setFailure({ conversationId: conversationId!, message: error instanceof Error ? error.message : "Apoio indisponível." });
        }
      } finally {
        if (!disposed && !failed && controller === current) timer = setTimeout(() => void poll(), delay);
      }
    }
    function visibility() { clearTimeout(timer); if (document.hidden) controller?.abort(); else void poll(); }
    void poll();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [conversationId, enabled, lastMessageAt, getToken, refreshKey]);
  return {
    data: enabled && snapshot?.conversationId === conversationId
      ? snapshot.lastMessageAt === lastMessageAt ? snapshot.data : { ...snapshot.data, status: "stale" }
      : null,
    error: enabled && failure?.conversationId === conversationId ? failure.message : null,
    refresh
  };
}
