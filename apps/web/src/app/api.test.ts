import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("buildRealtimeUrl", () => {
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

describe("apiDeleteChannel", () => {
  it("sends DELETE to the channel endpoint", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channelId: "channel-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.resetModules();

    const { apiDeleteChannel } = await import("./api");
    await expect(apiDeleteChannel(async () => null, "channel-1")).resolves.toEqual({
      ok: true,
      channelId: "channel-1"
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3002/channels/channel-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer local-dev-bypass"
        })
      })
    );
  });

  it("rejects malformed successful responses", async () => {
    vi.stubEnv("VITE_LOCAL_AUTH_BYPASS", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, channelId: "" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.resetModules();

    const { apiDeleteChannel } = await import("./api");

    await expect(apiDeleteChannel(async () => null, "channel-1")).rejects.toThrow(
      "Invalid delete channel response."
    );
  });
});
