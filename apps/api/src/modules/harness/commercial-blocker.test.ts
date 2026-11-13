import { describe, expect, it } from "vitest";
import { fichaInicial } from "./agentes/atendimento/ficha.js";
import { decidirJogada } from "./agentes/atendimento/jogadas.js";
import { regras } from "./agentes/atendimento/regras.js";
import { reviewMessage } from "./core/review.js";
import { responderComHarness } from "./agentes/atendimento/producao.js";
import { createScriptedModel, toolCall } from "./core/model.js";
import type { FichaDoAtendimento } from "./agentes/atendimento/tipos.js";

const pedido = { empresa: { nome: "Distribuidora", oQueVende: "Chapas" }, maxFollowups: 3 };
const mensagem = "Se não tiver pronta entrega, fazem sob encomenda?";
const ficha = (): FichaDoAtendimento => ({ ...fichaInicial(), perguntas: [{ id: "q1", texto: mensagem, natureza: "pergunta", status: "sem_base", resposta: null, buscas: 2 }], prequalificacao: { situacao: "coletando", resumo: "5 chapas lambril, medida informada 2.500x1.00", faltantes: ["Cidade"], divergencias: ["Fornecimento sob encomenda sem resposta na base"] } });
const decidir = (f = ficha(), texto = mensagem) => decidirJogada({ ficha: f, pedido, triagem: null, evento: { tipo: "mensagem", texto } });

describe("unanswered commercial questions stop qualification", () => {
  it("hands a searched factual question to a person despite missing city", () => {
    const f = ficha(); const j = decidir(f);
    expect(j.tipo).toBe("responder_e_passar");
    expect(j.avisarHumano).toContain(mensagem);
    expect(j.avisarHumano).toContain("5 chapas");
    expect(j.instrucao).not.toContain("Ainda precisamos de:");
    expect(f.prequalificacao?.resumo).toContain("2.500x1.00");
  });
  it("does not resume the form when the next customer message only gives quantity", () => {
    const j = decidir(ficha(), "5 chapas");
    expect(j.avisarHumano).toBeTruthy();
  });
  it("keeps a quote/specification request internal instead of handing off every unknown combination", () => {
    const f = ficha(); f.perguntas[0].natureza = "solicitacao";
    expect(decidir(f).avisarHumano).toBeUndefined();
  });
  it("preserves a confirmed answer, a genuine refusal and a customer closing", () => {
    const f = ficha(); f.perguntas[0] = { ...f.perguntas[0], status: "respondida", resposta: { trechoId: "t1", citacao: "Fornecemos chapas sob encomenda." } };
    expect(decidir(f).avisarHumano).toBeUndefined();
    f.perguntas[0].resposta!.citacao = "Não fornecemos telhas.";
    expect(decidir(f).tipo).toBe("responder_recusa");
    expect(decidirJogada({ ficha: ficha(), pedido, triagem: { kind: "recusa", fonte: "regras", motivo: "Recusou" }, evento: { tipo: "mensagem", texto: "Não, obrigada" } }).tipo).toBe("encerrar");
  });
  it.each([
    "Ainda não consigo confirmar se fazemos sob encomenda. Quantas chapas precisa?",
    "Não sei informar se trabalhamos com chapa lambril.",
    "Não tenho essa informação. Em qual cidade será a entrega?",
    "A disponibilidade desse produto ainda não está definida. Qual a cidade?",
    "Vou passar ao vendedor porque não consigo confirmar o fornecimento."
  ])("blocks personal inability, including during an actual handoff: %s", async texto => {
    expect(await reviewMessage({ texto, ficha: ficha(), pedido, historico: [], jogada: decidir(), rules: regras, fichaTexto: "" })).toMatchObject({ ok: false, regra: "sem_expor_desconhecimento" });
  });
  it("blocks more form questions during the commercial handoff", async () => {
    expect(await reviewMessage({ texto: "Vou encaminhar ao vendedor. Qual a cidade?", ficha: ficha(), pedido, historico: [], jogada: decidir(), rules: regras, fichaTexto: "" })).toMatchObject({ ok: false, regra: "repasse_sem_coleta" });
  });
  it.each(["Não fornecemos telhas.", "O mínimo é de aproximadamente 1.000 kg. Essas condições atendem?", "Vou encaminhar seu pedido ao vendedor para confirmar o fornecimento dessas chapas."])("preserves truthful conditions and a useful handoff: %s", async texto => {
    expect(await reviewMessage({ texto, ficha: ficha(), pedido, historico: [], jogada: texto.includes("?") ? { tipo: "qualificar_com_pendencias", instrucao: "Informar condição aprovada" } : decidir(), rules: regras, fichaTexto: "" })).toMatchObject({ ok: true });
  });
});

const em = "2026-11-13T13:17:25Z";
describe("commercial handoff production adapter", () => {
  it("creates the real handoff actions and preserves the received order", async () => {
    let readingRound = 0;
    const model = createScriptedModel("commercial-test", req => {
      if (req.tools?.some(t => t.name === "registrar_pergunta")) {
        const calls = [
          [toolCall("registrar_pergunta", { texto: mensagem, natureza: "pergunta" })],
          [toolCall("buscar_na_base", { perguntaId: "q1", consulta: "chapa lambril encomenda" })],
          [toolCall("marcar_sem_base", { perguntaId: "q1" }), toolCall("registrar_prequalificacao", { situacao: "coletando", resumo: "5 chapas lambril, medida original 2.500x1.00", faltantes: ["Cidade"], divergencias: ["Confirmar fornecimento sob encomenda"] })],
          []
        ];
        return { content: null, toolCalls: calls[readingRound++] ?? [] };
      }
      return { content: null, toolCalls: [toolCall("responder", { texto: "Vou encaminhar seu pedido ao vendedor para confirmar o fornecimento dessas chapas." })] };
    });
    const result = await responderComHarness({ config: { agente: "atendimento", canais: ["canal"] }, model, fontes: [{ id: "base", title: "Linha", content: "Fornecemos chapas lisas." }], mensagens: [{ id: "m1", autor: "contato", tipo: "text", texto: mensagem, em }], atual: { id: "m1", texto: mensagem, em }, sessionMetadata: {} });
    expect(result.handoff.required).toBe(true);
    expect(result.actions.map(a => a.type)).toEqual(["create_internal_note", "request_handoff"]);
    expect(result.reply).not.toMatch(/não consigo|não sei|não tenho/i);
    expect(result.ficha.prequalificacao?.resumo).toContain("2.500x1.00");
    expect(result.actions[0].body).toContain("5 chapas");
  });
  it("still hands off when a legacy or incomplete reader record missed the direct question", async () => {
    let writingRound = 0;
    const model = createScriptedModel("commercial-fallback", req => {
      if (req.tools?.some(t => t.name === "registrar_pergunta")) return { content: null, toolCalls: [] };
      return { content: null, toolCalls: [writingRound++ === 0
        ? toolCall("responder", { texto: "Ainda não consigo confirmar se fazemos sob encomenda. Quantas chapas precisa?" })
        : toolCall("pedir_humano", { motivo: "duvida_sem_resposta", detalhe: "Confirmar fornecimento de chapa lambril", mensagemAoContato: "Vou encaminhar ao vendedor para confirmar o fornecimento de chapa lambril." })] };
    });
    const result = await responderComHarness({ config: { agente: "atendimento", canais: ["canal"] }, model, fontes: [], mensagens: [{ id: "m1", autor: "contato", tipo: "text", texto: mensagem, em }], atual: { id: "m1", texto: mensagem, em }, sessionMetadata: {} });
    expect(writingRound).toBe(2);
    expect(result.handoff.required).toBe(true);
    expect(result.actions.some(a => a.type === "request_handoff")).toBe(true);
    expect(result.reply).not.toContain("não consigo");
  });
});
