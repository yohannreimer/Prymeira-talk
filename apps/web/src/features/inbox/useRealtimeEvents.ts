import { realtimeEventSchema, type RealtimeEvent } from "@prymeira-talk/shared";
import { useEffect } from "react";
import { buildRealtimeUrl } from "../../app/api";

export function useRealtimeEvents(input: {
  token: string | null;
  onEvent: (event: RealtimeEvent) => void;
}) {
  const { token, onEvent } = input;

  useEffect(() => {
    if (!token) return;

    const socket = new WebSocket(buildRealtimeUrl(token));
    socket.onmessage = (message) => {
      const event = realtimeEventSchema.parse(JSON.parse(message.data));
      onEvent(event);
    };

    return () => {
      socket.close();
    };
  }, [token, onEvent]);
}
