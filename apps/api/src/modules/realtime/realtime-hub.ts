import { realtimeEventSchema } from "@prymeira-talk/shared";
import type { RealtimeEvent } from "@prymeira-talk/shared";

type WebSocketLike = {
  readyState: number;
  send: (payload: string) => void;
};

const OPEN = 1;

export function createRealtimeHub() {
  const clientsByWorkspace = new Map<string, Set<WebSocketLike>>();

  function removeClient(workspaceId: string, clients: Set<WebSocketLike>, client: WebSocketLike) {
    clients.delete(client);
    if (clients.size === 0 && clientsByWorkspace.get(workspaceId) === clients) {
      clientsByWorkspace.delete(workspaceId);
    }
  }

  return {
    addClient(workspaceId: string, client: WebSocketLike) {
      const clients = clientsByWorkspace.get(workspaceId) ?? new Set<WebSocketLike>();
      clients.add(client);
      clientsByWorkspace.set(workspaceId, clients);

      return () => {
        removeClient(workspaceId, clients, client);
      };
    },

    publish(event: RealtimeEvent) {
      const parsedEvent = realtimeEventSchema.parse(event);
      const clients = clientsByWorkspace.get(parsedEvent.workspaceId);
      if (!clients) return;

      const payload = JSON.stringify(parsedEvent);
      for (const client of clients) {
        if (client.readyState !== OPEN) {
          removeClient(parsedEvent.workspaceId, clients, client);
          continue;
        }

        try {
          client.send(payload);
        } catch {
          removeClient(parsedEvent.workspaceId, clients, client);
        }
      }
    },

    clientCount(workspaceId: string) {
      return clientsByWorkspace.get(workspaceId)?.size ?? 0;
    }
  };
}

export type RealtimeHub = ReturnType<typeof createRealtimeHub>;
