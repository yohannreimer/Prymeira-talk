import { PrismaClient } from "@prisma/client";
import fp from "fastify-plugin";
import { measureInboxDatabase } from "./inbox-timing.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface PrismaPluginOptions {
  databaseUrl: string;
}

export const prismaPlugin = fp<PrismaPluginOptions>(async (app, options) => {
  const client = new PrismaClient({
    datasources: {
      db: {
        url: options.databaseUrl
      }
    }
  });

  const prisma = client.$extends({
    query: {
      $allModels: {
        $allOperations({ args, query }) { return measureInboxDatabase(() => query(args)); }
      }
    }
  });
  app.decorate("prisma", prisma as unknown as PrismaClient);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
