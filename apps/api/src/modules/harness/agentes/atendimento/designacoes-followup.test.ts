import { describe, expect, it } from "vitest";
import { regras } from "./regras.js";
import { fichaInicial } from "./ficha.js";

const check = (texto: string, source = "Cotar4vigasW200x26,60de6m.", tipo = "cobrar_pendencia") =>
  regras.find(r => r.id === "designacao_do_followup")?.check({ texto, ficha: fichaInicial(),
    pedido: { empresa: { nome: "Teste", oQueVende: "Aço" }, maxFollowups: 3 },
    historico: [{ autor: "contato", texto: source, em: "2026-11-10T12:00:00Z" }],
    jogada: { tipo, instrucao: "Retomar cotação" } }) ?? { ok: true };

describe("follow-up beam designations", () => {
  it("blocks the observed truncation of26.60to26", () => {
    expect(check("Sobre as4vigasW200x26de6m, quer seguir?")).toMatchObject({ ok: false });
  });
  it.each(["W200x26,60", "W200x26.6", "w 200 × 26,600"])("accepts the equivalent notation %s", ref => {
    expect(check(`Vamos seguir com as vigas ${ref}?`)).toMatchObject({ ok: true });
  });
  it("accepts both original variants in a mixed beam request", () => {
    expect(check("O prazo serve paraW360x64eW360x57,8?", "PrecisoW360x64eW360x57.80.")).toMatchObject({ ok: true });
  });
  it("does not invent a different designation", () => {
    expect(check("Vamos seguir comW200x31,3?")).toMatchObject({ ok: false });
  });
  it("allows a concise reference to the quote without repeating the designation", () => {
    expect(check("Conseguiu avaliar o orçamento das quatro vigas?")).toMatchObject({ ok: true });
  });
  it("leaves live qualification unchanged", () => {
    expect(check("O perfilW150x13atende?", "Preciso de uma viga.", "responder")).toMatchObject({ ok: true });
  });
});
