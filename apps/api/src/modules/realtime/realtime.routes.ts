import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createRealtimeHub } from "./realtime-hub.js";

declare module "fastify" {
  interface FastifyInstance {
    realtime: ReturnType<typeof createRealtimeHub>;
  }
}

const realtimeRoutesPlugin: FastifyPluginAsync = async (app) => {
  await app.register(websocket);

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
