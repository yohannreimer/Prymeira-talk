import { describe, expect, it, vi } from "vitest";
import { CityGeocoderError, CityGeocoderThrottle, createCityGeocoder } from "./city-geocoder.js";

function nominatimResult(overrides: Record<string, unknown> = {}) {
  return {
    lat: "-22.90556",
    lon: "-47.06083",
    display_name: "Campinas, Região Imediata de Campinas, SP, Brasil",
    type: "city",
    addresstype: "city",
    address: {
      city: "Campinas",
      state: "São Paulo",
      "ISO3166-2-lvl4": "BR-SP",
      country_code: "br"
    },
    ...overrides
  };
}

describe("CityGeocoder", () => {
  it("queries city, UF, Brasil with identification and caches the canonical result", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([nominatimResult()]), { status: 200 }));
    let nowMs = 0;
    const geocoder = createCityGeocoder({
      fetch,
      now: () => nowMs,
      sleep: vi.fn(async () => undefined),
      throttle: new CityGeocoderThrottle(),
      userAgent: "PrymeiraTalk-Leads/1.0 (ops@prymeira.example)",
      cacheTtlMs: 60_000
    });

    await expect(geocoder.geocode(" campinas ", "sp")).resolves.toEqual({
      city: "Campinas", state: "SP", latitude: -22.90556, longitude: -47.06083
    });
    nowMs = 20_000;
    await geocoder.geocode("Campinas", "SP");

    expect(fetch).toHaveBeenCalledTimes(1);
    const calls = fetch.mock.calls as unknown as Array<[string | URL | Request, RequestInit?]>;
    const url = new URL(String(calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(url.searchParams.get("q")).toBe("campinas, SP, Brasil");
    expect(url.searchParams.get("countrycodes")).toBe("br");
    expect(new Headers(calls[0]?.[1]?.headers).get("user-agent")).toContain("PrymeiraTalk-Leads");
  });

  it("serializes requests and enforces one request per second", async () => {
    const starts: number[] = [];
    let nowMs = 10_000;
    const sleep = vi.fn(async (ms: number) => { nowMs += ms; });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      starts.push(nowMs);
      const requestedCity = new URL(String(input)).searchParams.get("q")?.startsWith("Valinhos")
        ? "Valinhos"
        : "Campinas";
      return new Response(JSON.stringify([nominatimResult({
        display_name: `${requestedCity}, SP, Brasil`,
        address: { city: requestedCity, "ISO3166-2-lvl4": "BR-SP", country_code: "br" }
      })]), { status: 200 });
    });
    const geocoder = createCityGeocoder({
      fetch,
      now: () => nowMs,
      sleep,
      throttle: new CityGeocoderThrottle(),
      userAgent: "PrymeiraTalk-Leads/1.0 (ops@prymeira.example)"
    });

    await Promise.all([
      geocoder.geocode("Campinas", "SP"),
      geocoder.geocode("Valinhos", "SP")
    ]);

    expect(starts).toEqual([10_000, 11_000]);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("rejects no-result and ambiguous cities instead of choosing the first row", async () => {
    const noResult = createCityGeocoder({
      fetch: vi.fn(async () => new Response("[]", { status: 200 })),
      throttle: new CityGeocoderThrottle(),
      userAgent: "PrymeiraTalk-Leads/1.0 (ops@prymeira.example)"
    });
    await expect(noResult.geocode("Cidade inexistente", "SP")).rejects.toMatchObject({ code: "NO_RESULT" });

    const ambiguous = createCityGeocoder({
      fetch: vi.fn(async () => new Response(JSON.stringify([
        nominatimResult(),
        nominatimResult({ lat: "-22.90", lon: "-47.10", display_name: "Campinas, outro resultado, SP, Brasil" })
      ]), { status: 200 })),
      throttle: new CityGeocoderThrottle(),
      userAgent: "PrymeiraTalk-Leads/1.0 (ops@prymeira.example)"
    });
    await expect(ambiguous.geocode("Campinas", "SP")).rejects.toMatchObject({ code: "AMBIGUOUS" });
  });

  it("rejects malformed or mismatched geocoder responses with actionable typed errors", async () => {
    const malformed = createCityGeocoder({
      fetch: vi.fn(async () => new Response(JSON.stringify([nominatimResult({ lat: "NaN" })]), { status: 200 })),
      throttle: new CityGeocoderThrottle(),
      userAgent: "PrymeiraTalk-Leads/1.0 (ops@prymeira.example)"
    });
    await expect(malformed.geocode("Campinas", "SP")).rejects.toBeInstanceOf(CityGeocoderError);

    const wrongState = createCityGeocoder({
      fetch: vi.fn(async () => new Response(JSON.stringify([nominatimResult({
        address: { city: "Campinas", "ISO3166-2-lvl4": "BR-RJ", country_code: "br" }
      })]), { status: 200 })),
      throttle: new CityGeocoderThrottle(),
      userAgent: "PrymeiraTalk-Leads/1.0 (ops@prymeira.example)"
    });
    await expect(wrongState.geocode("Campinas", "SP")).rejects.toMatchObject({ code: "NO_RESULT" });
  });
});
