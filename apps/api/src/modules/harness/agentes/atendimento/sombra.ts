import type { HarnessMessage } from "../../core/types.js";
import type { Check, Scenario, ScenarioRun } from "../../simulador/simulador.js";
import type { ContextoDoAtendimento, FichaDoAtendimento } from "./tipos.js";

/**
 * Shadow mode on history: every reply the old agent gave in a real conversation becomes a scenario with
 * the same history and the same customer messages, so the new agent's reply sits next to what the old
 * one did. Nothing is sent: it runs in the simulator on exported conversations (harness-exportar-conversas.ts).
 */
type Cenario = Scenario<FichaDoAtendimento, ContextoDoAtendimento>;
type Run = ScenarioRun<FichaDoAtendimento, ContextoDoAtendimento>;

export type SessaoExportada = {
  conversa: string;
  mensagens: Array<{ autor: string; tipo: string; texto: string | null; em: string }>;
  decisoes: Array<{ em: string; status: string; resposta: string | null; humano: { reason: string | null; required: boolean } | null }>;
};

export type DecisaoAntiga = { conversa: string; em: string; cliente: string; resposta: string | null; passou: boolean; motivo: string | null };

const GENERICA = /consultar (essas |as )?informa[cç][oõ]es|j[aá] te (dou um )?retorno/i;
const SEM_TEXTO: Record<string, string> = { audio: "[áudio sem transcrição]", image: "[imagem]", file: "[arquivo]", template: "[modelo de mensagem]" };
const AUTOR: Record<string, HarnessMessage["autor"]> = { contato: "contato", agente: "agente", empresa_automatico: "agente", vendedor: "humano", sistema: "sistema" };

const texto = (mensagem: SessaoExportada["mensagens"][number]) => mensagem.texto?.trim() || SEM_TEXTO[mensagem.tipo] || `[${mensagem.tipo}]`;

/**
 * One scenario per old decision that answered customer messages, before any seller joined. Hand-overs
 * come first, since they are what we are trying to reduce; `limite` caps the total.
 */
export function cenariosDaSombra(sessoes: SessaoExportada[], pedido: ContextoDoAtendimento, limite = 150): Array<{ cenario: Cenario; antiga: DecisaoAntiga }> {
  const todos: Array<{ cenario: Cenario; antiga: DecisaoAntiga }> = [];
  for (const sessao of sessoes) {
    const mensagens = [...sessao.mensagens].sort((a, b) => a.em.localeCompare(b.em));
    for (const [indice, decisao] of sessao.decisoes.entries()) {
      const antes = mensagens.filter((mensagem) => mensagem.em <= decisao.em);
      if (antes.some((mensagem) => mensagem.autor === "vendedor")) break;
      // The reply this decision produced is stored a moment before the decision itself: leave it out.
      const limite = new Date(decisao.em).getTime() - 120_000;
      while (antes.length && (antes.at(-1)!.autor === "agente" || antes.at(-1)!.autor === "empresa_automatico") && new Date(antes.at(-1)!.em).getTime() >= limite) antes.pop();
      let inicio = antes.length;
      while (inicio > 0 && antes[inicio - 1].autor === "contato") inicio -= 1;
      const bloco = antes.slice(inicio);
      if (!bloco.length) continue;
      const cliente = bloco.map(texto).join("\n");
      const antiga: DecisaoAntiga = {
        conversa: sessao.conversa,
        em: decisao.em,
        cliente,
        resposta: decisao.resposta,
        passou: Boolean(decisao.humano?.required),
        motivo: decisao.humano?.reason ?? null
      };
      todos.push({
        antiga,
        cenario: {
          id: `sombra_${sessao.conversa}_${indice + 1}`,
          titulo: `Conversa real ${sessao.conversa}, vez ${indice + 1}${antiga.passou ? ` (o agente antigo passou: ${antiga.motivo ?? "sem motivo"})` : ""}`,
          pedido,
          persona: { tipo: "roteiro", responder: ({ vez }: { vez: number }) => (vez === 0 ? cliente : null) },
          historicoInicial: antes.slice(0, inicio).map((mensagem) => ({ autor: AUTOR[mensagem.autor] ?? "sistema", texto: texto(mensagem), em: mensagem.em })),
          maxTrocas: 1,
          exigeModelo: true,
          verificar: (run) => conferirSombra(run, antiga)
        }
      });
    }
  }
  const passadas = todos.filter((item) => item.antiga.passou);
  const outras = todos.filter((item) => !item.antiga.passou);
  return [...passadas, ...outras].slice(0, limite);
}

/** Not a pass/fail test: the checks say what the new agent did, next to the old decision. */
function conferirSombra(run: Run, antiga: DecisaoAntiga): Check[] {
  const resposta = run.turnos.find((turno) => turno.evento.startsWith("contato:"))?.resultado;
  const novo = resposta?.enviar ?? "";
  return [
    { nome: "novo_nao_passou", ok: !resposta?.humano, detalhe: resposta?.humano?.motivo ?? "sem humano" },
    { nome: "novo_respondeu", ok: novo.length > 0, detalhe: novo || "(nada enviado)" },
    { nome: "novo_sem_frase_generica", ok: !GENERICA.test(novo), detalhe: novo },
    { nome: "antigo", ok: !antiga.passou, detalhe: `${antiga.passou ? `passou (${antiga.motivo ?? "sem motivo"})` : "respondeu"}: ${antiga.resposta ?? "(nada)"}` }
  ];
}
