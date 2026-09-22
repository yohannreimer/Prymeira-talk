import { describe, expect, it, vi } from "vitest";
import {
  GoogleMapsScraperError,
  createGoogleMapsScraperClient
} from "./google-maps-scraper.client.js";

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init
  });
}

describe("GoogleMapsScraperClient", () => {
  it("accepts the upstream null response for an empty job list", async () => {
    const fetch = vi.fn(async () => response(null));
    const client = createGoogleMapsScraperClient({ baseUrl: "http://scraper.internal:8080", fetch });

    await expect(client.health()).resolves.toEqual({ ok: true });
    await expect(client.findJobByName("prymeira-new-job")).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses only the private REST endpoints and sends the conservative exact body", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") return response({ id: "b32e1cd8-5427-4478-a20f-adaab30b75c3" }, { status: 201 });
      if (url.endsWith("/download")) return response("title,link\nAcme,https://maps.google.com/a\n", { headers: { "content-type": "text/csv" } });
      if (url.endsWith("/b32e1cd8-5427-4478-a20f-adaab30b75c3")) {
        return response({ ID: "b32e1cd8-5427-4478-a20f-adaab30b75c3", Status: "working" });
      }
      return response([{ ID: "existing", Name: "other", Status: "pending" }]);
    });
    const client = createGoogleMapsScraperClient({
      baseUrl: "http://scraper.internal:8080/base/ignored",
      fetch,
      requestTimeoutMs: 5_000,
      depth: 5
    });

    await expect(client.health()).resolves.toEqual({ ok: true });
    await expect(client.createJob({
      name: "prymeira-job",
      keywords: ["padarias em Campinas, SP"],
      latitude: -22.9056,
      longitude: -47.0608,
      maxTimeSeconds: 600
    })).resolves.toEqual({ id: "b32e1cd8-5427-4478-a20f-adaab30b75c3" });
    await expect(client.getJob("b32e1cd8-5427-4478-a20f-adaab30b75c3")).resolves.toEqual({
      id: "b32e1cd8-5427-4478-a20f-adaab30b75c3",
      status: "running"
    });
    await expect(client.download("b32e1cd8-5427-4478-a20f-adaab30b75c3")).resolves.toContain("Acme");

    const calls = fetch.mock.calls as unknown as Array<[string | URL | Request, RequestInit?]>;
    expect(calls.map(([url]) => String(url))).toEqual([
      "http://scraper.internal:8080/api/v1/jobs",
      "http://scraper.internal:8080/api/v1/jobs",
      "http://scraper.internal:8080/api/v1/jobs/b32e1cd8-5427-4478-a20f-adaab30b75c3",
      "http://scraper.internal:8080/api/v1/jobs/b32e1cd8-5427-4478-a20f-adaab30b75c3/download"
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
      name: "prymeira-job",
      keywords: ["padarias em Campinas, SP"],
      lang: "pt",
      zoom: 15,
      lat: "-22.9056",
      lon: "-47.0608",
      fast_mode: false,
      radius: 10000,
      depth: 5,
      max_time: 600
    });
    expect(JSON.parse(String(calls[1]?.[1]?.body))).not.toHaveProperty("concurrency");
  });

  it("moves URL credentials to a server-only Authorization header and never exposes them in errors", async () => {
    const fetch = vi.fn(async () => response({ message: "secret upstream body apiKey=top-secret" }, { status: 500 }));
    const client = createGoogleMapsScraperClient({
      baseUrl: "https://service-user:super-secret@scraper.internal",
      fetch
    });

    await expect(client.health()).rejects.toMatchObject({ code: "REMOTE_FAILED", message: "Google Maps scraper returned HTTP 500." });
    const calls = fetch.mock.calls as unknown as Array<[string | URL | Request, RequestInit?]>;
    expect(String(calls[0]?.[0])).toBe("https://scraper.internal/api/v1/jobs");
    expect(new Headers(calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("service-user:super-secret").toString("base64")}`
    );
  });

  it.each([
    ["pending", "queued"],
    ["working", "running"],
    ["ok", "succeeded"],
    ["failed", "failed"]
  ] as const)("maps upstream %s status to %s", async (remote, expected) => {
    const fetch = vi.fn(async () => response({ ID: "job-1", Status: remote }));
    const client = createGoogleMapsScraperClient({ baseUrl: "http://127.0.0.1:8080", fetch });
    await expect(client.getJob("job-1")).resolves.toEqual({ id: "job-1", status: expected });
  });

  it("classifies rate limits, transport timeouts, malformed responses, and remote failures", async () => {
    const limited = createGoogleMapsScraperClient({
      baseUrl: "http://127.0.0.1:8080",
      fetch: vi.fn(async () => response("too many secret details", { status: 429 }))
    });
    await expect(limited.health()).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });

    const timedOut = createGoogleMapsScraperClient({
      baseUrl: "http://127.0.0.1:8080",
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
      requestTimeoutMs: 5
    });
    await expect(timedOut.health()).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });

    const malformed = createGoogleMapsScraperClient({
      baseUrl: "http://127.0.0.1:8080",
      fetch: vi.fn(async () => response({ ID: "job-1", Status: "mystery" }))
    });
    await expect(malformed.getJob("job-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: false });

    const failed = createGoogleMapsScraperClient({
      baseUrl: "http://127.0.0.1:8080",
      fetch: vi.fn(async () => response({ ID: "job-1", Status: "failed" }))
    });
    await expect(failed.getJob("job-1")).resolves.toMatchObject({ status: "failed" });
  });

  it("keeps the timeout active while consuming bodies and rejects oversized downloads", async () => {
    const stalledFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const stalled = createGoogleMapsScraperClient({
      baseUrl: "http://127.0.0.1:8080",
      fetch: stalledFetch,
      requestTimeoutMs: 5
    });
    await expect(stalled.health()).rejects.toMatchObject({ code: "TIMEOUT" });

    const oversized = createGoogleMapsScraperClient({
      baseUrl: "http://127.0.0.1:8080",
      fetch: vi.fn(async () => new Response("x", {
        status: 200,
        headers: { "content-type": "text/csv", "content-length": String(11 * 1024 * 1024) }
      }))
    });
    await expect(oversized.download("job-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("fails only Google actions when configuration is absent and guards depth/max time", async () => {
    const unavailable = createGoogleMapsScraperClient({ baseUrl: undefined });
    await expect(unavailable.health()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(() => createGoogleMapsScraperClient({ baseUrl: "http://127.0.0.1:8080", depth: 6 }))
      .toThrow(GoogleMapsScraperError);

    const client = createGoogleMapsScraperClient({ baseUrl: "http://127.0.0.1:8080", fetch: vi.fn() });
    await expect(client.createJob({
      name: "job",
      keywords: ["query"],
      latitude: 0,
      longitude: 0,
      maxTimeSeconds: 179
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.createJob({
      name: "job",
      keywords: ["query"],
      latitude: 0,
      longitude: 0,
      maxTimeSeconds: 901
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
