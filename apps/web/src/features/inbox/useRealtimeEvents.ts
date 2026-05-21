import { realtimeEventSchema, type RealtimeEvent } from "@prymeira-talk/shared";
import { useEffect } from "react";
import { buildRealtimeUrl } from "../../app/api";

export function useRealtimeEvents(input: {
  token: string | null;
  onEvent: (event: RealtimeEvent) => void;
}) {
  const { token, onEvent } = input;

  useEffect(() => {
    let realtimeUrl: string;

    try {
      realtimeUrl = buildRealtimeUrl(token);
    } catch {
      return;
    }

    const socket = new WebSocket(realtimeUrl);
    socket.onmessage = (message) => {
      const event = realtimeEventSchema.parse(JSON.parse(message.data));
      onEvent(event);
    };

    return () => {
      socket.close();
    };
  }, [token, onEvent]);
}
