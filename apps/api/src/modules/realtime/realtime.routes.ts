import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createRealtimeHub } from "./realtime-hub.js";
import { createRealtimeBridge } from "./realtime-bridge.js";

const realtimeAuthProtocol = "prymeira-talk-auth";

declare module "fastify" {
  interface FastifyInstance {
    realtime: ReturnType<typeof createRealtimeHub>;
  }
}

interface RealtimeRoutesOptions {
  /** Opt-in: fan events out to other API processes through PostgreSQL LISTEN/NOTIFY. */
  bridgeDatabaseUrl?: string;
}

const realtimeRoutesPlugin: FastifyPluginAsync<RealtimeRoutesOptions> = async (app, options) => {
  await app.register(websocket, {
    options: {
      handleProtocols: (protocols: Set<string>) => {
        return protocols.has(realtimeAuthProtocol) ? realtimeAuthProtocol : false;
      }
    }
  });

  const hub = createRealtimeHub();
  if (options.bridgeDatabaseUrl) {
    const bridge = createRealtimeBridge({ databaseUrl: options.bridgeDatabaseUrl, hub, logger: app.log });
    await bridge.start();
    app.addHook("onClose", async () => { await bridge.stop(); });
    app.decorate("realtime", bridge);
  } else {
    app.decorate("realtime", hub);
  }

  app.get("/realtime", { websocket: true }, (socket, request) => {
    const removeClient = hub.addClient(request.talk.workspaceId, socket);
    socket.on("close", removeClient);
  });
};

export const realtimeRoutes = fp(realtimeRoutesPlugin, {
  name: "realtime-routes"
});
