import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { resolve } from "node:path";
import { resolveOpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";
import { createOpenAiCompatibleModel } from "../src/modules/harness/core/model.js";

config({ path: resolve(import.meta.dirname, "../../../.env") });

// Answers the first open question of the harness: does the model (gpt-6-luna by default) accept native
// tool calling on its OpenAI-compatible endpoint, and does the JSON fallback work? Read-only, two small calls each.
// Same endpoint variables as harness-simular.ts: HARNESS_WORKSPACE_ID, or HARNESS_BASE_URL + HARNESS_API_KEY.

const TOOL = {
  name: "registrar_proposta",
  description: "Registra o preço unitário da cadeira e o frete informados pelo fornecedor.",
  parameters: {
    type: "object",
    properties: { precoCadeira: { type: "number" }, frete: { type: "number" } },
    required: ["precoCadeira", "frete"],
    additionalProperties: false
  }
};

async function main() {
  const endpoint = await resolveEndpoint();
  for (const reasoning of [undefined, "low"] as const) {
    for (const mode of ["tools", "json"] as const) {
      const model = createOpenAiCompatibleModel({ ...endpoint, mode, reasoningEffort: reasoning });
      const label = `${endpoint.model} · modo ${mode} · raciocínio ${reasoning ?? "padrão"}`;
      const started = Date.now();
      try {
        const response = await model.complete({
          messages: [
            { role: "system", content: "Registre na ficha o que o fornecedor informou, usando a ferramenta." },
            { role: "user", content: "Fornecedor: a cadeira fica R$ 890 cada e o frete R$ 350." }
          ],
          tools: [TOOL],
          toolChoice: "required"
        });
        const call = response.toolCalls[0];
        const args = call ? JSON.parse(call.arguments) as { precoCadeira?: number; frete?: number } : null;
        const correct = args?.precoCadeira === 890 && args?.frete === 350;
        console.log(`${correct ? "✅" : "⚠️"} ${label}: ${call ? `${call.name}(${call.arguments})` : `sem chamada; texto: ${response.content?.slice(0, 120)}`} · ${Date.now() - started} ms`);
      } catch (error) {
        console.log(`❌ ${label}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

async function resolveEndpoint(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  if (process.env.HARNESS_BASE_URL && process.env.HARNESS_API_KEY) {
    return { baseUrl: process.env.HARNESS_BASE_URL, apiKey: process.env.HARNESS_API_KEY, model: process.env.HARNESS_MODEL ?? "gpt-6-luna" };
  }
  const workspaceId = process.env.HARNESS_WORKSPACE_ID;
  if (!workspaceId) throw new Error("Defina HARNESS_WORKSPACE_ID, ou HARNESS_BASE_URL + HARNESS_API_KEY.");
  const prisma = new PrismaClient();
  try {
    const settings = await resolveOpenAiCompatibleSettings(prisma, { workspaceId });
    if (!settings.active) throw new Error(`O workspace não tem provedor de IA ativo (${settings.reason}).`);
    return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: process.env.HARNESS_MODEL ?? settings.chatModel };
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
