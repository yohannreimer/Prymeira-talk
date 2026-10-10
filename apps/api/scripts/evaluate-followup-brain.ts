import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { buildConversationContext } from "../src/modules/agents/conversation-context-builder.js";
import {
  createFollowupBrain,
  followupBrainSituationSchema,
  type FollowupBrainAnalysis
} from "../src/modules/followups/followup-brain.js";

config({ path: resolve(import.meta.dirname, "../../../.env") });

// Read-only. Two modes:
// - FOLLOWUP_BRAIN_EVAL_FILE=cases.jsonl: score the brain against human-labeled cases
//   (FOLLOWUP_BRAIN_WORKSPACE_ID supplies the AI provider for cases without one).
// - FOLLOWUP_BRAIN_SAMPLE_WORKSPACE_ID=<id>: analyze recent quiet conversations and print
//   one JSON line per conversation, for a person to label or review. Nothing is written.

const caseSchema = z.object({
  caseId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  expected: followupBrainSituationSchema,
  messages: z.array(z.object({
    label: z.enum(["cliente", "atendente"]),
    body: z.string().nullable(),
    type: z.string().default("text"),
    createdAt: z.string()
  })).min(1)
});

async function main() {
  const prisma = new PrismaClient();
  const brain = createFollowupBrain({ prisma });
  try {
    const file = process.env.FOLLOWUP_BRAIN_EVAL_FILE;
    if (file) return await scoreCases(brain, file);
    const workspaceId = process.env.FOLLOWUP_BRAIN_SAMPLE_WORKSPACE_ID;
    if (workspaceId) return await sampleConversations(prisma, brain, workspaceId);
    throw new Error("Set FOLLOWUP_BRAIN_EVAL_FILE or FOLLOWUP_BRAIN_SAMPLE_WORKSPACE_ID");
  } finally {
    await prisma.$disconnect();
  }
}

async function scoreCases(brain: ReturnType<typeof createFollowupBrain>, file: string) {
  const raw = await readFile(resolve(file), "utf8");
  const cases = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return caseSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Invalid evaluation case at line ${index + 1}`); }
  });
  const results: Array<{ caseId: string; expected: string; got: string; analysis: FollowupBrainAnalysis | null }> = [];
  for (const item of cases) {
    try {
      const analysis = await brain.analyze({
        workspaceId: item.workspaceId ?? requiredWorkspace(),
        conversationMessages: item.messages.map((message, index) => ({
          id: `${item.caseId}-${index}`,
          direction: message.label === "cliente" ? "inbound" : "outbound",
          ...message
        })),
        previousAttempts: [],
        now: new Date()
      });
      results.push({ caseId: item.caseId, expected: item.expected, got: analysis.situation, analysis });
    } catch (error) {
      results.push({ caseId: item.caseId, expected: item.expected, got: `error: ${errorMessage(error)}`, analysis: null });
    }
    console.error(JSON.stringify({ completed: results.length, total: cases.length }));
  }
  const correct = results.filter((result) => result.expected === result.got);
  console.log(JSON.stringify({
    total: results.length,
    accuracy: results.length ? correct.length / results.length : 0,
    followupOnClosed: results.filter((result) => result.expected === "closed" && result.got === "waiting_customer").map((result) => result.caseId),
    missedWaitingCustomer: results.filter((result) => result.expected === "waiting_customer" && result.got !== "waiting_customer").map((result) => result.caseId),
    mismatches: results.filter((result) => result.expected !== result.got)
  }, null, 2));
}

async function sampleConversations(
  prisma: PrismaClient,
  brain: ReturnType<typeof createFollowupBrain>,
  workspaceId: string
) {
  const limit = Number(process.env.FOLLOWUP_BRAIN_SAMPLE_SIZE ?? 20);
  const quietSince = new Date(Date.now() - 5 * 60_000);
  const conversations = await prisma.conversation.findMany({
    where: { workspaceId, status: { not: "closed" }, lastMessageAt: { lte: quietSince }, contact: { isGroup: false } },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    include: { contact: { select: { name: true } } }
  });
  for (const conversation of conversations) {
    try {
      const context = await buildConversationContext(prisma as unknown as Parameters<typeof buildConversationContext>[0], {
        workspaceId, conversationId: conversation.id, limit: 40
      });
      const analysis = await brain.analyze({
        workspaceId,
        conversationMessages: context.messages,
        previousAttempts: [],
        contactName: conversation.contact?.name ?? null,
        now: new Date()
      });
      const lastMessages = context.messages
        .filter((message) => message.label === "cliente" || message.label === "atendente")
        .slice(-4)
        .map((message) => `${message.label}: ${message.body ?? `[${message.type}]`}`);
      console.log(JSON.stringify({ conversationId: conversation.id, contact: conversation.contact?.name ?? null, lastMessages, analysis }));
    } catch (error) {
      console.log(JSON.stringify({ conversationId: conversation.id, error: errorMessage(error) }));
    }
  }
}

function requiredWorkspace() {
  const workspaceId = process.env.FOLLOWUP_BRAIN_WORKSPACE_ID;
  if (!workspaceId) throw new Error("FOLLOWUP_BRAIN_WORKSPACE_ID is required for cases without workspaceId");
  return workspaceId;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
