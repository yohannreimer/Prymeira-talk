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
