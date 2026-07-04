import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createRealtimeHub } from "./realtime-hub.js";

const realtimeAuthProtocol = "prymeira-talk-auth";

declare module "fastify" {
  interface FastifyInstance {
    realtime: ReturnType<typeof createRealtimeHub>;
  }
}

const realtimeRoutesPlugin: FastifyPluginAsync = async (app) => {
  await app.register(websocket, {
    options: {
      handleProtocols: (protocols: Set<string>) => {
        return protocols.has(realtimeAuthProtocol) ? realtimeAuthProtocol : false;
      }
    }
  });

  const hub = createRealtimeHub();
  app.decorate("realtime", hub);

  app.get("/realtime", { websocket: true }, (socket, request) => {
    const removeClient = hub.addClient(request.talk.workspaceId, socket);
    socket.on("close", removeClient);
  });
};

export const realtimeRoutes = fp(realtimeRoutesPlugin, {
  name: "realtime-routes"
});
