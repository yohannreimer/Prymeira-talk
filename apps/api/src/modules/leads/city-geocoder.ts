import { z } from "zod";

export type CityGeocoderErrorCode = "NO_RESULT" | "AMBIGUOUS" | "UNAVAILABLE" | "INVALID_RESPONSE";

export class CityGeocoderError extends Error {
  constructor(public readonly code: CityGeocoderErrorCode, message: string) {
    super(message);
    this.name = "CityGeocoderError";
  }
}

export interface GeocodedCity {
  city: string;
  state: string;
  latitude: number;
  longitude: number;
}

const resultSchema = z.object({
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
  address: z.record(z.string(), z.unknown()).optional()
}).passthrough();

type Clock = () => number;
type Sleeper = (milliseconds: number) => Promise<void>;

export class CityGeocoderThrottle {
  private queue = Promise.resolve();
  private lastStartedAt: number | undefined;

  run<T>(operation: () => Promise<T>, now: Clock, sleep: Sleeper): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.lastStartedAt !== undefined) {
        const wait = Math.max(0, 1_000 - (now() - this.lastStartedAt));
        if (wait > 0) await sleep(wait);
      }
      this.lastStartedAt = now();
      return operation();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

const processThrottle = new CityGeocoderThrottle();

export interface CityGeocoderOptions {
  fetch?: typeof globalThis.fetch;
  now?: Clock;
  sleep?: Sleeper;
  cacheTtlMs?: number;
  userAgent?: string;
  endpoint?: string;
  throttle?: CityGeocoderThrottle;
}

function normalizeText(value: string) {
  return value.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
}

function stateFromAddress(address: Record<string, unknown>) {
  for (const key of ["ISO3166-2-lvl4", "ISO3166-2-lvl6"]) {
    const value = address[key];
    if (typeof value === "string" && /^BR-[A-Z]{2}$/i.test(value)) return value.slice(3).toUpperCase();
  }
  return typeof address.state_code === "string" && /^[A-Z]{2}$/i.test(address.state_code)
    ? address.state_code.toUpperCase()
    : null;
}

function cityFromAddress(address: Record<string, unknown>) {
  for (const key of ["city", "town", "municipality", "village"]) {
    if (typeof address[key] === "string" && address[key].trim()) return address[key].trim();
  }
  return null;
}

export function createCityGeocoder(options: CityGeocoderOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1_000;
  const userAgent = options.userAgent ?? "PrymeiraTalk-Leads/1.0 (support@prymeiradigital.com.br)";
  const endpoint = options.endpoint ?? "https://nominatim.openstreetmap.org/search";
  const throttle = options.throttle ?? processThrottle;
  const cache = new Map<string, { expiresAt: number; value: GeocodedCity }>();
  if (!userAgent.trim() || !userAgent.includes("/")) {
    throw new CityGeocoderError("INVALID_RESPONSE", "Geocoder User-Agent must identify the application.");
  }

  return {
    async geocode(cityInput: string, stateInput: string): Promise<GeocodedCity> {
      const city = cityInput.trim();
      const state = stateInput.trim().toUpperCase();
      if (!city || city.length > 120 || !/^[A-Z]{2}$/.test(state)) {
        throw new CityGeocoderError("NO_RESULT", "Informe uma cidade e uma UF brasileira válidas.");
      }
      const key = `${normalizeText(city)}|${state}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.value;

      const payload = await throttle.run(async () => {
        const url = new URL(endpoint);
        url.searchParams.set("q", `${city}, ${state}, Brasil`);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("countrycodes", "br");
        url.searchParams.set("limit", "5");
        try {
          const response = await fetchImpl(url, {
            headers: { "user-agent": userAgent, accept: "application/json" }
          });
          if (!response.ok) throw new CityGeocoderError("UNAVAILABLE", "Não foi possível localizar a cidade agora. Tente novamente.");
          return await response.json() as unknown;
        } catch (error) {
          if (error instanceof CityGeocoderError) throw error;
          throw new CityGeocoderError("UNAVAILABLE", "Não foi possível localizar a cidade agora. Tente novamente.");
        }
      }, now, sleep);

      if (!Array.isArray(payload)) {
        throw new CityGeocoderError("INVALID_RESPONSE", "O geocodificador retornou uma resposta inválida.");
      }
      const matches: GeocodedCity[] = [];
      for (const entry of payload) {
        const parsed = resultSchema.safeParse(entry);
        if (!parsed.success) continue;
        const address = parsed.data.address ?? {};
        const canonicalCity = cityFromAddress(address);
        const canonicalState = stateFromAddress(address);
        const latitude = Number(parsed.data.lat);
        const longitude = Number(parsed.data.lon);
        if (!canonicalCity || canonicalState !== state || normalizeText(canonicalCity) !== normalizeText(city)) continue;
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
            !Number.isFinite(longitude) || longitude < -180 || longitude > 180) continue;
        if (typeof address.country_code === "string" && address.country_code.toLowerCase() !== "br") continue;
        matches.push({ city: canonicalCity, state, latitude, longitude });
      }

      const unique = [...new Map(matches.map((match) => [
        `${normalizeText(match.city)}|${match.state}|${match.latitude}|${match.longitude}`,
        match
      ])).values()];
      if (unique.length === 0) {
        throw new CityGeocoderError("NO_RESULT", `Não encontramos “${city}, ${state}”. Confira a cidade e a UF.`);
      }
      if (unique.length > 1) {
        throw new CityGeocoderError("AMBIGUOUS", `“${city}, ${state}” retornou mais de um local. Informe uma cidade mais específica.`);
      }
      const value = unique[0]!;
      cache.set(key, { expiresAt: now() + cacheTtlMs, value });
      return value;
    }
  };
}

export type CityGeocoder = ReturnType<typeof createCityGeocoder>;
