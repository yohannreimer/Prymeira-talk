import { PrismaClient } from "@prisma/client";
import { createDemoScenarioService } from "../src/modules/demo/demo-scenario.js";

const prisma = new PrismaClient();
const workspaceId = process.env.PRYMEIRA_LOCAL_WORKSPACE_ID ?? "local_workspace";

createDemoScenarioService(prisma)
  .reset(workspaceId)
  .then((result) => {
    console.log(`Seeded ${result.conversations} demo conversations for ${workspaceId}.`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
