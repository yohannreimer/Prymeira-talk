import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import { createRealtimeHub } from "./realtime-hub.js";

declare module "fastify" {
  interface FastifyInstance {
    realtime: ReturnType<typeof createRealtimeHub>;
  }
}

export const realtimeRoutes: FastifyPluginAsync = async (app) => {
  await app.register(websocket);

  const hub = createRealtimeHub();
  app.decorate("realtime", hub);

  app.get("/realtime", { websocket: true }, (socket, request) => {
    const removeClient = hub.addClient(request.talk.workspaceId, socket);
    socket.on("close", removeClient);
  });
};
