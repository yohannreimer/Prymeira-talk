/** Synthetic quality regression against configured models. No outbound, queue or conversation writes. */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assessQualityResult, followupQualityCases, qualityMessages, qualitySession } from "../src/modules/harness/fixtures/followup-quality.js";
import { seguirComHarness, modeloDoHarness, modeloDoAnalista, type HarnessConfig, type FonteDaBase } from "../src/modules/harness/agentes/atendimento/producao.js";
import { createJevClient } from "../src/modules/harness/core/jev.js";
import type { OpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";

export async function replayJuniorQuality(input: {
  settings: OpenAiCompatibleSettings; config: HarnessConfig; fontes: FonteDaBase[];
  jevApiKey: string; jevModel?: string; now: Date;
  onResult?: (result: Record<string, unknown>) => void;
  caseIds?: string[];
}) {
  const model = modeloDoHarness(input.settings, input.config.modelo), analista = modeloDoAnalista(input.settings, input.config.modelo);
  if (!model || !analista || !input.jevApiKey) throw new Error("REAL_PROVIDERS_REQUIRED");
  const jev = createJevClient({ apiKey: input.jevApiKey, model: input.jevModel });
  const results: Record<string, unknown>[] = [];
  const cases = followupQualityCases.filter(item => !input.caseIds || input.caseIds.includes(item.id));
  for (let offset = 0; offset < cases.length; offset += 2) {
    await Promise.all(cases.slice(offset, offset + 2).map(async item => {
      let record: Record<string, unknown>;
      try {
        const result = await seguirComHarness({ config: input.config, model, analista, jev, fontes: input.fontes,
          mensagens: qualityMessages(item), sessionMetadata: qualitySession(item), agora: input.now });
        const assessed = assessQualityResult(item, result);
        record = { id: item.id, group: item.group, expected: item.expected, ...assessed, action: result.tipo,
          pending: result.ficha.pendencias, trace: result.trace };
      } catch (error) {
        // Do not print provider error bodies; credentials or private provider details may be present.
        record = { id: item.id, group: item.group, passed: false, error: error instanceof Error ? error.message.split(":")[0].slice(0, 80) : "REPLAY_FAILED" };
      }
      results.push(record); input.onResult?.(record);
    }));
  }
  return { total: results.length, passed: results.filter(r => r.passed).length,
    model: model.id, analyst: analista.id, transportAvailable: false, databaseWrites: false, results };
}

async function main() {
  if (!process.env.OPENAI_API_KEY || !process.env.JEV_API_KEY) throw new Error("REAL_PROVIDERS_REQUIRED");
  const report = await replayJuniorQuality({ settings: { active: true, apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", chatModel: process.env.FOLLOWUP_REPLAY_MODEL ?? "gpt-6-luna" },
    config: { agente: "atendimento", canais: [] }, fontes: [], now: new Date("2026-11-11T15:00:00Z"),
    jevApiKey: process.env.JEV_API_KEY, jevModel: process.env.JEV_MODEL,
    onResult: r => console.log(JSON.stringify({ id: r.id, passed: r.passed, action: r.action, failures: r.failures, error: r.error })) });
  await writeFile(process.env.FOLLOWUP_REPLAY_OUTPUT ?? "junior-followup-quality.json", JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => { console.error("QUALITY_REPLAY_FAILED"); process.exitCode = 1; });
