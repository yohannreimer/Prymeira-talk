import { describe, expect, it } from "vitest";
import snapshots from "./fixtures/round1-reading.json" with { type: "json" };
import { atendimento } from "./agentes/atendimento/index.js";
import { fichaInicial } from "./agentes/atendimento/ficha.js";
import { regras } from "./agentes/atendimento/regras.js";
import { createJuizDeAtendimento } from "./agentes/atendimento/juiz.js";
import { createScriptedModel, toolCall } from "./core/model.js";
import { runTurn } from "./core/runner.js";
import { reviewMessage } from "./core/review.js";
import type { FichaDoAtendimento } from "./agentes/atendimento/tipos.js";

describe("round 2: context before lexical similarity", () => {
  it.each(snapshots)("allows the writer to handle the grounded reading: $title", async (s) => {
    const result = await runTurn(atendimento, {
      leitor: createScriptedModel("reader", () => ({content:null,toolCalls:[]})),
      model: createScriptedModel("writer", () => ({content:null,toolCalls:[toolCall("responder",{texto:"O vendedor confirma a especificação pendente. Sobre o item não fornecido, não trabalhamos com ele."})]})),
      judge: async () => ({ok:true})
    }, {ficha:s.ficha as unknown as FichaDoAtendimento,pedido:{empresa:{nome:"Distribuidora",oQueVende:"Chapas"},maxFollowups:2},historico:[{autor:"contato",texto:s.input,em:"2026-10-18T01:00:00Z"}],evento:{tipo:"mensagem",texto:s.input}});
    expect(result.trace.some(t=>t.fase==="escrita")).toBe(true);
    expect(result.humano?.motivo??"").not.toMatch(/Leitura incompleta/);
  });
  it.each([
    {before:"O pedido mínimo de alumínio é de aproximadamente 300 kg, mas o vendedor avalia pedidos menores.", now:"Qual o prazo e tem pedido mínimo?",reply:"O pedido mínimo de alumínio é de aproximadamente 300 kg, mas o vendedor avalia pedidos menores."},
    {before:"Para o vendedor cotar, qual medida da chapa você precisa?",now:"Pode cotar 300 kg então. Quero saber o valor antes de fechar.",reply:"Para o vendedor cotar, qual medida da chapa você precisa?"}
  ])("permits answering a renewed question or clarifying a still missing measurement", async s=>{
    const result=await reviewMessage({texto:s.reply,ficha:fichaInicial(),pedido:{empresa:{nome:"Distribuidora",oQueVende:"Chapas"},maxFollowups:2},jogada:{tipo:"responder",instrucao:""},historico:[{autor:"agente",texto:s.before,em:"2026-10-18T01:00:00Z"},{autor:"contato",texto:s.now,em:"2026-10-18T01:01:00Z"}],rules:regras,fichaTexto:"",judge:async()=>({ok:true})});
    expect(result.ok).toBe(true);
  });
  it("asks the judge to identify unnecessary repetition in the context of the latest request", async()=>{
    let asked:any;
    await createJuizDeAtendimento({ask:async (_state,questions)=>{asked=questions;return Object.fromEntries(Object.entries(questions).map(([id,q])=>[id,q.type==="choice"?{type:"choice",choice:Object.keys(q.criteria)[0]}:{type:"noul",noul:0}]))}})({texto:"Qual medida?",ficha:fichaInicial(),pedido:{empresa:{nome:"Distribuidora",oQueVende:"Chapas"},maxFollowups:2},jogada:{tipo:"responder",instrucao:"deixar o pedido pronto para orçar"},historico:[],fichaTexto:""});
    expect(asked.repeticao.instructions).toMatch(/perguntou novamente/);
    expect(asked.dado_medida.instructions).toMatch(/pergunta anterior.*sem resposta/);
  });
});
