import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { resolveOpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";
import { atendimento } from "../src/modules/harness/agentes/atendimento/index.js";
import { cenarios as cenariosAtendimento, cenariosAoVivo, cenariosDaBaseReal, cenariosDeCasos, contextoDaBaseReal } from "../src/modules/harness/agentes/atendimento/cenarios.js";
import { baseCompleta, trechosDeFontes } from "../src/modules/harness/agentes/atendimento/ficha.js";
import { catalogoEmMemoria, type LinhaDoCatalogo } from "../src/modules/harness/agentes/atendimento/catalogo.js";
import { cenariosDaSombra, chaveDaDecisao, type DecisaoAntiga } from "../src/modules/harness/agentes/atendimento/sombra.js";
import type { AnexoAprovado } from "../src/modules/harness/agentes/atendimento/tipos.js";
import { aplicarPropostaVillefer } from "../src/modules/harness/agentes/atendimento/proposta-villefer.js";
import { createJuizDeAtendimento, createJuizDeFollowup } from "../src/modules/harness/agentes/atendimento/juiz.js";
import { cenarios } from "../src/modules/harness/agentes/comprador/cenarios.js";
import { comprador } from "../src/modules/harness/agentes/comprador/index.js";
import { cenarios as cenariosProspeccao } from "../src/modules/harness/agentes/prospeccao/cenarios.js";
import { prospeccao } from "../src/modules/harness/agentes/prospeccao/index.js";
import { createFakeProspeccao } from "../src/modules/harness/agentes/prospeccao/modelos-falsos.js";
import { createFakeComprador } from "../src/modules/harness/agentes/comprador/modelos-falsos.js";
import { createJevClient } from "../src/modules/harness/core/jev.js";
import { createOpenAiCompatibleModel, type ModelClient } from "../src/modules/harness/core/model.js";
import { createJevJudge, type Judge } from "../src/modules/harness/core/review.js";
import type { RunnerDeps } from "../src/modules/harness/core/runner.js";
import { createTriage } from "../src/modules/harness/core/triage.js";
import { documentoHtml, renderLinhaDoTempoHtml, type EntradaDaLinha } from "../src/modules/harness/simulador/linha-do-tempo.js";
import { renderReport, runSuite, type Check, type ScenarioRun } from "../src/modules/harness/simulador/simulador.js";

config({ path: resolve(import.meta.dirname, "../../../.env") });

// Runs an agent against its scenarios and prints the scorecard (pass^k).
// HARNESS_AGENTE=comprador (default), prospeccao (João, the 13/10 conversations) or atendimento (live replies with the knowledge base, and follow-up on silence; HARNESS_CASOS=cases.jsonl adds
// labeled real conversations in the evaluate-followup-brain format).
// Nothing is sent to WhatsApp and nothing is written to the database.
//
// Model (pick one):
//   HARNESS_WORKSPACE_ID=<id>            uses that workspace's AI provider (the same Luna the Talk uses)
//   HARNESS_BASE_URL + HARNESS_API_KEY   any OpenAI-compatible endpoint
//   HARNESS_OFFLINE=1                    deterministic fake models (only scenarios that don't need a model)
// Options:
//   HARNESS_MODEL (default: the workspace's model, else gpt-6-luna) · HARNESS_MODE=tools|json|responses (default tools)
//   HARNESS_REASONING=none|low|medium|high · FORNECEDOR_MODEL (plays the LLM suppliers; default HARNESS_MODEL)
//   HARNESS_K (default 4) · HARNESS_CENARIOS=id1,id2 · HARNESS_RELATORIO=path.md
//   HARNESS_LINHA_DO_TEMPO=path.html: a page with every conversation and, between the messages, what the agent
//   did (triage, tools and results, the move and why, the text, the review). Open it in a browser.
//   JEV_API_KEY: JEV does the triage and judges each message (fails closed when JEV is down)
//   HARNESS_BASE_FONTES=conversas-base.jsonl (atendimento): adds the questions the old agent handed over although
//     the real base answers them, run against that base. HARNESS_BASE_AGENTE=<agentId> picks one agent's sources.
//     HARNESS_SOMBRA=conversas.jsonl.gz replays every reply of the old agent with the new one, side by side
//     (HARNESS_SOMBRA_SAIDA=sombra.jsonl, HARNESS_SOMBRA_LIMITE=150). HARNESS_SOMBRA_CASOS=casos.jsonl reruns only
//     the decisions listed there (lines of an earlier sombra.jsonl), next to the answer of that run.
//     HARNESS_CATALOGO=villefer adds the product tables (sizes and kg/m) as a tool.
//     HARNESS_BASE_PROPOSTA=1 applies the new minimums and delivery cities (proposta-villefer.ts) on top.
//   HARNESS_REASONING_ANALISTA (default high): reasoning of the analyst subagent (atendimento)

async function main() {
  if (process.env.HARNESS_AGENTE === "atendimento") return runAtendimento();
  if (process.env.HARNESS_AGENTE === "prospeccao") return runProspeccao();
  const k = Number(process.env.HARNESS_K ?? 4);
  const wanted = (process.env.HARNESS_CENARIOS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const offline = process.env.HARNESS_OFFLINE === "1";
  let scenarios = cenarios.filter((scenario) => !wanted.length || wanted.includes(scenario.id));
  if (offline) scenarios = scenarios.filter((scenario) => !scenario.exigeModelo);

  const jev = process.env.JEV_API_KEY ? createJevClient({ apiKey: process.env.JEV_API_KEY, model: process.env.JEV_MODEL }) : undefined;
  let deps: () => RunnerDeps;
  let fornecedor: ModelClient | undefined;
  const linha = linhaDoTempo();

  if (offline) {
    deps = () => {
      const fake = createFakeComprador();
      return { model: fake.escritor, leitor: fake.leitor, triage: createTriage() };
    };
  } else {
    const endpoint = await resolveEndpoint();
    const model = createOpenAiCompatibleModel({
      ...endpoint,
      mode: readMode(),
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
    onProgress: (line) => console.error(line),
    onRun: linha.onRun
  });
  await linha.salvar(report.agente, report.modelo);
  const markdown = renderReport(report);
  if (process.env.HARNESS_RELATORIO) {
    await writeFile(resolve(process.env.HARNESS_RELATORIO), markdown);
    console.error(`Relatório salvo em ${process.env.HARNESS_RELATORIO}`);
  }
  console.log(markdown);
  if (report.passK < 1) process.exitCode = 1;
}

async function runAtendimento() {
  const k = Number(process.env.HARNESS_K ?? (process.env.HARNESS_SOMBRA ? 1 : 4));
  const wanted = (process.env.HARNESS_CENARIOS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const casos = process.env.HARNESS_CASOS
    ? cenariosDeCasos((await readFile(resolve(process.env.HARNESS_CASOS), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)))
    : [];
  const baseReal = process.env.HARNESS_BASE_FONTES ? await carregarBaseReal(process.env.HARNESS_BASE_FONTES) : null;
  const catalogo = baseReal ? await carregarCatalogo() : undefined;
  const sombra = process.env.HARNESS_SOMBRA ? await carregarSombra(process.env.HARNESS_SOMBRA, baseReal, catalogo) : null;
  const scenarios = sombra
    ? sombra.map((item) => item.cenario)
    : [...cenariosAoVivo, ...cenariosAtendimento, ...casos, ...(baseReal ? cenariosDaBaseReal(baseReal, catalogo, baseReal.anexos) : [])].filter((scenario) => !wanted.length || wanted.includes(scenario.id));
  if (process.env.HARNESS_OFFLINE === "1") throw new Error("Os cenários de atendimento precisam de modelo: use HARNESS_WORKSPACE_ID ou HARNESS_BASE_URL.");
  const endpoint = await resolveEndpoint();
  const mode = readMode();
  const model = createOpenAiCompatibleModel({ ...endpoint, mode, reasoningEffort: readReasoning() });
  const analistaReasoning = process.env.HARNESS_REASONING_ANALISTA;
  const analistaEffort = analistaReasoning === "none" || analistaReasoning === "low" || analistaReasoning === "medium" ? analistaReasoning : "high";
  const analista = createOpenAiCompatibleModel({
    ...endpoint,
    // Luna refuses native tools together with reasoning_effort on /chat/completions; /responses takes both.
    mode: analistaEffort === "none" || mode === "responses" ? mode : "json",
    reasoningEffort: analistaEffort,
    maxCompletionTokens: 16_000
  });
  const jev = process.env.JEV_API_KEY ? createJevClient({ apiKey: process.env.JEV_API_KEY, model: process.env.JEV_MODEL }) : undefined;
  const linha = linhaDoTempo();
  const report = await runSuite({
    agent: atendimento,
    deps: () => ({
      model,
      analista,
      triage: createTriage({ jev }),
      // Follow-ups get the "is it worth sending?" judge; live replies get the general one.
      ...(jev ? { judge: juizPorJogada(createJuizDeFollowup(jev), createJuizDeAtendimento(jev)), judgeFailClosed: true } : {})
    }),
    scenarios,
    k,
    onProgress: (line) => console.error(line),
    onRun: (input) => {
      linha.onRun(input);
      if (sombra) {
        const item = sombra.find((candidato) => candidato.cenario.id === input.scenario.id)!;
        comparacoes.push({ antiga: item.antiga, anterior: item.anterior, checks: input.checks });
      }
    }
  });
  await linha.salvar(report.agente, report.modelo);
  if (sombra) return salvarSombra(comparacoes);
  const markdown = renderReport(report);
  if (process.env.HARNESS_RELATORIO) await writeFile(resolve(process.env.HARNESS_RELATORIO), markdown);
  console.log(markdown);
  if (report.passK < 1) process.exitCode = 1;
}

const comparacoes: Array<{ antiga: DecisaoAntiga; anterior?: unknown; checks: Check[] }> = [];

/**
 * HARNESS_SOMBRA=conversas.jsonl.gz (the export of harness-exportar-conversas.ts): every reply the old agent
 * gave becomes a scenario with the same history, run once (HARNESS_SOMBRA_LIMITE, default 150, hand-overs first).
 */
async function carregarSombra(caminho: string, base: Awaited<ReturnType<typeof carregarBaseReal>> | null, catalogo: Awaited<ReturnType<typeof carregarCatalogo>>) {
  if (!base) throw new Error("O modo sombra precisa da base real: defina HARNESS_BASE_FONTES.");
  const bruto = await readFile(resolve(caminho));
  const texto = caminho.endsWith(".gz") ? gunzipSync(bruto).toString("utf8") : bruto.toString("utf8");
  const sessoes = texto.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  // An earlier run's lines: rerun only those decisions, and keep that run's answer to compare.
  const anteriores = process.env.HARNESS_SOMBRA_CASOS
    ? new Map((await readFile(resolve(process.env.HARNESS_SOMBRA_CASOS), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((linha) => [chaveDaDecisao(linha), linha.novo ?? undefined]))
    : null;
  const itens = cenariosDaSombra(sessoes, contextoDaBaseReal(base, catalogo, base.anexos), Number(process.env.HARNESS_SOMBRA_LIMITE ?? (anteriores ? anteriores.size : 150)), anteriores ? new Set(anteriores.keys()) : undefined)
    .map((item) => ({ ...item, anterior: anteriores?.get(chaveDaDecisao(item.antiga)) }));
  if (anteriores && itens.length < anteriores.size) console.error(`Aviso: ${anteriores.size - itens.length} dos casos pedidos não estão nas conversas exportadas.`);
  console.error(`Sombra: ${sessoes.length} conversas, ${itens.length} respostas do agente antigo para refazer (${itens.filter((item) => item.antiga.passou).length} delas ele passou para humano).`);
  return itens;
}

/** Side by side, as JSONL (HARNESS_SOMBRA_SAIDA) and a short summary of hand-overs, old against new. */
async function salvarSombra(itens: typeof comparacoes) {
  const detalhe = (checks: Check[], nome: string) => checks.find((check) => check.nome === nome);
  const linhas = itens.map(({ antiga, anterior, checks }) => ({
    conversa: antiga.conversa,
    em: antiga.em,
    cliente: antiga.cliente,
    antigo: { passou: antiga.passou, motivo: antiga.motivo, resposta: antiga.resposta },
    novo: {
      passou: !detalhe(checks, "novo_nao_passou")!.ok,
      motivo: detalhe(checks, "novo_nao_passou")!.ok ? null : detalhe(checks, "novo_nao_passou")!.detalhe,
      resposta: detalhe(checks, "novo_respondeu")!.ok ? detalhe(checks, "novo_respondeu")!.detalhe : null,
      fraseGenerica: !detalhe(checks, "novo_sem_frase_generica")!.ok,
      anexos: detalhe(checks, "novo_anexou")?.ok ? detalhe(checks, "novo_anexou")!.detalhe : null
    },
    ...(anterior !== undefined ? { anterior } : {})
  }));
  if (process.env.HARNESS_SOMBRA_SAIDA) await writeFile(resolve(process.env.HARNESS_SOMBRA_SAIDA), linhas.map((linha) => JSON.stringify(linha)).join("\n") + "\n");
  const conta = (filtro: (linha: (typeof linhas)[number]) => boolean) => linhas.filter(filtro).length;
  const antigoPassou = conta((linha) => linha.antigo.passou);
  console.log([
    `# Sombra: agente novo nas conversas reais`,
    ``,
    `Respostas refeitas: ${linhas.length}`,
    `Antigo passou para humano: ${antigoPassou} · novo passou: ${conta((linha) => linha.novo.passou)}`,
    `Das ${antigoPassou} que o antigo passou, o novo respondeu sem passar: ${conta((linha) => linha.antigo.passou && !linha.novo.passou)}`,
    `Das ${linhas.length - antigoPassou} que o antigo respondeu, o novo passou: ${conta((linha) => !linha.antigo.passou && linha.novo.passou)}`,
    `Novo usou a frase genérica: ${conta((linha) => linha.novo.fraseGenerica)} · novo não mandou nada: ${conta((linha) => !linha.novo.resposta)}`
  ].join("\n"));
}

async function runProspeccao() {
  const k = Number(process.env.HARNESS_K ?? 4);
  const wanted = (process.env.HARNESS_CENARIOS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const offline = process.env.HARNESS_OFFLINE === "1";
  const scenarios = cenariosProspeccao.filter((scenario) => (!wanted.length || wanted.includes(scenario.id)) && (!offline || !scenario.exigeModelo));
  const jev = process.env.JEV_API_KEY ? createJevClient({ apiKey: process.env.JEV_API_KEY, model: process.env.JEV_MODEL }) : undefined;
  let deps: () => RunnerDeps;
  let lead: ModelClient | undefined;
  if (offline) {
    deps = () => {
      const fake = createFakeProspeccao();
      return { model: fake.escritor, leitor: fake.leitor, triage: createTriage() };
    };
  } else {
    const endpoint = await resolveEndpoint();
    const model = createOpenAiCompatibleModel({ ...endpoint, mode: readMode(), reasoningEffort: readReasoning() });
    lead = createOpenAiCompatibleModel({ ...endpoint, model: process.env.FORNECEDOR_MODEL ?? endpoint.model, mode: "tools", temperature: 0.8 });
    deps = () => ({ model, triage: createTriage({ jev }), ...(jev ? { judge: createJevJudge(jev), judgeFailClosed: true } : {}) });
  }
  const linha = linhaDoTempo();
  const report = await runSuite({ agent: prospeccao, deps, scenarios, k, fornecedorModel: lead, onProgress: (line) => console.error(line), onRun: linha.onRun });
  await linha.salvar(report.agente, report.modelo);
  const markdown = renderReport(report);
  if (process.env.HARNESS_RELATORIO) await writeFile(resolve(process.env.HARNESS_RELATORIO), markdown);
  console.log(markdown);
  if (report.passK < 1) process.exitCode = 1;
}

/**
 * The knowledge sources exported from production (conversas-base.jsonl of harness-exportar-conversas.ts),
 * for the real-base scenarios. Several agents share the export: HARNESS_BASE_AGENTE picks one, else the first.
 */
async function carregarBaseReal(caminho: string) {
  const fontes: Array<{ agentId: string; type?: string; title: string; content: string | null; fileName?: string | null; fileUrl?: string | null; status?: string }> = (await readFile(resolve(caminho), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const agente = process.env.HARNESS_BASE_AGENTE ?? fontes[0]?.agentId;
  const doAgente = fontes.filter((fonte) => fonte.agentId === agente && (fonte.status ?? "ready") === "ready");
  const proposta = process.env.HARNESS_BASE_PROPOSTA === "1" ? aplicarPropostaVillefer(doAgente) : null;
  for (const frase of proposta?.naoEncontradas ?? []) console.error(`Aviso: a base exportada não tem mais a frase "${frase.slice(0, 60)}…"; a troca não foi feita.`);
  const trechos = trechosDeFontes(proposta?.fontes ?? doAgente);
  // Approved PDFs (the catalogue) the agent may attach. The export has no URL, so the simulator makes one up.
  const anexos: AnexoAprovado[] = doAgente
    .filter((fonte) => fonte.type === "file" && /\.pdf$/i.test(fonte.fileName ?? ""))
    .map((fonte, indice) => ({
      id: /cat[aá]logo/i.test(fonte.title) ? "catalogo" : `anexo${indice + 1}`,
      titulo: fonte.title,
      url: fonte.fileUrl ?? `https://simulador.invalid/${encodeURIComponent(fonte.fileName!)}`,
      nomeArquivo: fonte.fileName ?? null,
      mimeType: "application/pdf"
    }));
  const base = Object.assign(baseCompleta(trechos), { anexos });
  const caracteres = trechos.reduce((soma, trecho) => soma + trecho.titulo.length + trecho.texto.length, 0);
  console.error(`Base real: agente ${agente}, ${doAgente.length} fontes, ${trechos.length} trechos, ${caracteres} caracteres, ${base.todos ? "lida inteira" : "por busca"}${proposta ? ", com a proposta de mínimos e região" : ""}${anexos.length ? `, ${anexos.length} anexo(s) aprovado(s)` : ""}.`);
  return base;
}

/** HARNESS_CATALOGO=villefer (the tables extracted from its PDF catalogue) or a path to the same JSON format. */
async function carregarCatalogo() {
  const origem = process.env.HARNESS_CATALOGO;
  if (!origem) return undefined;
  const caminho = origem === "villefer" ? resolve(import.meta.dirname, "../src/modules/harness/agentes/atendimento/dados/catalogo-villefer.json") : resolve(origem);
  const linhas: LinhaDoCatalogo[] = JSON.parse(await readFile(caminho, "utf8"));
  console.error(`Catálogo: ${linhas.length} linhas de ${caminho}.`);
  return catalogoEmMemoria(linhas);
}

/** Collects every run for HARNESS_LINHA_DO_TEMPO and writes the page at the end. */
function linhaDoTempo() {
  const entradas: EntradaDaLinha[] = [];
  return {
    onRun: (input: { scenario: { id: string; titulo: string }; tentativa: number; run: ScenarioRun<any, any>; checks: Check[] }) => {
      if (process.env.HARNESS_LINHA_DO_TEMPO) entradas.push({ id: input.scenario.id, titulo: input.scenario.titulo, tentativa: input.tentativa, run: input.run, checks: input.checks });
    },
    salvar: async (agente: string, modelo: string) => {
      const path = process.env.HARNESS_LINHA_DO_TEMPO;
      if (!path) return;
      await writeFile(resolve(path), documentoHtml(renderLinhaDoTempoHtml({ agente, modelo, geradoEm: new Date().toLocaleString("pt-BR"), entradas })));
      console.error(`Linha do tempo salva em ${path}`);
    }
  };
}

function juizPorJogada(followup: Judge, geral: Judge): Judge {
  return (input) => (input.jogada.tipo === "cobrar_pendencia" ? followup : geral)(input);
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

function readMode() {
  const value = process.env.HARNESS_MODE;
  return value === "json" || value === "responses" ? value : "tools";
}

function readReasoning() {
  const value = process.env.HARNESS_REASONING;
  return value === "none" || value === "low" || value === "medium" || value === "high" ? value : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
