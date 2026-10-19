import { describe, expect, it } from "vitest";
import { createJuizDeFollowup } from "./agentes/atendimento/juiz.js";
import { atendimento } from "./agentes/atendimento/index.js";
import { fichaInicial } from "./agentes/atendimento/ficha.js";
import { createScriptedModel, toolCall } from "./core/model.js";
import { runTurn } from "./core/runner.js";
import { reviewMessage, type JudgeInput } from "./core/review.js";
import type { JevClient } from "./core/jev.js";

const historico = [
  { autor: "contato" as const, texto: "Preciso de tubo galvanizado 20x40.", em: "2026-10-01T12:00:00Z" },
  { autor: "humano" as const, texto: "O mínimo para seu pedido é 500 kg.", em: "2026-10-01T12:01:00Z" },
  ...Array.from({ length: 24 }, (_, i) => ({ autor: "humano" as const, texto: `Mensagem de contexto ${i}`, em: "2026-10-01T12:02:00Z" }))
];
const ficha = { ...fichaInicial(), pendencias: [{ id: "p1", dono: "cliente" as const, descricao: "Retomar o tubo galvanizado 20x40", prova: { mensagem: 0, trecho: historico[0].texto }, status: "aberta" as const, resolvidaPor: null }] };
const pedido = { empresa: { nome: "Empresa", oQueVende: "Aço" }, maxFollowups: 3 };
const input: JudgeInput = { texto: "Oi! O mínimo de 500 kg que conversamos atende ao seu pedido de tubo 20x40?", historico, ficha, fichaTexto: "Tubo galvanizado em negociação", pedido, pedidoTexto: "Base geral: mínimo 1.000 kg", jogada: { tipo: "cobrar_pendencia", instrucao: "Retomar o tubo galvanizado 20x40" } };

function reviewer(result: string, capture?: (state: Record<string, unknown>) => void): JevClient {
  return { ask: async (state, questions) => {
    capture?.(state);
    return Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === "choice" ? { type: "choice", choice: result } : { type: "noul", noul: key === "inventa" ? 0.01 : 0.99 }]));
  } };
}

describe("sales reactivation", () => {
  it("shows the reviewer the seller condition even outside the last twelve messages", async () => {
    let received: Record<string, unknown> = {};
    expect(await createJuizDeFollowup(reviewer("adequada", state => { received = state; }))(input)).toMatchObject({ ok: true });
    expect(JSON.stringify(received)).toContain("O mínimo para seu pedido é 500 kg");
  });

  it.each([
    ["contradiz_negociacao", "condição"],
    ["cobra_empresa", "empresa"],
    ["insiste_recusa", "recusa"],
    ["sem_contexto", "item"]
  ])("explains the concrete rejection %s", async (result, expected) => {
    expect(await createJuizDeFollowup(reviewer(result))(input)).toMatchObject({ ok: false, motivo: expect.stringContaining(expected) });
  });

  it("fails closed for an invalid reviewer verdict", async () => {
    expect(await reviewMessage({ ...input, rules: [], judge: createJuizDeFollowup(reviewer("unknown")) })).toMatchObject({ ok: false, regra: "juiz_indisponivel" });
  });

  it("lets the follow-up writer see the original request and the seller terms", async () => {
    let writerContext = "";
    const model = createScriptedModel("writer", request => {
      writerContext = JSON.stringify(request.messages);
      return { content: null, toolCalls: [toolCall("responder", { texto: "Oi! Ainda precisa do tubo galvanizado 20x40?" })] };
    });
    const analista = createScriptedModel("analyst", () => ({ content: null, toolCalls: [] }));
    const result = await runTurn(atendimento, { model, analista }, { ficha, pedido, historico, evento: { tipo: "silencio", horasSemResposta: 48 } });
    expect(result.enviar).toContain("tubo galvanizado");
    expect(writerContext).toContain("O mínimo para seu pedido é 500 kg");
  });

  it("keeps several attempts on the same opportunity but stops at the configured limit", () => {
    const decide = (sent: number) => atendimento.decidirJogada({ ficha: { ...ficha, followups: Array.from({ length: sent }, (_, i) => ({ texto: `Tentativa ${i}`, pendenciaId: "p1" })) }, pedido, triagem: null, evento: { tipo: "silencio", horasSemResposta: 48 } });
    expect(decide(2).tipo).toBe("cobrar_pendencia");
    expect(decide(3).tipo).toBe("limite_de_tentativas");
  });

  it("does not let an older company task hide a newer quote awaiting the buyer", () => {
    const oldTask = { ...ficha.pendencias[0], id: "old", dono: "empresa" as const, descricao: "Responder um orçamento antigo de outro item" };
    const quote = { ...ficha.pendencias[0], id: "new", prova: { mensagem: 20, trecho: "Obrigado pelo orçamento novo, vou avaliar" } };
    const decide = (companyMessage: number) => atendimento.decidirJogada({ ficha: { ...ficha, pendencias: [{ ...oldTask, prova: { ...oldTask.prova, mensagem: companyMessage } }, quote] }, pedido, triagem: null, evento: { tipo: "silencio", horasSemResposta: 48 } });
    expect(decide(0)).toMatchObject({ tipo: "cobrar_pendencia", dados: { pendenciaId: "new" } });
    expect(decide(21).tipo).toBe("lembrete_vendedor");
  });

  it("preserves the live reply window", async () => {
    let received = "";
    const model = createScriptedModel("writer", request => {
      received = JSON.stringify(request.messages);
      return { content: null, toolCalls: [toolCall("responder", { texto: "Bom dia! Como posso ajudar?" })] };
    });
    await runTurn({ ...atendimento, ferramentasDeLeitura: [], decidirJogada: () => ({ tipo: "conversar", instrucao: "Cumprimente." }) },
      { model }, { ficha: fichaInicial(), pedido, historico, evento: { tipo: "mensagem", texto: "Bom dia" } });
    expect(received).not.toContain("O mínimo para seu pedido é 500 kg");
    expect(received).toContain("Responda primeiro ao que o contato acabou de dizer");
  });

  it("does not turn other agents' openings into sales reactivation", async () => {
    let received = "";
    const model = createScriptedModel("writer", request => {
      received = JSON.stringify(request.messages);
      return { content: null, toolCalls: [toolCall("responder", { texto: "Bom dia! Como posso ajudar?" })] };
    });
    await runTurn({ ...atendimento, janelaDoFollowup: undefined, decidirJogada: () => ({ tipo: "abrir", instrucao: "Cumprimente." }) },
      { model }, { ficha: fichaInicial(), pedido, historico: [], evento: { tipo: "abertura" } });
    expect(received).not.toContain("Escreva uma retomada curta sobre a negociação parada");
  });
});
