import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createJevInboxTriage, createLunaInboxTriage } from "../src/modules/conversations/inbox-triage-model.js";

config({ path: resolve(import.meta.dirname, "../../../.env") });

const messageSchema = z.object({
  id: z.string().min(1),
  direction: z.enum(["inbound", "outbound"]),
  author: z.enum(["cliente", "empresa_humano", "empresa_ia"]),
  type: z.string(), body: z.string().nullable(), createdAt: z.string(),
  caption: z.string().nullable().optional(), transcript: z.string().nullable().optional()
});
const caseSchema = z.object({
  caseId: z.string().min(1), workspaceId: z.string().min(1),
  anchorMessageId: z.string().min(1),
  expected: z.enum(["needs_reply", "no_reply", "uncertain"]),
  messages: z.array(messageSchema).min(1)
});

type Result = { caseId: string; expected: string; decision: string; latencyMs: number };

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const file = process.env.INBOX_TRIAGE_EVAL_FILE;
  if (!file) throw new Error("INBOX_TRIAGE_EVAL_FILE is required");
  const raw = await readFile(resolve(file), "utf8");
  const cases = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return caseSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Invalid evaluation case at line ${index + 1}`); }
  });
  if (cases.length < 50) throw new Error("At least 50 human-labeled cases are required");
  if (!process.env.JEV_API_KEY) throw new Error("JEV_API_KEY is required for comparison");
  const prisma = new PrismaClient();
  const adapters = {
    luna: createLunaInboxTriage({ prisma }),
    jev: createJevInboxTriage({ apiKey: process.env.JEV_API_KEY, model: process.env.JEV_MODEL })
  };
  try {
    for (const [name, adapter] of Object.entries(adapters)) {
      const results: Result[] = [];
      for (const item of cases) {
        const started = performance.now();
        let decision: string;
        try {
          decision = (await adapter.assess(item)).decision;
        } catch {
          decision = "error";
        }
        results.push({ caseId: item.caseId, expected: item.expected, decision, latencyMs: Math.round(performance.now() - started) });
      }
      const missedRequests = results.filter((item) => item.expected === "needs_reply" && item.decision === "no_reply");
      const falseAlerts = results.filter((item) => item.expected === "no_reply" && item.decision === "needs_reply");
      const uncertain = results.filter((item) => item.decision === "uncertain" || item.decision === "error");
      console.log(JSON.stringify({
        model: name, total: results.length,
        missedRequests: missedRequests.map((item) => item.caseId),
        falseAlerts: falseAlerts.map((item) => item.caseId),
        uncertainOrError: uncertain.map((item) => item.caseId),
        latencyMs: { p50: percentile(results.map((item) => item.latencyMs), 0.5), p95: percentile(results.map((item) => item.latencyMs), 0.95) }
      }));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
});
