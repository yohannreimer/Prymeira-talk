import { describe, expect, it } from "vitest";
import { avaliarSemana, rotularFollowup, type CasoDaSemana } from "./agentes/atendimento/avaliacao.js";
import { createScriptedModel, toolCall } from "./core/model.js";

const agora = new Date("2026-10-17T09:00:00.000Z");
const base = { kind: "human_commercial", status: "sent", draftBody: "Conseguiu ver o orçamento?", finalBody: "Conseguiu ver o orçamento?", sentByUserId: null, sentAt: new Date("2026-10-12T12:00:00.000Z"), cancelledByUserId: null, respostaEm: null };

describe("weekly follow-up evaluation", () => {
  it("labels each follow-up by what the seller or the contact did", () => {
    expect(rotularFollowup({ ...base, sentByUserId: "u1" }, agora)).toBe("aprovado");
    expect(rotularFollowup({ ...base, sentByUserId: "u1", finalBody: "Oi! Conseguiu ver o orçamento 103148?" }, agora)).toBe("editado");
    expect(rotularFollowup({ ...base, status: "cancelled", cancelledByUserId: "u1", sentAt: null }, agora)).toBe("descartado");
    expect(rotularFollowup({ ...base, status: "cancelled", sentAt: null }, agora)).toBeNull();
    expect(rotularFollowup({ ...base, respostaEm: new Date("2026-10-12T15:00:00.000Z") }, agora)).toBe("respondeu");
    expect(rotularFollowup(base, agora)).toBe("sem_resposta");
    expect(rotularFollowup({ ...base, sentAt: new Date("2026-10-16T12:00:00.000Z") }, agora)).toBeNull();
    expect(rotularFollowup({ ...base, kind: "seller_reminder", sentByUserId: "u1" }, agora)).toBeNull();
  });

  it("reviews the discarded drafts, proposes a rule and tries it on the week's cases before anyone approves it", async () => {
    const caso = (followupId: string, rotulo: CasoDaSemana["rotulo"]): CasoDaSemana => ({
      followupId, conversationId: `c-${followupId}`, decididoEm: "2026-10-14T12:00:00.000Z", rotulo,
      rascunho: "Conseguiu ver a entrega de segunda?", enviado: null, resposta: null,
      ultimas: [{ autor: "contato", texto: "chega quando?" }, { autor: "agente", texto: "Segunda-feira" }]
    });
    const revisor = createScriptedModel("revisor", (request) => {
      const ferramenta = request.tools?.[0]?.name;
      if (ferramenta === "registrar_avaliacao") return { content: null, toolCalls: [toolCall("registrar_avaliacao", { tipo: "nao_devia", explicacao: "A entrega já estava combinada." })] };
      return { content: null, toolCalls: [toolCall("propor_regras", { regras: [{ regra: "Não mande follow-up sobre entrega já combinada.", porque: "Pós-venda não é venda parada.", casos: ["f1", "inventado"] }] })] };
    });
    const refeitos: Array<{ id: string; regras: string[] }> = [];
    const resultado = await avaliarSemana({
      casos: [caso("f1", "descartado"), caso("f2", "aprovado")],
      decisoes: { mensagem: 2, lembrete: 1, nada: 4 },
      revisor,
      regrasAtuais: [],
      refazer: async (item, regras) => {
        refeitos.push({ id: item.followupId, regras });
        return item.followupId === "f1" && regras.length ? "nada" : "mensagem";
      }
    });
    expect(resultado.casos.find((item) => item.followupId === "f1")?.erro).toEqual({ tipo: "nao_devia", explicacao: "A entrega já estava combinada." });
    expect(resultado.casos.find((item) => item.followupId === "f2")?.erro).toBeUndefined();
    expect(resultado.propostas).toEqual([expect.objectContaining({
      id: "r1", regra: "Não mande follow-up sobre entrega já combinada.", casos: ["f1"], status: "pendente",
      validacao: { corrige: 1, erradosTestados: 1, quebra: 0, bonsTestados: 1 }
    })]);
    // Each case also runs once without the rule, the baseline the rule is measured against.
    expect(refeitos).toEqual([
      { id: "f1", regras: [] },
      { id: "f1", regras: ["Não mande follow-up sobre entrega já combinada."] },
      { id: "f2", regras: [] },
      { id: "f2", regras: ["Não mande follow-up sobre entrega já combinada."] }
    ]);
    expect(resultado.resumo).toMatchObject({ aprovacao: 0.5, resposta: null, erros: { nao_devia: 1, assunto: 0, texto: 0 }, decisoes: { mensagem: 2, lembrete: 1, nada: 4 } });
  });
});
