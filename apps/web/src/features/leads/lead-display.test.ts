import { describe, expect, it } from "vitest";
import { formatCnpj, jobLabels, listProgressLabel, scoreReasons, searchOriginLabel, whatsappLabels } from "./lead-display";

describe("lead display", () => {
  it("formats numeric and alphanumeric CNPJs as identifiers", () => {
    expect(formatCnpj("12345678000190")).toBe("12.345.678/0001-90");
    expect(formatCnpj("AB345678000190")).toBe("AB.345.678/0001-90");
    expect(formatCnpj(null)).toBe("CNPJ não informado");
  });

  it("keeps status language explicit until verification is complete", () => {
    expect(whatsappLabels.unverified).toBe("Não verificado");
    expect(whatsappLabels.available).toBe("Disponível");
    expect(jobLabels.partial).toBe("Parcial");
    expect(jobLabels.failed).toBe("Falhou");
  });

  it("shows the term and city each Maps lead came from", () => {
    expect(searchOriginLabel({ term: "metalúrgica", city: "Jaraguá do Sul", expanded: true })).toBe("Termo: metalúrgica · Cidade: Jaraguá do Sul");
    expect(searchOriginLabel({ term: "caldeiraria", city: null, expanded: true })).toBe("Termo: caldeiraria · Região próxima");
  });

  it("presents score reasons with individual contribution", () => {
    expect(scoreReasons({ reasons: [{ key: "location_same_city", label: "Mesma cidade", points: 20 }] })).toEqual(["Mesma cidade (+20)"]);
  });

  it("infers saved-list progress without inventing a failed state", () => {
    expect(listProgressLabel({ startedAt: null, completedAt: null, failedCount: 0 })).toBe("Na fila");
    expect(listProgressLabel({ startedAt: "now", completedAt: null, failedCount: 2 })).toBe("Em andamento");
    expect(listProgressLabel({ startedAt: "now", completedAt: "later", failedCount: 2 })).toBe("Parcial");
  });
});
