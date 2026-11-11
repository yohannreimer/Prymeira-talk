import { describe, expect, it } from "vitest";
import { assessQualityResult, followupQualityCases, qualityMessages } from "./fixtures/followup-quality.js";
import { contextoDosPedidos } from "./agentes/atendimento/contexto-dos-pedidos.js";
import { atendimento } from "./agentes/atendimento/index.js";
import { fichaInicial } from "./agentes/atendimento/ficha.js";
import { createJuizDeFollowup } from "./agentes/atendimento/juiz.js";
import type { FollowupDoHarness } from "./agentes/atendimento/producao.js";

const result = (tipo: FollowupDoHarness["tipo"], text: string): FollowupDoHarness => ({ tipo, texto: text, motivo: text, resumo: text,
  jogada: "test", ficha: fichaInicial(), trace: [] } as FollowupDoHarness);

describe("follow-up order quality regression contract", () => {
  it("covers four failures and fourteen working controls with anonymous fixtures", () => {
    expect(followupQualityCases.filter(c => c.group === "error")).toHaveLength(4);
    expect(followupQualityCases.filter(c => c.group === "control")).toHaveLength(14);
    expect(new Set(followupQualityCases.map(c => c.id)).size).toBe(18);
    for (const item of followupQualityCases) expect(qualityMessages(item).at(-1)?.texto).toBe(item.rows.at(-1)?.[1]);
  });

  it.each([
    ["separate-old-and-new-angle", "mensagem", "Qual largura das2cantoneirasde5mm?"],
    ["exclude-refused-tubes-from-mixed-order", "mensagem", "Quais espessuras e quantidades de cantoneiras,chatas e tubos?"],
    ["unavailable-sheet-format", "lembrete_vendedor", "Enviar cotação de chapa0,9mm1500x3000."],
    ["supplier-search-already-answered", "lembrete_vendedor", "Identificar e cotar as vigas solicitadas."]
  ] as const)("rejects the observed bad behaviour: %s", (id, type, text) => {
    expect(assessQualityResult(followupQualityCases.find(c => c.id === id)!, result(type, text)).passed).toBe(false);
  });

  it("passes the same order constraints to analyst, writer and reviewer", async () => {
    expect(atendimento.analista!.instrucoes).toContain(contextoDosPedidos);
    expect(atendimento.skills.followup).toContain(contextoDosPedidos);
    let instructions = "";
    const judge = createJuizDeFollowup({ ask: async (_state, questions) => {
      instructions = questions.retomada.instructions;
      return { retomada: { type: "choice", choice: "mistura_pedidos" } };
    } });
    expect(await judge({ texto: "Qual largura das cantoneiras antigas?", fichaTexto: "", ficha: fichaInicial(), pedido: {},
      historico: [], jogada: { tipo: "cobrar_pendencia", instrucao: "Retomar item" } })).toMatchObject({ ok: false, motivo: expect.stringContaining("pedidos distintos") });
    expect(instructions).toContain(contextoDosPedidos);
  });
});
