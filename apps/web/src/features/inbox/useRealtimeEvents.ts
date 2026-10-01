import type { RealtimeEvent } from '@prymeira-talk/shared';
import { useEffect, useRef, useState } from 'react';
import { useOptionalTalkSession } from '../../app/session/TalkSessionProvider';
import { RealtimeConnection } from './realtime-connection';

/** Session-owned in the suite; standalone consumers keep the existing API. */
export function useRealtimeEvents({ token, onEvent }: { token: string | null; onEvent: (event: RealtimeEvent) => void }) {
  const context = useOptionalTalkSession();
  const callback = useRef(onEvent); callback.current = onEvent;
  const [standalone] = useState(() => new RealtimeConnection());
  const connection = context?.realtime ?? standalone;
  useEffect(() => connection.subscribe(event => callback.current(event)), [connection]);
  useEffect(() => {
    if (context) return;
    connection.updateToken(token);
    return () => connection.stop();
  }, [connection, context, token]);
}
