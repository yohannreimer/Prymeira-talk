import { PrismaClient } from "@prisma/client";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { resolveOpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";
import { pendenciasAbertas } from "../src/modules/harness/agentes/atendimento/ficha.js";
import { seguirComHarness, type FonteDaBase, type HarnessConfig, type MensagemDaConversa } from "../src/modules/harness/agentes/atendimento/producao.js";
import { createJevClient } from "../src/modules/harness/core/jev.js";
import { createOpenAiCompatibleModel } from "../src/modules/harness/core/model.js";

// Follow-up shadow run: for every follow-up the current engine decided (harness-exportar-followups.ts), the new
// agent's follow-up (analyst subagent + code move + writer + JEV judge) runs on the same conversation, cut at the
// same moment, and the two decisions go side by side. Nothing is sent and nothing is written to the database.
//
//   HARNESS_FOLLOWUPS=followups.jsonl.gz  HARNESS_BASE_FONTES=followups-base.jsonl
//   HARNESS_CATALOGO=villefer  HARNESS_BASE_PROPOSTA=1  (same as the live config)
//   HARNESS_WORKSPACE_ID=<id> (the workspace's model)  or  HARNESS_BASE_URL + HARNESS_API_KEY [+ HARNESS_MODEL]
//   JEV_API_KEY (the judge; without it nothing checks whether a message is worth sending)
//   HARNESS_SOMBRA_SAIDA=resultado.jsonl  HARNESS_RELATORIO=resumo.md
//   HARNESS_SOMBRA_LIMITE=150  HARNESS_PARALELO=4
//   HARNESS_SOMBRA_CASOS=resultado-anterior.jsonl (rerun only those cases, keeping that run's answer to compare)

type FollowupExportado = {
  id: string; agente: string; tipo: string; etapa: number; status: string; motivo: string | null;
  agendadoPara: string; enviadoPor: "vendedor" | "automatico" | null; rascunho: string | null; final: string | null;
  decisao: Record<string, unknown>;
};
type ConversaExportada = {
  conversa: string; canal: string | null;
  mensagens: Array<{ autor: string; tipo: string; texto: string | null; em: string }>;
  followups: FollowupExportado[];
};

const AUTOR: Record<string, MensagemDaConversa["autor"]> = { contato: "contato", agente: "agente", empresa_automatico: "agente", vendedor: "humano" };

export const chaveDoFollowup = (item: { conversa: string; followup: string }) => `${item.conversa}|${item.followup}`;

/** What the old engine did with this follow-up, in the same words as the new one. */
export function acaoAntiga(followup: Pick<FollowupExportado, "status" | "tipo" | "enviadoPor">) {
  if (followup.status === "sent") return followup.enviadoPor === "vendedor" ? "vendedor_enviou" : "enviou";
  if (followup.status === "skipped") return "nada";
  return followup.tipo === "seller_reminder" ? "lembrete" : "rascunho";
}

async function main() {
  const caminho = process.env.HARNESS_FOLLOWUPS;
  if (!caminho || !process.env.HARNESS_BASE_FONTES) throw new Error("Defina HARNESS_FOLLOWUPS e HARNESS_BASE_FONTES (os dois arquivos de harness-exportar-followups.ts).");
  const bruto = await readFile(resolve(caminho));
  const conversas: ConversaExportada[] = (caminho.endsWith(".gz") ? gunzipSync(bruto).toString("utf8") : bruto.toString("utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const fontes: Array<FonteDaBase & { agentId: string; type?: string; status?: string }> = (await readFile(resolve(process.env.HARNESS_BASE_FONTES), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line, indice) => ({ id: `fonte${indice}`, ...JSON.parse(line) }))
    .filter((fonte) => (fonte.status ?? "ready") === "ready");
  const anteriores = process.env.HARNESS_SOMBRA_CASOS
    ? new Map((await readFile(resolve(process.env.HARNESS_SOMBRA_CASOS), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((linha) => [chaveDoFollowup(linha), linha.novo]))
    : null;

  const config: HarnessConfig = {
    agente: "atendimento",
    canais: ["sombra"],
    ...(process.env.HARNESS_CATALOGO === "villefer" ? { catalogo: "villefer" as const } : {}),
    ...(process.env.HARNESS_BASE_PROPOSTA === "1" ? { propostaVillefer: true } : {})
  };
  const endpoint = await resolveEndpoint();
  const model = createOpenAiCompatibleModel({ ...endpoint, mode: "json", reasoningEffort: "low" });
  const analista = createOpenAiCompatibleModel({ ...endpoint, mode: "json", reasoningEffort: "high", maxCompletionTokens: 16_000 });
  const jev = process.env.JEV_API_KEY ? createJevClient({ apiKey: process.env.JEV_API_KEY, model: process.env.JEV_MODEL }) : undefined;
  if (!jev) console.error("Aviso: sem JEV_API_KEY, o juiz que confere se o follow-up vale a pena não roda.");

  const casos = conversas.flatMap((conversa) => conversa.followups.map((followup) => ({ conversa, followup })))
    .filter(({ conversa, followup }) => !anteriores || anteriores.has(chaveDoFollowup({ conversa: conversa.conversa, followup: followup.id })))
    .slice(0, Number(process.env.HARNESS_SOMBRA_LIMITE ?? (anteriores ? anteriores.size : 150)));
  console.error(`Sombra do follow-up: ${conversas.length} conversas, ${casos.length} follow-ups do motor atual para refazer.`);

  const linhas: Array<{ antigo: { acao: string } & Record<string, unknown>; novo: Record<string, unknown> } & Record<string, unknown>> = new Array(casos.length);
  let feitos = 0;
  await emParalelo(casos, Number(process.env.HARNESS_PARALELO ?? 4), async ({ conversa, followup }, indice) => {
    const momento = new Date(followup.agendadoPara);
    const mensagens: MensagemDaConversa[] = conversa.mensagens
      .filter((mensagem) => new Date(mensagem.em) < momento)
      .map((mensagem, posicao) => ({ id: String(posicao), autor: AUTOR[mensagem.autor] ?? "sistema", tipo: mensagem.tipo, texto: mensagem.texto, em: mensagem.em }));
    const doAgente = fontes.filter((fonte) => fonte.agentId === followup.agente);
    const inicio = Date.now();
    let novo: Record<string, unknown>;
    try {
      const resultado = await seguirComHarness({ config, model, analista, jev, fontes: doAgente.length ? doAgente : fontes, mensagens, sessionMetadata: null, agora: momento });
      novo = {
        acao: resultado.tipo,
        jogada: resultado.jogada,
        texto: resultado.tipo === "mensagem" ? resultado.texto : null,
        motivo: resultado.tipo === "mensagem" ? null : resultado.motivo,
        contato: resultado.ficha.contato.tipo,
        pendencias: pendenciasAbertas(resultado.ficha).map((item) => `${item.dono}: ${item.descricao}`),
        encerrada: resultado.ficha.encerrada?.motivo ?? null,
        bloqueios: resultado.trace.filter((step) => step.fase === "revisao" && (step.detalhe as { ok?: boolean })?.ok === false).map((step) => step.detalhe),
        segundos: Math.round((Date.now() - inicio) / 1000)
      };
    } catch (error) {
      novo = { acao: "erro", erro: error instanceof Error ? error.message : String(error) };
    }
    const anterior = anteriores?.get(chaveDoFollowup({ conversa: conversa.conversa, followup: followup.id }));
    linhas[indice] = {
      conversa: conversa.conversa,
      followup: followup.id,
      canal: conversa.canal,
      momento: followup.agendadoPara,
      etapa: followup.etapa,
      ultimas: mensagens.slice(-4).map((mensagem) => `${mensagem.autor}: ${(mensagem.texto ?? `[${mensagem.tipo}]`).slice(0, 200)}`),
      antigo: { acao: acaoAntiga(followup), tipo: followup.tipo, motivo: followup.motivo, texto: followup.final ?? followup.rascunho, decisao: followup.decisao },
      novo,
      ...(anterior !== undefined ? { anterior } : {})
    };
    feitos += 1;
    console.error(`[${feitos}/${casos.length}] ${conversa.conversa} etapa ${followup.etapa}: antigo ${acaoAntiga(followup)} · novo ${novo.acao}${novo.jogada ? ` (${novo.jogada})` : ""}`);
  });

  if (process.env.HARNESS_SOMBRA_SAIDA) await writeFile(resolve(process.env.HARNESS_SOMBRA_SAIDA), linhas.map((linha) => JSON.stringify(linha)).join("\n") + "\n");
  const resumo = resumir(linhas);
  if (process.env.HARNESS_RELATORIO) await writeFile(resolve(process.env.HARNESS_RELATORIO), resumo);
  console.log(resumo);
}

/** Old decision against new, as a table, plus how often the new one wrote to the contact where the old did not. */
export function resumir(linhas: Array<{ antigo: { acao: string }; novo: Record<string, unknown> }>) {
  const antigas = ["enviou", "vendedor_enviou", "rascunho", "lembrete", "nada"];
  const novas = ["mensagem", "lembrete", "nada", "erro"];
  const conta = (antiga: string, nova: string) => linhas.filter((linha) => linha.antigo.acao === antiga && linha.novo.acao === nova).length;
  const escreveu = (acao: string) => ["enviou", "vendedor_enviou", "rascunho"].includes(acao);
  return [
    "# Sombra do follow-up: agente novo contra o motor atual",
    "",
    `Follow-ups refeitos: ${linhas.length}`,
    "",
    `| motor atual \\ agente novo | ${novas.join(" | ")} |`,
    `|---|${novas.map(() => "---").join("|")}|`,
    ...antigas.map((antiga) => `| ${antiga} | ${novas.map((nova) => conta(antiga, nova)).join(" | ")} |`),
    "",
    `O atual escreveu ao cliente e o novo ficou quieto ou lembrou o vendedor: ${linhas.filter((linha) => escreveu(linha.antigo.acao) && ["nada", "lembrete"].includes(String(linha.novo.acao))).length}`,
    `O atual não escreveu e o novo escreveu: ${linhas.filter((linha) => !escreveu(linha.antigo.acao) && linha.novo.acao === "mensagem").length}`,
    `Mensagens do novo barradas pelo revisor pelo menos uma vez: ${linhas.filter((linha) => Array.isArray(linha.novo.bloqueios) && linha.novo.bloqueios.length > 0).length}`
  ].join("\n");
}

async function emParalelo<T>(itens: T[], limite: number, trabalho: (item: T, indice: number) => Promise<void>) {
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limite, itens.length)) }, async () => {
    while (proximo < itens.length) {
      const indice = proximo++;
      await trabalho(itens[indice], indice);
    }
  }));
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

if (process.argv[1]?.endsWith("harness-sombra-followup.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
