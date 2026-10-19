import { describe, expect, it, vi } from "vitest";
import { createNearbyCitiesLookup, parseIbgeMunicipalities } from "./nearby-cities.js";

function ibgeResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const santaCatarina = [
  { "municipio-id": 4206504, "municipio-nome": "Guaramirim", "regiao-imediata-id": 420004 },
  { "municipio-id": 4208906, "municipio-nome": "Jaraguá do Sul", "regiao-imediata-id": 420004 },
  { "municipio-id": 4204509, "municipio-nome": "Corupá", "regiao-imediata-id": 420004 },
  { "municipio-id": 4209102, "municipio-nome": "Joinville", "regiao-imediata-id": 420003 }
];

describe("Nearby cities lookup", () => {
  it("returns the other cities of the same IBGE immediate region and caches the state list", async () => {
    const fetch = vi.fn(async () => ibgeResponse(santaCatarina));
    const lookup = createNearbyCitiesLookup({ fetch: fetch as never });

    await expect(lookup.nearby("guaramirim", "sc")).resolves.toEqual(["Jaraguá do Sul", "Corupá"]);
    await expect(lookup.nearby("Joinville", "SC")).resolves.toEqual([]);
    await expect(lookup.nearby("Cidade Inexistente", "SC")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      "https://servicodados.ibge.gov.br/api/v1/localidades/estados/SC/municipios?view=nivelado"
    );
  });

  it("accepts the nested IBGE format and falls back to the micro-region", () => {
    expect(parseIbgeMunicipalities([
      { nome: "Guaramirim", "regiao-imediata": { id: 420004 } },
      { nome: "Antiga", microrregiao: { id: 42008 } },
      { nome: "Sem região" },
      "invalid"
    ])).toEqual([
      { name: "Guaramirim", groupId: "420004" },
      { name: "Antiga", groupId: "42008" }
    ]);
  });

  it("surfaces IBGE failures so the caller can continue without nearby cities", async () => {
    const lookup = createNearbyCitiesLookup({ fetch: vi.fn(async () => ibgeResponse({}, 503)) as never });
    await expect(lookup.nearby("Guaramirim", "SC")).rejects.toThrow();
    await expect(lookup.nearby("Guaramirim", "S1")).resolves.toEqual([]);
  });
});
