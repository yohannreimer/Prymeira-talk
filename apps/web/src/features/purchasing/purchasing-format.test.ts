import { describe, expect, it } from "vitest";
import { parseMoney } from "./format";
import { parseSheetDate, pricesFromSheet, suppliersFromSheet } from "./spreadsheet-map";
import { availableTalkModules } from "../shell/moduleRegistry";

describe("Orçamentos helpers", () => {
  it("reads money the way people type it in Brazil", () => {
    expect(parseMoney("845")).toBe(84_500);
    expect(parseMoney("845,5")).toBe(84_550);
    expect(parseMoney("1.234,56")).toBe(123_456);
    expect(parseMoney("R$ 18.000")).toBe(1_800_000);
    expect(parseMoney("12.50")).toBe(1_250);
    expect(parseMoney("abc")).toBeNull();
  });

  it("finds supplier and price columns by their Portuguese names", () => {
    const suppliers = suppliersFromSheet([["Fornecedor", "WhatsApp", "Cidade", "Categorias"], ["Móveis Silva", "(47) 99999-0001", "Gaspar", "móveis; escritório"], ["", "1", "", ""]]);
    expect(suppliers.rows).toEqual([expect.objectContaining({ name: "Móveis Silva", phone: "(47) 99999-0001", city: "Gaspar", categories: ["móveis", "escritório"] })]);
    expect(suppliersFromSheet([["Nome"], ["x"]]).missing).toEqual(["WhatsApp/telefone"]);
    const prices = pricesFromSheet([["Item", "Fornecedor", "Preço unitário", "Data"], ["Cadeira", "Silva", "R$ 780,00", "10/03/2026"], ["Mesa", "", "x", "10/03/2026"]]);
    expect(prices.rows).toEqual([expect.objectContaining({ itemName: "Cadeira", unitPriceCents: 78_000, paidAt: "2026-03-10" })]);
    expect(prices.skipped).toBe(1);
    expect(parseSheetDate("46091")).toBe("2026-03-10");
  });

  it("only shows the Orçamentos tab when the Hub released the add-on", () => {
    expect(availableTalkModules(undefined).some((module) => module.key === "orcamentos")).toBe(false);
    expect(availableTalkModules({ orcamentos: true }).some((module) => module.key === "orcamentos")).toBe(true);
  });
});
