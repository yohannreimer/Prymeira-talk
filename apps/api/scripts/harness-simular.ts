import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveOpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";
import { cenarios } from "../src/modules/harness/agentes/comprador/cenarios.js";
import { comprador } from "../src/modules/harness/agentes/comprador/index.js";
import { createFakeComprador } from "../src/modules/harness/agentes/comprador/modelos-falsos.js";
import { createJevClient } from "../src/modules/harness/core/jev.js";
import { createOpenAiCompatibleModel, type ModelClient } from "../src/modules/harness/core/model.js";
import { createJevJudge } from "../src/modules/harness/core/review.js";
import type { RunnerDeps } from "../src/modules/harness/core/runner.js";
import { createTriage } from "../src/modules/harness/core/triage.js";
import { renderReport, runSuite } from "../src/modules/harness/simulador/simulador.js";

config({ path: resolve(import.meta.dirname, "../../../.env") });

// Runs the buyer agent against the supplier scenarios and prints the scorecard (pass^k).
// Nothing is sent to WhatsApp and nothing is written to the database.
//
// Model (pick one):
//   HARNESS_WORKSPACE_ID=<id>            uses that workspace's AI provider (the same Luna the Talk uses)
//   HARNESS_BASE_URL + HARNESS_API_KEY   any OpenAI-compatible endpoint
//   HARNESS_OFFLINE=1                    deterministic fake models (only scenarios that don't need a model)
// Options:
//   HARNESS_MODEL (default: the workspace's model, else gpt-6-luna) · HARNESS_MODE=tools|json (default tools)
//   HARNESS_REASONING=none|low|medium|high · FORNECEDOR_MODEL (plays the LLM suppliers; default HARNESS_MODEL)
//   HARNESS_K (default 4) · HARNESS_CENARIOS=id1,id2 · HARNESS_RELATORIO=path.md
//   JEV_API_KEY: JEV does the triage and judges each message (fails closed when JEV is down)

async function main() {
  const k = Number(process.env.HARNESS_K ?? 4);
  const wanted = (process.env.HARNESS_CENARIOS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const offline = process.env.HARNESS_OFFLINE === "1";
  let scenarios = cenarios.filter((scenario) => !wanted.length || wanted.includes(scenario.id));
  if (offline) scenarios = scenarios.filter((scenario) => !scenario.exigeModelo);

  const jev = process.env.JEV_API_KEY ? createJevClient({ apiKey: process.env.JEV_API_KEY, model: process.env.JEV_MODEL }) : undefined;
  let deps: () => RunnerDeps;
  let fornecedor: ModelClient | undefined;

  if (offline) {
    deps = () => {
      const fake = createFakeComprador();
      return { model: fake.escritor, leitor: fake.leitor, triage: createTriage() };
    };
  } else {
    const endpoint = await resolveEndpoint();
    const model = createOpenAiCompatibleModel({
      ...endpoint,
      mode: process.env.HARNESS_MODE === "json" ? "json" : "tools",
      reasoningEffort: readReasoning()
    });
    fornecedor = createOpenAiCompatibleModel({ ...endpoint, model: process.env.FORNECEDOR_MODEL ?? endpoint.model, mode: "tools", temperature: 0.8 });
    deps = () => ({ model, triage: createTriage({ jev }), ...(jev ? { judge: createJevJudge(jev), judgeFailClosed: true } : {}) });
  }

  const report = await runSuite({
    agent: comprador,
    deps,
    scenarios,
    k,
    fornecedorModel: fornecedor,
    onProgress: (line) => console.error(line)
  });
  const markdown = renderReport(report);
  if (process.env.HARNESS_RELATORIO) {
    await writeFile(resolve(process.env.HARNESS_RELATORIO), markdown);
    console.error(`Relatório salvo em ${process.env.HARNESS_RELATORIO}`);
  }
  console.log(markdown);
  if (report.passK < 1) process.exitCode = 1;
}

async function resolveEndpoint(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  if (process.env.HARNESS_BASE_URL && process.env.HARNESS_API_KEY) {
    return { baseUrl: process.env.HARNESS_BASE_URL, apiKey: process.env.HARNESS_API_KEY, model: process.env.HARNESS_MODEL ?? "gpt-6-luna" };
  }
  const workspaceId = process.env.HARNESS_WORKSPACE_ID;
  if (!workspaceId) throw new Error("Defina HARNESS_WORKSPACE_ID, ou HARNESS_BASE_URL + HARNESS_API_KEY, ou HARNESS_OFFLINE=1.");
  const prisma = new PrismaClient();
  try {
    const settings = await resolveOpenAiCompatibleSettings(prisma, { workspaceId });
    if (!settings.active) throw new Error(`O workspace não tem provedor de IA ativo (${settings.reason}).`);
    return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: process.env.HARNESS_MODEL ?? settings.chatModel };
  } finally {
    await prisma.$disconnect();
  }
}

function readReasoning() {
  const value = process.env.HARNESS_REASONING;
  return value === "none" || value === "low" || value === "medium" || value === "high" ? value : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
