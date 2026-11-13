/** Synthetic, transport-free regression. Reads configuration only; never persists runs or conversations. */
import { PrismaClient } from "@prisma/client";
import { resolveOpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";
import { readHarnessConfig, responderComHarness, modeloDoHarness } from "../src/modules/harness/agentes/atendimento/producao.js";
import { createJevClient } from "../src/modules/harness/core/jev.js";
import { fichaInicial } from "../src/modules/harness/agentes/atendimento/ficha.js";

export async function runCommercialSmoke() {
  if (process.env.JUNIOR_COMMERCIAL_LIVE_TEST !== "1") throw new Error("Explicit JUNIOR_COMMERCIAL_LIVE_TEST=1 required");
  const p = new PrismaClient();
  const workspaceId = "42e336e1-4ba8-4299-ba6d-8e2a01eef6cb";
  const agentId = "13093fdb-909e-4c9a-8935-21c87ab94986";
  const loaded = await p.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const agent = await tx.aiAgent.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: agentId } }, select: { behaviorConfig: true, knowledgeSources: { where: { status: "ready" }, select: { id: true, title: true, content: true } } } });
    const settings = await resolveOpenAiCompatibleSettings(tx, { workspaceId });
    return { agent, settings };
  }).finally(() => p.$disconnect());
  const config = readHarnessConfig(loaded.agent.behaviorConfig);
  if (!config || !loaded.settings.active || !process.env.JEV_API_KEY) throw new Error("Active production harness, OpenAI settings and JEV required");
  const model = modeloDoHarness(loaded.settings, config.modelo)!;
  const jev = createJevClient({ apiKey: process.env.JEV_API_KEY, model: process.env.JEV_MODEL, timeoutMs: 30000 });
  const cases = [
    { id: "lambril_direct", messages: ["Bom dia, trabalham com chapa lambril para fechamento de portão?"], handoff: true },
    { id: "lambril_continuation", messages: ["Preciso de 5 chapas lambril, medida informada 2.500x1.00.", "Se não tiver pronta entrega, fazem sob encomenda?"], handoff: true },
    { id: "minimum_scope", messages: ["Preciso de tubos galvanizados de dois tamanhos.", "Trabalhamos sob encomenda com mínimo aproximado de 1.000 kg.", "1.000 kg de cada tamanho ou do pedido total?"], authors: ["contato", "agente", "contato"], handoff: true },
    { id: "known_stock", messages: ["Bom dia, vocês trabalham com chapa de aço carbono lisa?"], handoff: false },
    { id: "quote_specification", messages: ["Preciso cotar 4 chapas de inox 304 de 2 mm."], handoff: false },
    { id: "confirmed_refusal", messages: ["Vocês trabalham com telhas?"], handoff: false },
    { id: "greeting", messages: ["Bom dia!"], handoff: false },
    { id: "two_options_confirmation", messages: ["Preciso cotar perfil U, 6 barras de 6 metros.", "Você prefere U enrijecido ou U estrutural?", "Os dois"], authors: ["contato", "agente", "contato"], handoff: false }
  ];
  let failures = 0;
  for (const c of cases) {
    const messages = c.messages.map((texto, i) => ({ id: `synthetic-${c.id}-${i}`, autor: (c.authors?.[i] ?? "contato") as "contato" | "agente", tipo: "text", texto, em: "2026-11-13T13:00:00Z" }));
    const current = messages.at(-1)!;
    const start = Date.now();
    try {
      const result = await responderComHarness({ config, model, jev, fontes: loaded.agent.knowledgeSources, mensagens: messages, atual: { id: current.id, texto: current.texto, em: current.em }, sessionMetadata: { harness: { ficha: fichaInicial() } } });
      const hasAction = result.actions.some(a => a.type === "request_handoff");
      const exposed = /não (?:sei|consigo|tenho)|não est[áã] (?:definid|confirmad)/i.test(result.reply ?? "");
      const pass = result.handoff.required === c.handoff && hasAction === c.handoff && !exposed && Boolean(result.reply) && (!c.handoff || !result.reply!.includes("?"));
      if (!pass) failures++;
      console.log("COMMERCIAL_CASE", JSON.stringify({ id: c.id, pass, expectedHandoff: c.handoff, handoff: result.handoff, actions: result.actions.map(a => a.type), reply: result.reply, jogada: result.jogada, ms: Date.now() - start, questions: result.ficha.perguntas.map(q => ({ natureza: q.natureza, status: q.status, buscas: q.buscas })), reviews: result.trace.filter(t => t.fase === "revisao").map(t => t.detalhe) }));
    } catch (e) {
      failures++; console.log("COMMERCIAL_CASE", JSON.stringify({ id: c.id, pass: false, error: e instanceof Error ? e.message : "unknown" }));
    }
  }
  console.log("COMMERCIAL_SUMMARY", JSON.stringify({ cases: cases.length, failures, model: model.id, databaseWrites: 0, transportCalls: 0 }));
  if (failures) process.exitCode = 1;
}
