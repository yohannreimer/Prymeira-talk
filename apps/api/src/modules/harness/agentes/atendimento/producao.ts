import { createJevJudge, type Judge } from "../../core/review.js";
import { runTurn } from "../../core/runner.js";
import type { JevClient } from "../../core/jev.js";
import type { OpenAiCompatibleSettings } from "../../../agents/ai-provider-settings.js";
import { createOpenAiCompatibleModel, type ModelClient } from "../../core/model.js";
import { createTriage } from "../../core/triage.js";
import type { HarnessMessage, TraceStep } from "../../core/types.js";
import { catalogoEmMemoria, type Catalogo, type LinhaDoCatalogo } from "./catalogo.js";
import { baseCompleta, fichaInicial, trechosDeFontes } from "./ficha.js";
import { atendimento } from "./index.js";
import { createJuizDeFollowup } from "./juiz.js";
import { aplicarPropostaVillefer } from "./proposta-villefer.js";
import type { AnexoAprovado, ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";

/**
 * The attendance agent inside the live engine. Off unless the agent's behaviorConfig has `harness`, and
 * then only on the channels it lists, so it can be turned on for one WhatsApp number at a time:
 *   "harness": { "agente": "atendimento", "canais": ["<channel id>"], "catalogo": "villefer", "propostaVillefer": true }
 */
export type HarnessConfig = {
  agente: "atendimento";
  canais: string[];
  /** Product tables for weights; "villefer" is the table extracted from its PDF catalogue. */
  catalogo?: "villefer";
  /** Applies the minimums and delivery cities the company gave on 16/10 until the base itself has them. */
  propostaVillefer?: boolean;
  empresa?: { nome: string; oQueVende: string };
  /** Internal notes of the base that never go to the contact. */
  termosInternos?: string[];
  /** Defaults to the workspace chat model. */
  modelo?: string;
};

const EMPRESA_VILLEFER = {
  nome: "Villefer",
  oQueVende: "Distribuidora de aço para indústria e caldeiraria: chapas e laminados (barras, cantoneiras, vigas, perfis), tubos e inox ou alumínio sob encomenda."
};

export function readHarnessConfig(behaviorConfig: unknown): HarnessConfig | null {
  const value = isObject(behaviorConfig) ? behaviorConfig.harness : null;
  if (!isObject(value) || value.agente !== "atendimento") return null;
  const canais = Array.isArray(value.canais) ? value.canais.filter((canal): canal is string => typeof canal === "string" && canal.length > 0) : [];
  // Without an explicit channel it stays off: turning it on for every number at once is not an option.
  if (!canais.length) return null;
  const empresa = isObject(value.empresa) && typeof value.empresa.nome === "string" && typeof value.empresa.oQueVende === "string"
    ? { nome: value.empresa.nome, oQueVende: value.empresa.oQueVende }
    : undefined;
  return {
    agente: "atendimento",
    canais,
    ...(value.catalogo === "villefer" ? { catalogo: "villefer" as const } : {}),
    ...(value.propostaVillefer === true ? { propostaVillefer: true } : {}),
    ...(empresa ? { empresa } : {}),
    ...(Array.isArray(value.termosInternos) ? { termosInternos: value.termosInternos.filter((termo): termo is string => typeof termo === "string") } : {}),
    ...(typeof value.modelo === "string" && value.modelo ? { modelo: value.modelo } : {})
  };
}

export const harnessNoCanal = (config: HarnessConfig | null, channelId: string | null | undefined): config is HarnessConfig =>
  Boolean(config && channelId && config.canais.includes(channelId));

/** The workspace's model in JSON mode with low reasoning: the configuration tested in the shadow runs. */
export function modeloDoHarness(settings: OpenAiCompatibleSettings, modelo?: string): ModelClient | null {
  if (!settings.active) return null;
  return createOpenAiCompatibleModel({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: modelo ?? settings.chatModel, mode: "json", reasoningEffort: "low" });
}

/** The follow-up analyst reads the whole conversation: more reasoning, and JSON mode, where Luna takes tools with reasoning. */
export function modeloDoAnalista(settings: OpenAiCompatibleSettings, modelo?: string): ModelClient | null {
  if (!settings.active) return null;
  return createOpenAiCompatibleModel({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: modelo ?? settings.chatModel, mode: "json", reasoningEffort: "high", maxCompletionTokens: 16_000 });
}

/** Who sent a stored message: the contact, the AI agent or the company's automations, or a seller. */
export function autorDaMensagem(mensagem: { direction: string | null; type?: string | null; metadata?: unknown; sentByUserId?: string | null }): HarnessMessage["autor"] {
  if (mensagem.type === "internal_note" || mensagem.type === "system") return "sistema";
  if (mensagem.direction === "inbound") return "contato";
  if (mensagem.direction !== "outbound") return "sistema";
  const source = isObject(mensagem.metadata) ? mensagem.metadata.source : undefined;
  return source === "ai_agent" || !mensagem.sentByUserId ? "agente" : "humano";
}

/** A conversation message as the live engine has it, with who sent it already resolved. */
export type MensagemDaConversa = {
  id: string;
  autor: HarnessMessage["autor"];
  tipo: string | null;
  texto: string | null;
  em: string | null;
};

export type FonteDaBase = { id: string; title: string; content: string | null; fileUrl?: string | null; fileName?: string | null; mimeType?: string | null };

/** What the live engine does with the turn, in its own action vocabulary. */
export type SaidaDoHarness = {
  silencio: boolean;
  reply: string | null;
  actions: Array<Record<string, unknown> & { type: string }>;
  handoff: { required: boolean; reason: string | null };
  ficha: FichaDoAtendimento;
  jogada: string | null;
  trace: TraceStep[];
};

const SEM_TEXTO: Record<string, string> = { image: "[imagem]", audio: "[áudio]", file: "[arquivo]", video: "[vídeo]", sticker: "[figurinha]" };

let catalogoVillefer: Promise<Catalogo> | null = null;
function carregarCatalogoVillefer() {
  catalogoVillefer ??= import("./dados/catalogo-villefer.json", { with: { type: "json" } })
    .then((modulo) => catalogoEmMemoria(modulo.default as LinhaDoCatalogo[]));
  return catalogoVillefer;
}

/** Approved PDFs the agent may attach, from the agent's ready knowledge sources that have a URL. */
export function anexosDasFontes(fontes: FonteDaBase[]): AnexoAprovado[] {
  let numero = 0;
  const vistos = new Set<string>();
  return fontes.flatMap((fonte) => {
    const url = fonte.fileUrl?.trim();
    const pdf = fonte.mimeType === "application/pdf" || /\.pdf$/i.test(fonte.fileName ?? "") || /\.pdf$/i.test(url ?? "");
    if (!url || !url.startsWith("https://") || !pdf) return [];
    numero += 1;
    const id = /cat[aá]logo/i.test(`${fonte.title} ${fonte.fileName ?? ""}`) && !vistos.has("catalogo") ? "catalogo" : `anexo${numero}`;
    vistos.add(id);
    return [{ id, titulo: fonte.title, url, nomeArquivo: fonte.fileName?.trim() || null, mimeType: "application/pdf" }];
  });
}

export async function contextoDeProducao(config: HarnessConfig, fontes: FonteDaBase[]): Promise<ContextoDoAtendimento> {
  const textos = fontes.filter((fonte) => fonte.content?.trim());
  const trechos = trechosDeFontes(config.propostaVillefer ? aplicarPropostaVillefer(textos).fontes : textos);
  return {
    empresa: config.empresa ?? EMPRESA_VILLEFER,
    maxFollowups: 3,
    base: baseCompleta(trechos),
    ...(config.catalogo === "villefer" ? { catalogo: await carregarCatalogoVillefer() } : {}),
    anexos: anexosDasFontes(fontes),
    termosInternos: config.termosInternos ?? (config.empresa ? [] : ["EA36"])
  };
}

/** The record saved in the session metadata, or a new one. A saved record missing newer fields gets their defaults. */
export function fichaSalva(metadata: unknown): FichaDoAtendimento {
  const salva = isObject(metadata) && isObject(metadata.harness) ? metadata.harness.ficha : null;
  return isObject(salva) && Array.isArray(salva.perguntas) ? { ...fichaInicial(), ...(salva as Partial<FichaDoAtendimento>) } : fichaInicial();
}

/**
 * The conversation as the harness reads it: everything before the contact's latest messages, then those
 * messages joined as one (a burst is answered once), with the current message in its processed form
 * (audio transcribed, PDF read).
 */
export function conversaParaOHarness(mensagens: MensagemDaConversa[], atual: { id: string; texto: string; em: string }) {
  const indice = mensagens.findIndex((mensagem) => mensagem.id === atual.id);
  const ate = indice >= 0 ? mensagens.slice(0, indice + 1) : [...mensagens, { id: atual.id, autor: "contato" as const, tipo: "text", texto: atual.texto, em: atual.em }];
  const linhas = ate
    .filter((mensagem) => mensagem.autor !== "sistema" || mensagem.texto?.trim())
    .map((mensagem) => ({
      ...mensagem,
      texto: mensagem.id === atual.id ? atual.texto : mensagem.texto?.trim() || SEM_TEXTO[mensagem.tipo ?? ""] || `[${mensagem.tipo ?? "mensagem"}]`
    }));
  let inicio = linhas.length;
  while (inicio > 0 && linhas[inicio - 1].autor === "contato") inicio -= 1;
  const texto = linhas.slice(inicio).map((mensagem) => mensagem.texto).join("\n") || atual.texto;
  const historico: HarnessMessage[] = [
    ...linhas.slice(0, inicio).map((mensagem) => ({ autor: mensagem.autor, texto: mensagem.texto, em: mensagem.em ?? atual.em })),
    { autor: "contato", texto, em: atual.em }
  ];
  return { historico, texto };
}

/** One live turn: the same runner the simulator and the shadow runs use, with the engine's model and JEV. */
export async function responderComHarness(input: {
  config: HarnessConfig;
  model: ModelClient;
  jev?: JevClient;
  fontes: FonteDaBase[];
  mensagens: MensagemDaConversa[];
  atual: { id: string; texto: string; em: string };
  sessionMetadata: unknown;
}): Promise<SaidaDoHarness> {
  const pedido = await contextoDeProducao(input.config, input.fontes);
  const { historico, texto } = conversaParaOHarness(input.mensagens, input.atual);
  const resultado = await runTurn(atendimento, {
    model: input.model,
    triage: createTriage({ jev: input.jev }),
    // Fail closed: with the judge down, the fixed hand-over notice goes out instead of an unchecked reply.
    ...(input.jev ? { judge: createJevJudge(input.jev), judgeFailClosed: true } : {})
  }, { ficha: fichaSalva(input.sessionMetadata), pedido, historico, evento: { tipo: "mensagem", texto } });

  const actions: SaidaDoHarness["actions"] = (resultado.anexos ?? []).map((anexo) => ({
    type: "send_attachment",
    attachmentUrl: anexo.url,
    caption: anexo.legenda,
    ...(anexo.nomeArquivo ? { attachmentFileName: anexo.nomeArquivo } : {}),
    ...(anexo.mimeType ? { attachmentMimeType: anexo.mimeType } : {})
  }));
  if (resultado.humano) {
    actions.push(
      { type: "create_internal_note", body: `Motivo do repasse: ${resultado.humano.motivo}\n\n${resultado.humano.resumo}` },
      { type: "request_handoff", reason: resultado.humano.motivo }
    );
  }
  return {
    silencio: !resultado.enviar && !resultado.humano,
    // A live hand-over always answers the contact; the fixed notice covers a move that wrote nothing.
    reply: resultado.enviar ?? (resultado.humano ? atendimento.avisoDeRepasse ?? null : null),
    actions,
    handoff: { required: Boolean(resultado.humano), reason: resultado.humano?.motivo ?? null },
    ficha: resultado.ficha,
    jogada: resultado.jogada?.tipo ?? null,
    trace: resultado.trace
  };
}

export type FollowupDoHarness =
  | { tipo: "nada"; jogada: string; motivo: string; ficha: FichaDoAtendimento; trace: TraceStep[] }
  | { tipo: "lembrete_vendedor"; jogada: string; motivo: string; resumo: string; ficha: FichaDoAtendimento; trace: TraceStep[] }
  | { tipo: "mensagem"; jogada: string; texto: string; ficha: FichaDoAtendimento; trace: TraceStep[] };

/**
 * One follow-up of a quiet conversation: the analyst subagent reads the whole conversation and brings the
 * record up to date, code picks the move (chase the contact, remind the seller, or stay quiet), the writer
 * writes and the "is it worth sending?" judge reviews. Timing and delivery stay with the follow-up engine.
 */
export async function seguirComHarness(input: {
  config: HarnessConfig;
  model: ModelClient;
  analista: ModelClient;
  jev?: JevClient;
  fontes: FonteDaBase[];
  mensagens: MensagemDaConversa[];
  sessionMetadata: unknown;
  agora: Date;
}): Promise<FollowupDoHarness> {
  const pedido = await contextoDeProducao(input.config, input.fontes.map((fonte) => ({ ...fonte, fileUrl: null })));
  const historico: HarnessMessage[] = input.mensagens
    .filter((mensagem) => mensagem.autor !== "sistema")
    .map((mensagem) => ({ autor: mensagem.autor, texto: mensagem.texto?.trim() || SEM_TEXTO[mensagem.tipo ?? ""] || `[${mensagem.tipo ?? "mensagem"}]`, em: mensagem.em ?? input.agora.toISOString() }));
  const ultima = historico.at(-1)?.em;
  const horasSemResposta = ultima ? Math.max(0, (input.agora.getTime() - Date.parse(ultima)) / 3_600_000) : 0;
  const judge: Judge | undefined = input.jev ? createJuizDeFollowup(input.jev) : undefined;
  const resultado = await runTurn(atendimento, {
    model: input.model,
    analista: input.analista,
    ...(judge ? { judge, judgeFailClosed: true } : {})
  }, { ficha: fichaSalva(input.sessionMetadata), pedido, historico, evento: { tipo: "silencio", horasSemResposta } });
  const jogada = resultado.jogada?.tipo ?? "nada";
  const base = { jogada, ficha: resultado.ficha, trace: resultado.trace };
  if (resultado.enviar) return { ...base, tipo: "mensagem", texto: resultado.enviar };
  if (resultado.humano) return { ...base, tipo: "lembrete_vendedor", motivo: resultado.humano.motivo, resumo: resultado.humano.resumo };
  return { ...base, tipo: "nada", motivo: resultado.jogada?.instrucao ?? "sem jogada" };
}

/** The session metadata with the harness record, keeping what other services store there (the handoff brief). */
export function metadataComFicha(metadata: unknown, ficha: FichaDoAtendimento) {
  return { ...(isObject(metadata) ? metadata : {}), harness: { ficha, atualizadoEm: new Date().toISOString() } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
