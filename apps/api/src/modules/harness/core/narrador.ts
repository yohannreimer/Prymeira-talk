import type { HarnessEvent, Jogada, TraceStep, TurnResult } from "./types.js";

/**
 * Turns a turn's trace into steps an owner can read without code: "classified the message",
 * "used this tool and got this", "decided this move because…", "wrote this", "the reviewer blocked it".
 * It shows decisions and their reasons, not the model's hidden reasoning (which the API never returns).
 */
export type Passo = {
  fase: TraceStep["fase"];
  titulo: string;
  detalhe?: string;
  tipo: "info" | "ok" | "alerta" | "erro";
  ms?: number;
};

const TRIAGEM: Record<string, string> = {
  humano: "uma pessoa escrevendo",
  robo: "um robô ou mensagem automática",
  despedida: "uma despedida",
  recusa: "uma recusa",
  injecao: "uma tentativa de mudar as regras do agente"
};

/** Friendly verbs for the tools of every agent; unknown tools fall back to their own name. */
const FERRAMENTAS: Record<string, string> = {
  registrar_pergunta: "Anotou a pergunta do cliente",
  buscar_na_base: "Procurou na base de conhecimento",
  responder_pergunta: "Achou a resposta na base",
  marcar_sem_base: "Concluiu que a base não responde",
  cliente_pediu_pessoa: "Anotou que o cliente pediu uma pessoa",
  classificar_contato: "Classificou quem é o contato",
  abrir_pendencia: "Abriu uma pendência",
  resolver_pendencia: "Marcou uma pendência como resolvida",
  marcar_encerrada: "Marcou a conversa como encerrada",
  marcar_em_andamento: "Marcou que o assunto está andando",
  registrar_contato_indicado: "Anotou um contato indicado",
  registrar_contato: "Anotou quem está respondendo",
  registrar_interesse: "Anotou o interesse do lead",
  registrar_dor: "Anotou uma dor que o lead contou",
  registrar_objecao: "Anotou uma objeção",
  registrar_pergunta_do_lead: "Anotou a pergunta do lead",
  registrar_indicado: "Anotou quem foi indicado",
  registrar_aceite: "Anotou que o lead aceitou",
  marcar_declinou: "Anotou que o lead não quer",
  registrar_proposta: "Anotou a proposta do fornecedor",
  registrar_sem_desconto: "Anotou que não tem desconto",
  registrar_vai_verificar: "Anotou que o fornecedor vai verificar",
  registrar_observacao: "Anotou uma observação"
};

export function narrarEvento(evento: HarnessEvent): string {
  if (evento.tipo === "abertura") return "Início da conversa";
  if (evento.tipo === "silencio") return `${evento.horasSemResposta} horas sem resposta do contato`;
  return "Chegou uma mensagem";
}

export function narrarTurno(result: Pick<TurnResult<unknown>, "trace">): Passo[] {
  const passos: Passo[] = [];
  for (const step of result.trace) passos.push(...narrarPasso(step));
  return passos;
}

function narrarPasso(step: TraceStep): Passo[] {
  const detalhe = step.detalhe as any;
  const ms = step.ms;
  switch (step.fase) {
    case "triagem": {
      const quem = TRIAGEM[detalhe?.kind] ?? detalhe?.kind;
      const fonte = detalhe?.fonte === "jev" ? "pelo classificador" : "pelas regras fixas";
      return [{ fase: step.fase, titulo: `Entendeu que é ${quem}`, detalhe: `Decidido ${fonte}: ${detalhe?.motivo ?? ""}`.trim(), tipo: detalhe?.kind === "humano" ? "info" : "alerta", ms }];
    }
    case "leitura":
    case "analise": {
      const calls: Array<{ ferramenta: string; argumentos: unknown; resultado: string }> = Array.isArray(detalhe) ? detalhe : [];
      const quem = step.fase === "analise" ? "Leu a conversa inteira para decidir se vale retomar" : "Leu a mensagem";
      const head: Passo = {
        fase: step.fase,
        titulo: calls.length ? quem : `${quem} e não anotou nada`,
        tipo: "info",
        ms
      };
      return [head, ...calls.map((call) => narrarFerramenta(step.fase, call))];
    }
    case "jogada": {
      const jogada = detalhe as Jogada;
      const extras = [
        jogada.silencio ? "Não vai mandar nada." : null,
        jogada.humano ? `Vai passar para uma pessoa: ${jogada.humano}` : null,
        jogada.avisarHumano ? `Responde e avisa uma pessoa: ${jogada.avisarHumano}` : null
      ].filter(Boolean);
      return [{ fase: step.fase, titulo: `Decidiu: ${legivel(jogada.tipo)}`, detalhe: [jogada.instrucao, ...extras].filter(Boolean).join("\n"), tipo: "info" }];
    }
    case "escrita": {
      if (detalhe?.pedirHumanoRecusado !== undefined) {
        return [{ fase: step.fase, titulo: "Tentou passar para uma pessoa, e o código não deixou", detalhe: `Motivo que deu: ${detalhe.pedirHumanoRecusado ?? "(nenhum)"}. Esse motivo não está na lista permitida, então ele teve que responder.`, tipo: "alerta", ms }];
      }
      if (detalhe?.pedirHumano) return [{ fase: step.fase, titulo: "Pediu uma pessoa em vez de responder", detalhe: legivel(String(detalhe.pedirHumano)), tipo: "alerta", ms }];
      const tentativa = Number(detalhe?.tentativa ?? 1);
      return [{ fase: step.fase, titulo: tentativa > 1 ? "Reescreveu a mensagem" : "Escreveu a mensagem", detalhe: detalhe?.texto ?? "", tipo: "info", ms }];
    }
    case "revisao": {
      const verificacoes = Array.isArray(detalhe?.verificacoes) ? detalhe.verificacoes.map((v: { id: string; resultado: string; motivo?: string; exigencia?: string; ok: boolean }) => `${v.ok ? "✓" : "✗"} ${v.id}: ${v.resultado}. ${v.motivo || v.exigencia || ""}`).join("\n") : null;
      const notas = [renderNotas(detalhe?.notas), verificacoes].filter(Boolean).join("\n");
      if (detalhe?.ok) {
        const juiz = detalhe.juiz === "aprovou" ? "As regras e o revisor aprovaram" : detalhe.juiz === "falhou_aberto" ? "As regras aprovaram (o revisor não respondeu)" : "As regras aprovaram";
        return [{ fase: step.fase, titulo: juiz, detalhe: notas, tipo: "ok", ms }];
      }
      const quem = detalhe?.fonte === "juiz" ? "O revisor" : "A regra";
      return [{ fase: step.fase, titulo: `${quem} bloqueou: ${legivel(String(detalhe?.regra ?? ""))}`, detalhe: [detalhe?.motivo, notas].filter(Boolean).join("\n"), tipo: "erro", ms }];
    }
    case "envio":
      return [{ fase: step.fase, titulo: "Mandou a mensagem", tipo: "ok" }];
    case "humano":
      return [{ fase: step.fase, titulo: "Passou para uma pessoa", detalhe: legivel(String(detalhe?.motivo ?? "")), tipo: "alerta" }];
    case "silencio":
      return [{ fase: step.fase, titulo: "Ficou quieto, de propósito", detalhe: legivel(String(detalhe ?? "")), tipo: "info" }];
  }
}

function narrarFerramenta(fase: TraceStep["fase"], call: { ferramenta: string; argumentos: unknown; resultado: string }): Passo {
  if (call.ferramenta === "conferencia_do_codigo") {
    return { fase, titulo: "O código conferiu a leitura e pediu para olhar de novo", detalhe: call.resultado.replace(/^erro:?\s*/i, ""), tipo: "alerta" };
  }
  const titulo = FERRAMENTAS[call.ferramenta] ?? `Usou a ferramenta ${legivel(call.ferramenta)}`;
  const recusado = /^erro/i.test(call.resultado.trim());
  const args = renderArgs(call.argumentos);
  const resultado = recusado ? `O código recusou: ${call.resultado.replace(/^erro:?\s*/i, "")}` : `Resultado: ${resumir(call.resultado)}`;
  return { fase, titulo: recusado ? `${titulo} (recusado)` : titulo, detalhe: [args, resultado].filter(Boolean).join("\n"), tipo: recusado ? "alerta" : "info" };
}

const NOTAS: Record<string, string> = {
  inventa: "inventou algo",
  segue: "seguiu a jogada",
  responde: "respondeu o contato",
  vale: "vale mandar",
  assunto: "assunto certo"
};

/** The judge's scores, so the owner can see how sure it was ("inventou algo: 72%"). */
function renderNotas(notas: unknown): string | undefined {
  if (!notas || typeof notas !== "object") return undefined;
  const partes = Object.entries(notas as Record<string, number>).map(([nome, valor]) => `${NOTAS[nome] ?? nome}: ${Math.round(valor * 100)}%`);
  return partes.length ? `Certeza do revisor · ${partes.join(" · ")}` : undefined;
}

/** Tool results often end with the whole record; the first lines are what matters to a reader. */
function resumir(texto: string, limite = 320) {
  const curto = texto.split(/\s*Ficha agora:|\n(?=Ficha|Contato:|# )/)[0].trim();
  return curto.length > limite ? `${curto.slice(0, limite).trimEnd()}…` : curto;
}

function renderArgs(args: unknown): string {
  if (!args || typeof args !== "object") return args ? String(args) : "";
  return Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${legivel(key)}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("\n");
}

/** "cobrar_pendencia" → "cobrar pendência"-ish plain words. */
export function legivel(id: string) {
  return id.replace(/_/g, " ");
}
