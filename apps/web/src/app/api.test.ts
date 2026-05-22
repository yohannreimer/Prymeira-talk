import { afterEach, describe, expect, it, vi } from "vitest";

describe("buildRealtimeUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("preserves the API base path for websocket connections", async () => {
    vi.stubEnv("VITE_API_URL", "https://talk.prymeiradigital.com.br/api");

    const { buildRealtimeUrl } = await import("./api");

    expect(buildRealtimeUrl("token_1")).toBe(
      "wss://talk.prymeiradigital.com.br/api/realtime?token=token_1"
    );
  });
});

describe("readApiErrorMessage", () => {
  it("uses structured API error bodies before falling back to HTTP status", async () => {
    const { readApiErrorMessage } = await import("./api");

    const response = new Response(
      JSON.stringify({
        code: "EVOLUTION_LICENSE_REQUIRED",
        error: "Evolution API exige ativacao da licenca."
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );

    await expect(readApiErrorMessage(response, "Failed to start channel QR")).resolves.toBe(
      "Evolution API exige ativacao da licenca."
    );
  });
});
