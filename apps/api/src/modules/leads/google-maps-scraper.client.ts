import { z } from "zod";

export type GoogleMapsScraperErrorCode =
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "REMOTE_FAILED"
  | "INVALID_RESPONSE";

export class GoogleMapsScraperError extends Error {
  constructor(
    public readonly code: GoogleMapsScraperErrorCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "GoogleMapsScraperError";
  }
}

export interface GoogleMapsScraperJobInput {
  name: string;
  keywords: string[];
  latitude: number;
  longitude: number;
  maxTimeSeconds: number;
}

export interface GoogleMapsScraperJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
}

export interface GoogleMapsScraperClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  depth?: number;
}

const createResponseSchema = z.object({ id: z.string().min(1).max(200) });
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_CSV_RESPONSE_BYTES = 10 * 1024 * 1024;
const remoteJobSchema = z.object({
  ID: z.string().min(1).max(200),
  Name: z.string().optional(),
  Status: z.enum(["pending", "working", "ok", "failed"])
}).passthrough();

function invalidResponse(message: string) {
  return new GoogleMapsScraperError("INVALID_RESPONSE", message, false);
}

function normalizeJob(value: unknown): GoogleMapsScraperJob {
  const parsed = remoteJobSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse("Google Maps scraper returned an invalid job response.");
  const statuses: Record<z.infer<typeof remoteJobSchema>["Status"], GoogleMapsScraperJob["status"]> = {
    pending: "queued",
    working: "running",
    ok: "succeeded",
    failed: "failed"
  };
  return { id: parsed.data.ID, status: statuses[parsed.data.Status] };
}

function safeJobId(value: string) {
  const id = value.trim();
  if (!id || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw invalidResponse("Google Maps scraper job identifier is invalid.");
  }
  return id;
}

export function createGoogleMapsScraperClient(options: GoogleMapsScraperClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const depth = options.depth ?? 12;
  if (!Number.isInteger(depth) || depth < 1 || depth > 20) {
    throw invalidResponse("Google Maps scraper depth must be between 1 and the safe maximum of 20.");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
    throw invalidResponse("Google Maps scraper request timeout is invalid.");
  }

  let baseUrl: URL | undefined;
  let authorization: string | undefined;
  if (options.baseUrl) {
    try {
      baseUrl = new URL(options.baseUrl);
      if (!(["http:", "https:"] as const).includes(baseUrl.protocol as "http:" | "https:")) throw new Error();
      if (baseUrl.username || baseUrl.password) {
        authorization = `Basic ${Buffer.from(`${decodeURIComponent(baseUrl.username)}:${decodeURIComponent(baseUrl.password)}`).toString("base64")}`;
        baseUrl.username = "";
        baseUrl.password = "";
      }
      baseUrl.pathname = "/";
      baseUrl.search = "";
      baseUrl.hash = "";
    } catch {
      throw new GoogleMapsScraperError("UNAVAILABLE", "Google Maps scraper is not configured correctly.", false);
    }
  }

  async function requestText(path: string, init: RequestInit, maxBytes: number) {
    if (!baseUrl) {
      throw new GoogleMapsScraperError("UNAVAILABLE", "Google Maps scraper is not configured.", false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const headers = new Headers(init.headers);
      if (authorization) headers.set("authorization", authorization);
      const result = await fetchImpl(new URL(path, baseUrl), { ...init, headers, signal: controller.signal });
      if (result.status === 429) {
        throw new GoogleMapsScraperError("RATE_LIMITED", "Google Maps scraper is temporarily rate limited.", true);
      }
      if (!result.ok) {
        throw new GoogleMapsScraperError(
          "REMOTE_FAILED",
          `Google Maps scraper returned HTTP ${result.status}.`,
          result.status >= 500 || result.status === 408
        );
      }
      const declaredLength = Number(result.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw invalidResponse("Google Maps scraper response exceeded the safe size limit.");
      }
      if (!result.body) return "";
      const reader = result.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          throw invalidResponse("Google Maps scraper response exceeded the safe size limit.");
        }
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
    } catch (error) {
      if (error instanceof GoogleMapsScraperError) throw error;
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new GoogleMapsScraperError("TIMEOUT", "Google Maps scraper request timed out.", true);
      }
      throw new GoogleMapsScraperError("UNAVAILABLE", "Google Maps scraper is unavailable.", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const text = await requestText(path, init ?? {}, MAX_JSON_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw invalidResponse("Google Maps scraper returned malformed JSON.");
    }
  }

  return {
    async health() {
      const payload = await json("/api/v1/jobs");
      if (payload !== null && !Array.isArray(payload)) throw invalidResponse("Google Maps scraper health response is invalid.");
      return { ok: true as const };
    },

    async findJobByName(name: string): Promise<GoogleMapsScraperJob | null> {
      const payload = await json("/api/v1/jobs");
      if (payload !== null && !Array.isArray(payload)) throw invalidResponse("Google Maps scraper job list is invalid.");
      const matching = (payload ?? []).filter((entry) => {
        const parsed = remoteJobSchema.safeParse(entry);
        return parsed.success && parsed.data.Name === name;
      });
      if (matching.length === 0) return null;
      if (matching.length !== 1) throw invalidResponse("Google Maps scraper returned duplicate job names.");
      return normalizeJob(matching[0]);
    },

    async createJob(input: GoogleMapsScraperJobInput) {
      if (!Number.isInteger(input.maxTimeSeconds) || input.maxTimeSeconds < 180 || input.maxTimeSeconds > 900) {
        throw invalidResponse("Google Maps scraper max time must be between 180 and 900 seconds.");
      }
      if (!input.name.trim() || input.keywords.length < 1 || input.keywords.some((keyword) => !keyword.trim())) {
        throw invalidResponse("Google Maps scraper job input is invalid.");
      }
      if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 ||
          !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
        throw invalidResponse("Google Maps scraper coordinates are invalid.");
      }
      const payload = await json("/api/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name.trim(),
          keywords: input.keywords.map((keyword) => keyword.trim()),
          lang: "pt",
          zoom: 15,
          lat: String(input.latitude),
          lon: String(input.longitude),
          fast_mode: false,
          radius: 10_000,
          depth,
          max_time: input.maxTimeSeconds
        })
      });
      const parsed = createResponseSchema.safeParse(payload);
      if (!parsed.success) throw invalidResponse("Google Maps scraper returned an invalid create response.");
      return parsed.data;
    },

    async getJob(id: string) {
      return normalizeJob(await json(`/api/v1/jobs/${encodeURIComponent(safeJobId(id))}`));
    },

    async download(id: string) {
      return requestText(
        `/api/v1/jobs/${encodeURIComponent(safeJobId(id))}/download`,
        { headers: { accept: "text/csv" } },
        MAX_CSV_RESPONSE_BYTES
      );
    }
  };
}

export type GoogleMapsScraperClient = ReturnType<typeof createGoogleMapsScraperClient>;
