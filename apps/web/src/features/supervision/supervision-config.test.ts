// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigValue } from "../../app/runtime-config";

describe("configured Hub return URL", () => {
  afterEach(() => { delete window.__PRYMEIRA_TALK_CONFIG__; vi.unstubAllEnvs(); });
  it("reads the bundled Hub setting", () => {
    vi.stubEnv("VITE_PRYMEIRA_HUB_URL", "http://localhost:3000");
    expect(readConfigValue("VITE_PRYMEIRA_HUB_URL")).toBe("http://localhost:3000");
  });
  it("uses runtime deployment configuration ahead of the bundle", () => {
    vi.stubEnv("VITE_PRYMEIRA_HUB_URL", "http://localhost:3000");
    window.__PRYMEIRA_TALK_CONFIG__ = { VITE_PRYMEIRA_HUB_URL: "https://hub.prymeiradigital.com.br" };
    expect(readConfigValue("VITE_PRYMEIRA_HUB_URL")).toBe("https://hub.prymeiradigital.com.br");
  });
});
