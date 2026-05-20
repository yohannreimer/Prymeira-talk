import { PrismaClient } from "@prisma/client";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface PrismaPluginOptions {
  databaseUrl: string;
}

export const prismaPlugin = fp<PrismaPluginOptions>(async (app, options) => {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: options.databaseUrl
      }
    }
  });

  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
