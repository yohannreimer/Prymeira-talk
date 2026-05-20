import type { RealtimeEvent } from "@prymeira-talk/shared";

type WebSocketLike = {
  readyState: number;
  send: (payload: string) => void;
};

const OPEN = 1;

export function createRealtimeHub() {
  const clientsByWorkspace = new Map<string, Set<WebSocketLike>>();

  return {
    addClient(workspaceId: string, client: WebSocketLike) {
      const clients = clientsByWorkspace.get(workspaceId) ?? new Set<WebSocketLike>();
      clients.add(client);
      clientsByWorkspace.set(workspaceId, clients);

      return () => {
        clients.delete(client);
        if (clients.size === 0) {
          clientsByWorkspace.delete(workspaceId);
        }
      };
    },

    publish(event: RealtimeEvent) {
      const clients = clientsByWorkspace.get(event.workspaceId);
      if (!clients) return;

      const payload = JSON.stringify(event);
      for (const client of clients) {
        if (client.readyState === OPEN) {
          client.send(payload);
        }
      }
    }
  };
}

export type RealtimeHub = ReturnType<typeof createRealtimeHub>;
