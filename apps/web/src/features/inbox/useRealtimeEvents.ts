import { realtimeEventSchema, type RealtimeEvent } from "@prymeira-talk/shared";
import { useEffect } from "react";
import { buildRealtimeAuthProtocols, buildRealtimeUrl } from "../../app/api";

export function useRealtimeEvents(input: {
  token: string | null;
  onEvent: (event: RealtimeEvent) => void;
}) {
  const { token, onEvent } = input;

  useEffect(() => {
    let realtimeUrl: string;
    let realtimeProtocols: string[];

    try {
      realtimeUrl = buildRealtimeUrl();
      realtimeProtocols = buildRealtimeAuthProtocols(token);
    } catch {
      return;
    }

    const socket = new WebSocket(realtimeUrl, realtimeProtocols);
    socket.onmessage = (message) => {
      const event = realtimeEventSchema.parse(JSON.parse(message.data));
      onEvent(event);
    };

    return () => {
      socket.close();
    };
  }, [token, onEvent]);
}
