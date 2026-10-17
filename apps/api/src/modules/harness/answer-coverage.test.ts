import { describe, expect, it } from "vitest";
import { atendimento } from "./agentes/atendimento/index.js";
import { fichaInicial } from "./agentes/atendimento/ficha.js";
import { conferirLeitura } from "./agentes/atendimento/ferramentas.js";
import type { FichaDoAtendimento } from "./agentes/atendimento/tipos.js";
import { reviewMessage } from "./core/review.js";
import { createJuizDeAtendimento } from "./agentes/atendimento/juiz.js";
import { aposEnvio } from "./agentes/atendimento/jogadas.js";
import { lacunasDaBase, soSaudacaoOuOferta } from "./agentes/atendimento/cobertura.js";
import { createScriptedModel, toolCall } from "./core/model.js";
import { runTurn } from "./core/runner.js";
import type { JevClient } from "./core/jev.js";

const pergunta = "Vcs vendem chapa de alumínio xadrez?";
const generico = "Produtos inox e alumínio: somente sob encomenda; identificar produto/família antes de assumir oferta.";
const especifico = "Chapa de piso de alumínio: sob encomenda, prazo de 5 a 10 dias úteis, tamanho padrão 1250x3000.";
const omitida = "Boa tarde! Tudo bem, e você? Prefere ver o catálogo em PDF ou falar com um vendedor?";
function ficha(): FichaDoAtendimento {
  return { ...fichaInicial(), trechosVistos: { t1: especifico, t26: generico }, perguntas: [
    { id: "q1", texto: pergunta, status: "respondida", buscas: 1, resposta: { trechoId: "t26", citacao: generico } }
  ] };
}
const pedido = { empresa: { nome: "Distribuidora", oQueVende: "Chapas" }, maxFollowups: 2 };
const historico = [{ autor: "contato" as const, texto: pergunta, em: "2026-10-17T23:04:00Z" }];
const jogada = { tipo: "responder", instrucao: "Responda sobre o produto antes de oferecer o catálogo." };
function completa() {
  const f = ficha();
  f.perguntas[0].maisRespostas = [{ trechoId: "t1", citacao: especifico }];
  return f;
}
const boa = "Boa tarde, fornecemos chapa de piso de alumínio sob encomenda. Qual quantidade precisa?";
const judgeInput = (texto = boa, f = completa()) => ({ texto, ficha: f, pedido, historico, jogada, fichaTexto: "" });
function jev(scores: Record<string, number> = {}): JevClient {
  return { ask: async (_state, questions) => Object.fromEntries(Object.keys(questions).map(k => [k, { type: "noul", noul: scores[k] ?? (k === "inventa" ? 0.01 : 0.95) }])) };
}

describe("coverage of a live attendance answer", () => {
  it("asks the reader to use the product-specific passage instead of stopping at the material policy", () => {
    expect(conferirLeitura({ ficha: ficha(), mensagem: pergunta, pedido })).toMatch(/q1.*t1/s);
  });
  it("blocks the exact greeting and catalogue-only response observed in production", async () => {
    expect(await reviewMessage({ texto: omitida, ficha: ficha(), pedido, historico,
      jogada: { tipo: "responder", instrucao: "Responda sobre o produto antes de oferecer o catálogo." },
      rules: atendimento.regras, fichaTexto: "" })).toMatchObject({ ok: false, regra: "resposta_omitida" });
  });
  it("accepts complementary evidence and does not mechanically insert a passage", () => {
    expect(lacunasDaBase(completa())).toBeNull();
    const f = ficha();
    lacunasDaBase(f);
    expect(f.perguntas[0].maisRespostas).toBeUndefined();
  });
  it.each([boa, "Fornecemos sim, por encomenda.", "Boa tarde, essa chapa é fornecida sob encomenda.", "Sim, fornecemos sob encomenda, prefere ver o catálogo?"])("does not confuse an answer with a greeting: %s", texto => {
    expect(soSaudacaoOuOferta(texto)).toBe(false);
  });
  it("keeps open and unconfirmed questions out of the treated state", () => {
    const f = completa();
    f.perguntas.push({ id: "q2", texto: "Quanto custa?", status: "aberta", buscas: 0, resposta: null });
    const result = aposEnvio({ ficha: f, jogada, texto: boa });
    expect(result.perguntas.map(p => p.status)).toEqual(["tratada", "aberta"]);
    expect(aposEnvio({ ficha: f, jogada, texto: omitida }).perguntas.map(p => p.status)).toEqual(["respondida", "aberta"]);
  });
  it("does not mark a question without evidence as handled unless handed to a person", () => {
    const f = completa(); f.perguntas[0].status = "sem_base";
    expect(aposEnvio({ ficha: f, jogada, texto: "Qual material precisa?" }).perguntas[0].status).toBe("sem_base");
    expect(aposEnvio({ ficha: f, jogada: { ...jogada, avisarHumano: "Sem preço na base" }, texto: "O vendedor confirma o preço." }).perguntas[0].status).toBe("tratada");
  });
  it("records the catalogue offer only when it was actually written", () => {
    const move = { ...jogada, dados: { ofereceCatalogo: true } };
    expect(aposEnvio({ ficha: completa(), jogada: move, texto: boa }).catalogoOferecido).toBe(false);
    expect(aposEnvio({ ficha: completa(), jogada: move, texto: `${boa} Prefere ver o catálogo?` }).catalogoOferecido).toBe(true);
  });
  it("rejects the real production scores with the live attendance judge", async () => {
    expect(await createJuizDeAtendimento(jev({ segue: .23, responde: .29, inventa: .07 }))(judgeInput(omitida))).toMatchObject({ ok: false });
  });
  it("checks every question even when the overall response score is high", async () => {
    const f = completa();
    f.perguntas.push({ ...f.perguntas[0], id: "q2", texto: "Qual o prazo?" });
    expect(await createJuizDeAtendimento(jev({ resposta_2: .1 }))(judgeInput(boa, f))).toMatchObject({ ok: false, regra: "juiz_resposta_incompleta", motivo: expect.stringContaining("q2"), notas: { cobertura_q2: .1 } });
  });
  it("allows a grounded paraphrase and records question coverage in the trace scores", async () => {
    expect(await createJuizDeAtendimento(jev())(judgeInput())).toMatchObject({ ok: true, notas: { cobertura_q1: .95 } });
  });
  it("missing coverage scores fail closed", async () => {
    const missing: JevClient = { ask: async () => ({ inventa: { type: "noul", noul: 0 }, segue: { type: "noul", noul: 1 }, responde: { type: "noul", noul: 1 } }) };
    expect(await createJuizDeAtendimento(missing)(judgeInput())).toMatchObject({ ok: false, regra: "juiz_resposta_incompleta" });
  });
  it("rewrites the omitted answer before treating the question", async () => {
    let writes = 0;
    const result = await runTurn(atendimento, {
      leitor: createScriptedModel("reader", () => ({ content: null, toolCalls: [] })),
      model: createScriptedModel("writer", () => ({ content: null, toolCalls: [toolCall("responder", { texto: writes++ ? boa : omitida })] }))
    }, { ficha: completa(), pedido, historico, evento: { tipo: "mensagem", texto: pergunta } });
    expect(result.enviar).toBe(boa);
    expect(result.ficha.perguntas[0].status).toBe("tratada");
    expect(result.trace.filter(s => s.fase === "escrita")).toHaveLength(2);
    expect(result.trace).toContainEqual(expect.objectContaining({ fase: "revisao", detalhe: expect.objectContaining({ regra: "resposta_omitida" }) }));
  });
  it("two omitted answers hand off and preserve the question", async () => {
    const result = await runTurn(atendimento, {
      leitor: createScriptedModel("reader", () => ({ content: null, toolCalls: [] })),
      model: createScriptedModel("writer", () => ({ content: null, toolCalls: [toolCall("responder", { texto: omitida })] }))
    }, { ficha: completa(), pedido, historico, evento: { tipo: "mensagem", texto: pergunta } });
    expect(result.humano).toBeTruthy();
    expect(result.enviar).not.toBe(omitida);
    expect(result.ficha.perguntas[0].status).toBe("respondida");
  });
  it("an unresolved generic reading cannot reach the writer", async () => {
    let writes = 0;
    const result = await runTurn(atendimento, {
      leitor: createScriptedModel("reader", () => ({ content: null, toolCalls: [] })),
      model: createScriptedModel("writer", () => { writes++; return { content: null, toolCalls: [] }; })
    }, { ficha: ficha(), pedido, historico, evento: { tipo: "mensagem", texto: pergunta } });
    expect(writes).toBe(0);
    expect(result.humano?.motivo).toMatch(/Leitura incompleta/);
    expect(result.ficha.perguntas[0].status).toBe("respondida");
  });
  it("reviewer outage hands off without treating the question", async () => {
    const result = await runTurn(atendimento, {
      leitor: createScriptedModel("reader", () => ({ content: null, toolCalls: [] })),
      model: createScriptedModel("writer", () => ({ content: null, toolCalls: [toolCall("responder", { texto: boa })] })),
      judge: createJuizDeAtendimento({ ask: async () => { throw Error("unavailable"); } }), judgeFailClosed: true
    }, { ficha: completa(), pedido, historico, evento: { tipo: "mensagem", texto: pergunta } });
    expect(result.humano).toBeTruthy();
    expect(result.ficha.perguntas[0].status).toBe("respondida");
  });
});
