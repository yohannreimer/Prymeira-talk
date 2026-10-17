import { useEffect, useState } from "react";
import { apiListFollowups } from "../../app/api";
import { useOptionalTalkSession } from "../../app/session/TalkSessionProvider";

const FALLBACK_REFRESH_MS = 120_000;

/**
 * How many follow-up drafts wait for a seller to send, edit or cancel. Seller reminders are left out
 * for now. Refreshed when a follow-up changes, with a slow timer in case an event is missed.
 */
export function useFollowupReviewCount(): number {
  const context = useOptionalTalkSession();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!context) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      void apiListFollowups(context.getToken, "review")
        .then((followups) => { if (active) setCount(followups.length); })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = context.realtime.subscribe((event) => {
      if (event.type !== "conversation_followup.updated") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
    const interval = setInterval(load, FALLBACK_REFRESH_MS);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(interval);
      if (timer) clearTimeout(timer);
    };
  }, [context]);

  return count;
}
