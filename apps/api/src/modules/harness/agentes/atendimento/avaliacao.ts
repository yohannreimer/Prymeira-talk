import type { ModelClient, ToolSpec } from "../../core/model.js";

/**
 * The weekly evaluation of the follow-ups, without the database: what the sellers did with each draft
 * is the label, a reviewer model explains the mistakes, a second call proposes rules, and each rule is
 * tried on the week's own cases before anyone approves it. Nothing here changes the agent.
 */

/** What happened to a follow-up after the agent decided it. Reminders stay out for now. */
export type RotuloDoFollowup = "aprovado" | "editado" | "descartado" | "respondeu" | "sem_resposta";

export type FollowupDecidido = {
  kind: string;
  status: string;
  draftBody: string | null;
  finalBody: string | null;
  sentByUserId: string | null;
  sentAt: Date | null;
  cancelledByUserId: string | null;
  /** The contact's first message after the follow-up went out. */
  respostaEm: Date | null;
};

/** A reply within this window counts as an answer to an automatic follow-up. */
export const JANELA_DE_RESPOSTA_MS = 3 * 86_400_000;

const mesmoTexto = (a: string | null, b: string | null) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

export function rotularFollowup(followup: FollowupDecidido, agora: Date): RotuloDoFollowup | null {
  if (followup.kind === "seller_reminder") return null;
  if (followup.status === "cancelled") return followup.cancelledByUserId ? "descartado" : null;
  if (followup.status !== "sent" || !followup.sentAt) return null;
  if (followup.sentByUserId) return mesmoTexto(followup.draftBody, followup.finalBody) ? "aprovado" : "editado";
  if (followup.respostaEm && followup.respostaEm.getTime() - followup.sentAt.getTime() <= JANELA_DE_RESPOSTA_MS) return "respondeu";
  return agora.getTime() - followup.sentAt.getTime() > JANELA_DE_RESPOSTA_MS ? "sem_resposta" : null;
}

export type TipoDeErro = "nao_devia" | "assunto" | "texto" | "nenhum";

export type CasoDaSemana = {
  followupId: string;
  conversationId: string;
  /** The workspace of the conversation, when a customer's agent runs in several. */
  workspaceId?: string;
  decididoEm: string;
  rotulo: RotuloDoFollowup;
  /** The draft the agent wrote and what went out (the seller's version, when edited). */
  rascunho: string | null;
  enviado: string | null;
  /** The contact's reply, for automatic follow-ups that got one. */
  resposta: string | null;
  /** The end of the conversation before the follow-up, oldest first. */
  ultimas: Array<{ autor: string; texto: string }>;
  erro?: { tipo: TipoDeErro; explicacao: string };
};

export type ValidacaoDaRegra = {
  /** Cases where the follow-up should not exist that the rule turns into nothing. */
  corrige: number;
  /** Of those cases, how many the agent without the rule still gets wrong (the others prove nothing). */
  erradosTestados: number;
  /** Follow-ups sellers approved (or contacts answered) that the rule turns into nothing. */
  quebra: number;
  bonsTestados: number;
};

export type PropostaDeRegra = {
  id: string;
  regra: string;
  porque: string;
  casos: string[];
  validacao: ValidacaoDaRegra | null;
  status: "pendente" | "aprovada" | "recusada";
  decididaEm?: string;
};

export type ResumoDaSemana = {
  rotulos: Record<RotuloDoFollowup, number>;
  /** Of the drafts a seller looked at, the share sent without changes. */
  aprovacao: number | null;
  /** Of the automatic follow-ups old enough to tell, the share the contact answered. */
  resposta: number | null;
  erros: Record<Exclude<TipoDeErro, "nenhum">, number>;
  /** Every decision of the week, including the ones that were not a message. */
  decisoes: { mensagem: number; lembrete: number; nada: number };
};

export type DecisaoRefeita = "mensagem" | "lembrete" | "nada";

const PAPEL_DO_REVISOR = `Você revisa os follow-ups que um agente de vendas mandou (ou tentou mandar) por WhatsApp para clientes de uma distribuidora.
Para que serve o follow-up: retomar uma VENDA que parou do lado do cliente antes de fechar (ele pediu orçamento e não respondeu, não respondeu a uma pergunta nossa para seguir a cotação, ficou de mandar um dado, disse "vou ver").
Não é caso de follow-up: pós-venda andando (separar, entregar, faturar), pergunta já respondida, oferta que ninguém pediu, assunto antigo, contato que não é cliente, conversa encerrada.
O vendedor revisou a mensagem do agente: aprovou, editou ou descartou. Diga qual foi o erro do agente, se houve.`;

const REVISAR: ToolSpec = {
  name: "registrar_avaliacao",
  description: "Registra o erro do agente neste caso.",
  parameters: {
    type: "object",
    properties: {
      tipo: {
        type: "string",
        enum: ["nao_devia", "assunto", "texto", "nenhum"],
        description: "nao_devia: não era caso de follow-up. assunto: era caso de follow-up, mas sobre outro assunto. texto: assunto certo, mensagem ruim (tom, tamanho, informação errada). nenhum: o agente acertou e o vendedor só ajustou o estilo."
      },
      explicacao: { type: "string", description: "Uma ou duas frases, citando a conversa." }
    },
    required: ["tipo", "explicacao"],
    additionalProperties: false
  }
};

const PROPOR: ToolSpec = {
  name: "propor_regras",
  description: "Propõe até 3 regras novas para o agente de follow-up.",
  parameters: {
    type: "object",
    properties: {
      regras: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            regra: { type: "string", description: "Uma frase curta, no imperativo, que o agente consiga seguir em qualquer conversa." },
            porque: { type: "string", description: "Que erro ela corrige, em uma frase." },
            casos: { type: "array", items: { type: "string" }, description: "Os followupId dos casos que ela corrige." }
          },
          required: ["regra", "porque", "casos"],
          additionalProperties: false
        }
      }
    },
    required: ["regras"],
    additionalProperties: false
  }
};

const conversaEmTexto = (caso: CasoDaSemana) => caso.ultimas.map((mensagem) => `${mensagem.autor}: ${mensagem.texto}`).join("\n");

async function chamarFerramenta<T>(model: ModelClient, sistema: string, usuario: string, ferramenta: ToolSpec): Promise<T | null> {
  const resposta = await model.complete({
    messages: [{ role: "system", content: sistema }, { role: "user", content: usuario }],
    tools: [ferramenta],
    toolChoice: "required"
  });
  const chamada = resposta.toolCalls.find((call) => call.name === ferramenta.name);
  if (!chamada) return null;
  try {
    return JSON.parse(chamada.arguments) as T;
  } catch {
    return null;
  }
}

/** Why the seller edited or discarded the draft. Approved and answered follow-ups are not reviewed. */
export async function revisarCaso(model: ModelClient, caso: CasoDaSemana): Promise<CasoDaSemana["erro"]> {
  const acao = caso.rotulo === "descartado" ? "O vendedor DESCARTOU a mensagem." : `O vendedor EDITOU a mensagem antes de enviar. Foi enviado: "${caso.enviado ?? ""}"`;
  const resposta = await chamarFerramenta<{ tipo: TipoDeErro; explicacao: string }>(model, PAPEL_DO_REVISOR, [
    "Conversa até o follow-up:",
    conversaEmTexto(caso),
    "",
    `Mensagem do agente: "${caso.rascunho ?? ""}"`,
    acao
  ].join("\n"), REVISAR);
  if (!resposta || !["nao_devia", "assunto", "texto", "nenhum"].includes(resposta.tipo)) return undefined;
  return { tipo: resposta.tipo, explicacao: String(resposta.explicacao ?? "").slice(0, 400) };
}

export async function proporRegras(model: ModelClient, casos: CasoDaSemana[], regrasAtuais: string[]): Promise<Array<Pick<PropostaDeRegra, "regra" | "porque" | "casos">>> {
  const comErro = casos.filter((caso) => caso.erro && caso.erro.tipo !== "nenhum");
  if (!comErro.length) return [];
  const ids = new Set(comErro.map((caso) => caso.followupId));
  const resposta = await chamarFerramenta<{ regras: Array<{ regra: string; porque: string; casos: string[] }> }>(model, [
    PAPEL_DO_REVISOR,
    "Agora leia os erros da semana e proponha no máximo 3 regras curtas que evitariam esses erros sem atrapalhar os follow-ups certos.",
    "Uma regra precisa valer para qualquer conversa: nada de nome de cliente ou número de pedido. Não repita uma regra que já existe."
  ].join("\n"), [
    `Regras que o agente já segue: ${regrasAtuais.length ? regrasAtuais.map((regra) => `"${regra}"`).join("; ") : "nenhuma além das instruções padrão"}.`,
    "",
    ...comErro.map((caso) => [
      `Caso ${caso.followupId} (${caso.rotulo}, erro ${caso.erro!.tipo}): ${caso.erro!.explicacao}`,
      `Mensagem do agente: "${caso.rascunho ?? ""}"`,
      ...(caso.rotulo === "editado" ? [`O vendedor mandou: "${caso.enviado ?? ""}"`] : []),
      ""
    ].join("\n"))
  ].join("\n"), PROPOR);
  return (resposta?.regras ?? [])
    .filter((item) => typeof item.regra === "string" && item.regra.trim().length > 5)
    .slice(0, 3)
    .map((item) => ({
      regra: item.regra.trim().slice(0, 300),
      porque: String(item.porque ?? "").trim().slice(0, 300),
      casos: (Array.isArray(item.casos) ? item.casos : []).filter((id) => ids.has(id))
    }));
}

/**
 * The auto-eval: the rule is tried on the week's cases, against the same agent without it (models vary from
 * run to run, so only a change from that baseline counts). A follow-up that should not exist has to turn into
 * nothing; one the seller approved or the contact answered must not. Text mistakes are not scored here.
 */
export async function validarRegra(input: {
  regra: string;
  errados: CasoDaSemana[];
  bons: CasoDaSemana[];
  refazer: (caso: CasoDaSemana, regras: string[]) => Promise<DecisaoRefeita>;
  semRegra: (caso: CasoDaSemana) => Promise<DecisaoRefeita>;
}): Promise<ValidacaoDaRegra> {
  let corrige = 0;
  let erradosTestados = 0;
  let quebra = 0;
  let bonsTestados = 0;
  for (const caso of input.errados) {
    if (await input.semRegra(caso) !== "mensagem") continue;
    erradosTestados += 1;
    if (await input.refazer(caso, [input.regra]) !== "mensagem") corrige += 1;
  }
  for (const caso of input.bons) {
    if (await input.semRegra(caso) !== "mensagem") continue;
    bonsTestados += 1;
    if (await input.refazer(caso, [input.regra]) === "nada") quebra += 1;
  }
  return { corrige, erradosTestados, quebra, bonsTestados };
}

export function resumir(casos: CasoDaSemana[], decisoes: ResumoDaSemana["decisoes"]): ResumoDaSemana {
  const rotulos: ResumoDaSemana["rotulos"] = { aprovado: 0, editado: 0, descartado: 0, respondeu: 0, sem_resposta: 0 };
  const erros: ResumoDaSemana["erros"] = { nao_devia: 0, assunto: 0, texto: 0 };
  for (const caso of casos) {
    rotulos[caso.rotulo] += 1;
    if (caso.erro && caso.erro.tipo !== "nenhum") erros[caso.erro.tipo] += 1;
  }
  const revisados = rotulos.aprovado + rotulos.editado + rotulos.descartado;
  const automaticos = rotulos.respondeu + rotulos.sem_resposta;
  return {
    rotulos,
    aprovacao: revisados ? rotulos.aprovado / revisados : null,
    resposta: automaticos ? rotulos.respondeu / automaticos : null,
    erros,
    decisoes
  };
}

export const LIMITES_DA_AVALIACAO = { revisados: 40, porRegraErrados: 8, porRegraBons: 6 };

/** The whole weekly pass over cases already labeled. Each step that fails leaves the rest of the report. */
export async function avaliarSemana(input: {
  casos: CasoDaSemana[];
  decisoes: ResumoDaSemana["decisoes"];
  revisor: ModelClient;
  regrasAtuais: string[];
  refazer?: (caso: CasoDaSemana, regras: string[]) => Promise<DecisaoRefeita>;
  limites?: typeof LIMITES_DA_AVALIACAO;
}): Promise<{ resumo: ResumoDaSemana; casos: CasoDaSemana[]; propostas: PropostaDeRegra[] }> {
  const limites = input.limites ?? LIMITES_DA_AVALIACAO;
  const casos = [...input.casos];
  const paraRevisar = casos.filter((caso) => caso.rotulo === "editado" || caso.rotulo === "descartado").slice(0, limites.revisados);
  for (const caso of paraRevisar) {
    const erro = await revisarCaso(input.revisor, caso).catch(() => undefined);
    if (erro) caso.erro = erro;
  }
  const sugeridas = await proporRegras(input.revisor, casos, input.regrasAtuais).catch(() => []);
  const bons = casos.filter((caso) => caso.rotulo === "aprovado" || caso.rotulo === "respondeu").slice(0, limites.porRegraBons);
  const propostas: PropostaDeRegra[] = [];
  const refazer = input.refazer;
  const baseline = new Map<string, Promise<DecisaoRefeita>>();
  const semRegra = (caso: CasoDaSemana) => {
    if (!baseline.has(caso.followupId)) baseline.set(caso.followupId, refazer!(caso, []));
    return baseline.get(caso.followupId)!;
  };
  for (const [indice, sugerida] of sugeridas.entries()) {
    const errados = casos.filter((caso) => sugerida.casos.includes(caso.followupId) && caso.erro?.tipo === "nao_devia").slice(0, limites.porRegraErrados);
    const validacao = refazer
      ? await validarRegra({ regra: sugerida.regra, errados, bons, refazer, semRegra }).catch(() => null)
      : null;
    propostas.push({ id: `r${indice + 1}`, ...sugerida, validacao, status: "pendente" });
  }
  return { resumo: resumir(casos, input.decisoes), casos, propostas };
}
