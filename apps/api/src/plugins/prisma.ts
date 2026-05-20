import { PrismaClient } from "@prisma/client";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async (app) => {
  const prisma = new PrismaClient();
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
