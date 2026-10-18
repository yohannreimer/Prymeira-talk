/** Offline replay: no database client, queue, outbound runtime or WhatsApp transport. */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { modeloDoAnalista, modeloDoHarness, seguirComHarness, type HarnessConfig, type MensagemDaConversa } from "../src/modules/harness/agentes/atendimento/producao.js";
import { createJevClient } from "../src/modules/harness/core/jev.js";
import type { OpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";

export type ReplayCase = { id: string; expected: Array<"mensagem" | "lembrete_vendedor" | "nada">; messages: MensagemDaConversa[]; sessionMetadata?: unknown };
type Sources = Parameters<typeof seguirComHarness>[0]["fontes"];

export async function replayFollowupCases(input: {
  settings: OpenAiCompatibleSettings; config: HarnessConfig; sources: Sources;
  cases: ReplayCase[]; now: Date; jevApiKey: string; jevModel?: string;
  onResult?: (result: Record<string, unknown>) => Promise<void> | void;
}) {
  const model = modeloDoHarness(input.settings, input.config.modelo);
  const analista = modeloDoAnalista(input.settings, input.config.modelo);
  if (!model || !analista || !input.jevApiKey) throw new Error("REAL_PROVIDERS_REQUIRED");
  const jev = createJevClient({ apiKey: input.jevApiKey, model: input.jevModel });
  const results: Record<string, unknown>[] = [];
  // Bounded parallel model requests, not agent delegation. No external actions are available.
  for (let offset = 0; offset < input.cases.length; offset += 3) {
    const batch = await Promise.all(input.cases.slice(offset, offset + 3).map(async item => {
      try {
        const result = await seguirComHarness({ config: input.config, fontes: input.sources,
          model, analista, jev, mensagens: item.messages, sessionMetadata: item.sessionMetadata ?? {}, agora: input.now });
        return { id: item.id, expected: item.expected, passed: item.expected.includes(result.tipo), result };
      } catch (error) {
        return { id: item.id, expected: item.expected, passed: false, error: error instanceof Error ? error.message : "REPLAY_FAILED" };
      }
    }));
    for (const result of batch) { results.push(result); await input.onResult?.(result); }
  }
  return { model: model.id, analyst: analista.id, now: input.now.toISOString(), transportAvailable: false,
    databaseWrites: false, total: results.length, matchedExpectedAction: results.filter(r => r.passed).length, results };
}

const fileSchema = z.object({
  config: z.object({ agente: z.literal("atendimento"), canais: z.array(z.string()), modelo: z.string().optional(),
    empresa: z.object({ nome: z.string(), oQueVende: z.string() }).optional(), regrasDoFollowup: z.array(z.string()).optional(),
    catalogo: z.literal("villefer").optional(), propostaVillefer: z.boolean().optional(), termosInternos: z.array(z.string()).optional(), cliente: z.string().optional() }),
  sources: z.array(z.object({ id: z.string(), title: z.string(), content: z.string().nullable(), fileUrl: z.string().nullable().optional(), fileName: z.string().nullable().optional(), mimeType: z.string().nullable().optional() })),
  cases: z.array(z.object({ id: z.string(), expected: z.array(z.enum(["mensagem", "lembrete_vendedor", "nada"])).min(1),
    messages: z.array(z.object({ id: z.string(), autor: z.enum(["contato", "humano", "agente", "sistema"]), texto: z.string().nullable(), em: z.string(), tipo: z.string().optional() })).min(1), sessionMetadata: z.unknown().optional() })).min(1)
});

async function main() {
  const file = process.env.FOLLOWUP_REPLAY_FILE;
  if (!file || !process.env.OPENAI_API_KEY || !process.env.JEV_API_KEY) throw new Error("Set FOLLOWUP_REPLAY_FILE, OPENAI_API_KEY and JEV_API_KEY");
  const data = fileSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const result = await replayFollowupCases({ ...data, settings: { active: true, baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY, chatModel: process.env.FOLLOWUP_REPLAY_MODEL ?? "gpt-6-luna" },
    now: new Date(process.env.FOLLOWUP_REPLAY_NOW ?? Date.now()), jevApiKey: process.env.JEV_API_KEY, jevModel: process.env.JEV_MODEL,
    onResult: r => { console.error(JSON.stringify({ id: r.id, passed: r.passed })); } });
  await writeFile(process.env.FOLLOWUP_REPLAY_OUTPUT ?? "followup-replay.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ total: result.total, matchedExpectedAction: result.matchedExpectedAction, transportAvailable: false }));
  if (result.matchedExpectedAction !== result.total) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => { console.error("FOLLOWUP_REPLAY_FAILED"); process.exitCode = 1; });
