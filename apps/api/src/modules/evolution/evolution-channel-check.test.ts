import { describe, expect, it } from "vitest";
import {
  buildChannelReport,
  maskNumber,
  parseInstanceList,
  parseWebhookConfig,
  reduceUrlToHostAndPath,
  type ChannelCheckRow
} from "./evolution-channel-check.js";

describe("parseInstanceList", () => {
  it("parses a flat array (Evolution v2)", () => {
    const result = parseInstanceList([
      { name: "ch-a", connectionStatus: "open", ownerJid: "5511999991234@s.whatsapp.net", token: "x" },
      { instanceName: "ch-b", state: "close" }
    ]);
    expect(result).toEqual([
      { name: "ch-a", owner: "5511999991234", listState: "open" },
      { name: "ch-b", owner: null, listState: "close" }
    ]);
  });

  it("parses an array of { instance } wrappers (Evolution v1)", () => {
    const result = parseInstanceList([
      { instance: { instanceName: "ch-c", owner: "5511888885678@s.whatsapp.net", status: "connecting" } }
    ]);
    expect(result).toEqual([{ name: "ch-c", owner: "5511888885678", listState: "connecting" }]);
  });

  it("accepts an object wrapping the array and ignores junk", () => {
    expect(parseInstanceList({ data: [{ name: "x" }, 5, null, {}] })).toEqual([
      { name: "x", owner: null, listState: null }
    ]);
    expect(parseInstanceList("oops")).toEqual([]);
  });
});

describe("reduceUrlToHostAndPath", () => {
  it("drops scheme, query and hash", () => {
    expect(reduceUrlToHostAndPath("https://api.example.com/webhooks/evolution?token=abc#x")).toBe(
      "api.example.com/webhooks/evolution"
    );
  });
  it("drops credentials and trailing root slash", () => {
    expect(reduceUrlToHostAndPath("https://user:pw@h.io:8443/")).toBe("h.io:8443");
  });
  it("returns null for invalid input", () => {
    expect(reduceUrlToHostAndPath("not a url")).toBeNull();
    expect(reduceUrlToHostAndPath(undefined)).toBeNull();
  });
});

describe("maskNumber", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskNumber("5511999991234@s.whatsapp.net")).toBe("…1234");
  });
  it("returns null when absent or too short", () => {
    expect(maskNumber(null)).toBeNull();
    expect(maskNumber("12")).toBeNull();
  });
});

describe("parseWebhookConfig", () => {
  it("parses top-level shape", () => {
    expect(parseWebhookConfig({ url: "https://a.io/w", enabled: true, events: ["MESSAGES_UPSERT"] })).toEqual({
      url: "https://a.io/w",
      enabled: true,
      events: ["MESSAGES_UPSERT"]
    });
  });
  it("parses nested webhook shape", () => {
    expect(parseWebhookConfig({ webhook: { url: "https://a.io/w", enabled: false } })).toEqual({
      url: "https://a.io/w",
      enabled: false,
      events: []
    });
  });
  it("returns null for null/empty bodies", () => {
    expect(parseWebhookConfig(null)).toBeNull();
    expect(parseWebhookConfig({})).toBeNull();
  });
});

function row(partial: Partial<ChannelCheckRow> & { name: string }): ChannelCheckRow {
  return {
    owner: null,
    clientState: "open",
    listState: "open",
    webhook: { url: "https://api.example.com/hook?token=abc", enabled: true, events: [] },
    failures: [],
    ...partial
  };
}

describe("buildChannelReport", () => {
  it("builds table, summary and no warnings for healthy channels", () => {
    const report = buildChannelReport([
      row({ name: "a", owner: "5511999991234" }),
      row({ name: "b" })
    ]);
    expect(report.text).toContain("a");
    expect(report.text).toContain("…1234");
    expect(report.text).toContain("api.example.com/hook");
    expect(report.text).not.toContain("token=abc");
    expect(report.text).toContain("open: 2");
    expect(report.warnings).toEqual([]);
  });

  it("shows list state when different and warns about non-open instances", () => {
    const report = buildChannelReport([
      row({ name: "a", clientState: "close", listState: "open" }),
      row({ name: "b", clientState: null, listState: null })
    ]);
    expect(report.text).toContain("desconhecido");
    expect(report.text).toContain("close: 1");
    expect(report.text).toContain("desconhecido: 1");
    expect(report.warnings.some((w) => w.includes("a") && w.includes("close"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("b") && w.includes("desconhecido"))).toBe(true);
  });

  it("warns on missing/disabled webhook and divergent host", () => {
    const report = buildChannelReport([
      row({ name: "a" }),
      row({ name: "b" }),
      row({ name: "c", webhook: { url: "https://other.io/hook", enabled: true, events: [] } }),
      row({ name: "d", webhook: null }),
      row({ name: "e", webhook: { url: "https://api.example.com/hook", enabled: false, events: [] } })
    ]);
    const text = report.warnings.join("\n");
    expect(text).toMatch(/c.*host/i);
    expect(text).toMatch(/d.*webhook/i);
    expect(text).toMatch(/e.*desativado/i);
    expect(text).not.toMatch(/instância "a"/);
  });

  it("reports failed requests with status code only", () => {
    const report = buildChannelReport(
      [row({ name: "a", clientState: null, failures: [{ step: "connectionState", status: 404 }] })],
      [{ step: "fetchInstances", status: 500 }]
    );
    const text = report.warnings.join("\n");
    expect(text).toContain("404");
    expect(text).toContain("500");
  });

  it("never leaks secrets", () => {
    const poisoned = {
      url: "https://api.example.com/hook?token=abc",
      enabled: true,
      apikey: "SUPERKEY",
      token: "TOK123",
      secret: "SEC456",
      headers: { "x-prymeira-talk-secret": "HDR789" }
    };
    const list = parseInstanceList([{ name: "a", apikey: "SUPERKEY", token: "TOK123", secret: "SEC456" }]);
    const hook = parseWebhookConfig(poisoned);
    const report = buildChannelReport([
      row({ name: list[0]!.name, webhook: hook })
    ]);
    const all = report.text + report.warnings.join("\n");
    for (const s of ["SUPERKEY", "TOK123", "SEC456", "HDR789", "token=abc", "?token"]) {
      expect(all).not.toContain(s);
    }
  });
});
