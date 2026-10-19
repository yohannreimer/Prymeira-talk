// Builds the example timeline page from scripted runs (no model needed): npx tsx scripts/harness-linha-do-tempo-exemplo.ts out.html
// For real runs use HARNESS_LINHA_DO_TEMPO=out.html with harness-simular.ts.
import { writeFile } from "node:fs/promises";
import { atendimento } from "../src/modules/harness/agentes/atendimento/index.js";
import { contextoVillefer, conversa } from "../src/modules/harness/agentes/atendimento/cenarios.js";
import { cenarios as cenariosJoao } from "../src/modules/harness/agentes/prospeccao/cenarios.js";
import { prospeccao } from "../src/modules/harness/agentes/prospeccao/index.js";
import { createFakeProspeccao } from "../src/modules/harness/agentes/prospeccao/modelos-falsos.js";
import { createScriptedModel, toolCall } from "../src/modules/harness/core/model.js";
import { createTriage } from "../src/modules/harness/core/triage.js";
import { renderLinhaDoTempoHtml, type EntradaDaLinha } from "../src/modules/harness/simulador/linha-do-tempo.js";
import { runScenario, type Scenario } from "../src/modules/harness/simulador/simulador.js";

const entradas: EntradaDaLinha[] = [];
const fala = (...falas: (string | null)[]) => ({ tipo: "roteiro" as const, responder: ({ vez }: { vez: number }) => falas[vez] ?? null });
const leitor = (...rodadas: ReturnType<typeof toolCall>[][]) => {
  let i = 0;
  return createScriptedModel("leitor", () => ({ content: null, toolCalls: rodadas[i++] ?? [] }));
};
const responde = (...textos: string[]) => {
  let i = 0;
  return createScriptedModel("escritor", () => ({ content: null, toolCalls: [toolCall("responder", { texto: textos[Math.min(i++, textos.length - 1)] })] }));
};

async function atd(id: string, titulo: string, s: Partial<Scenario<any, any>>, deps: any, checks: (run: any) => any[]) {
  const scenario = { id, titulo, pedido: contextoVillefer(), persona: fala(), maxTrocas: 1, verificar: checks, ...s } as Scenario<any, any>;
  const run = await runScenario({ agent: atendimento, deps: { triage: createTriage(), ...deps }, scenario });
  entradas.push({ id, titulo, tentativa: 1, run, checks: checks(run) });
}

await atd("blumenau", "Atendimento: prazo está na base, desconto não", { persona: fala("prazo pra blumenau? e desconto pra 5 toneladas?") }, {
  leitor: leitor(
    [toolCall("registrar_pergunta", { texto: "prazo para Blumenau" }), toolCall("registrar_pergunta", { texto: "desconto para 5 toneladas" })],
    [toolCall("buscar_na_base", { perguntaId: "q1", consulta: "entrega Blumenau" }), toolCall("buscar_na_base", { perguntaId: "q2", consulta: "desconto toneladas" })],
    [toolCall("responder_pergunta", { perguntaId: "q1", trechoId: "entrega", citacao: "em até 48 horas úteis" }), toolCall("marcar_sem_base", { perguntaId: "q2" })]
  ),
  model: responde("Pra Blumenau a entrega é em até 48 horas úteis depois do faturamento. O desconto pra 5 toneladas o vendedor confirma com você ainda hoje.")
}, (run) => [
  { nome: "respondeu_o_prazo", ok: run.historico.some((m: any) => m.autor === "agente" && /48 horas/.test(m.texto)) },
  { nome: "passou_so_o_desconto", ok: /desconto/.test(run.humano?.motivo ?? ""), detalhe: run.humano?.motivo }
]);

await atd("chapa3mm", "Atendimento: inventou um preço e o código barrou", { persona: fala("tem chapa 3mm? quanto o quilo?") }, {
  leitor: leitor(
    [toolCall("registrar_pergunta", { texto: "tem chapa 3mm? quanto o quilo?" })],
    [toolCall("buscar_na_base", { perguntaId: "q1", consulta: "chapa 3mm preço quilo" })],
    [toolCall("responder_pergunta", { perguntaId: "q1", trechoId: "chapas", citacao: "chapa 3 mm a R$ 12 o quilo" })]
  ),
  model: responde("Temos sim! A chapa 3 mm sai a R$ 12 o quilo.", "Temos chapa 3 mm sim. Pra te passar o valor certinho: qual a medida e quantas chapas você precisa?")
}, (run) => [
  { nome: "nao_passou_preco_inventado", ok: !run.historico.some((m: any) => m.autor === "agente" && /R\$ ?12/.test(m.texto)) },
  { nome: "passou_o_preco_para_o_vendedor", ok: /quilo/.test(run.humano?.motivo ?? ""), detalhe: run.humano?.motivo }
]);

await atd("socio", "Follow-up: cliente ia ver com o sócio e sumiu", {
  historicoInicial: conversa(
    "C: quanto fica 30 telhas trapezoidais 0,43 de 6 metros?",
    "E: As 30 telhas TP40 0,43 de 6 m ficam R$ 8.940, pagamento em 28 dias. Retirada ou entrega?",
    "C: vou ver com meu sócio e te falo"
  )
}, {
  analista: (() => { let i = 0; return createScriptedModel("analista", () => ({ content: null, toolCalls: i++ === 0 ? [
    toolCall("classificar_contato", { tipo: "cliente", mensagem: 0, trecho: "quanto fica 30 telhas" }),
    toolCall("abrir_pendencia", { dono: "cliente", descricao: "ia ver as 30 telhas com o sócio", mensagem: 2, trecho: "vou ver com meu sócio" }),
    toolCall("abrir_pendencia", { dono: "cliente", descricao: "ia mandar o CNPJ para faturar", mensagem: 2, trecho: "te mando o CNPJ" })
  ] : [] })); })(),
  model: (() => { let i = 0; return createScriptedModel("escritor", () => ({ content: null, toolCalls: [i++ === 0 ? toolCall("pedir_humano", { motivo: "nao_sei_o_que_dizer" }) : toolCall("responder", { texto: "Oi! Conseguiu ver as 30 telhas TP40 com seu sócio? Se quiser, separo pra retirada." })] })); })()
}, (run) => [
  { nome: "cobrou_o_assunto_certo", ok: run.historico.some((m: any) => m.autor === "agente" && /s[oó]cio/.test(m.texto)) },
  { nome: "nao_inventou_o_cnpj", ok: !run.historico.some((m: any) => m.autor === "agente" && /CNPJ/.test(m.texto)) }
]);

for (const id of ["debora_recusa_educada", "recepcao_nao_decide", "jav_menu"]) {
  const scenario = cenariosJoao.find((c) => c.id === id)!;
  const fake = createFakeProspeccao();
  const run = await runScenario({ agent: prospeccao, deps: { model: fake.escritor, leitor: fake.leitor, triage: createTriage() }, scenario });
  entradas.push({ id, titulo: `João: ${scenario.titulo}`, tentativa: 1, run, checks: scenario.verificar(run) });
}

await writeFile(process.argv[2], renderLinhaDoTempoHtml({ agente: "atendimento e João", modelo: "modelos de teste (sem IA real)", entradas }));
console.log(entradas.map((e) => `${e.id}: ${e.checks.every((c) => c.ok) && !e.run.erro ? "ok" : "falhou"} ${e.run.erro ?? ""}`).join("\n"));
