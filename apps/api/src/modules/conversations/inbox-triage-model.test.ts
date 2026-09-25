import { describe, expect, it, vi } from "vitest";
import { createInboxTriageClassifier, createJevInboxTriage } from "./inbox-triage-model.js";
import type { TriageMessage } from "./inbox-triage-policy.js";

const messages: TriageMessage[] = [
  { id: "m1", direction: "outbound", author: "empresa_humano", type: "text", body: "Temos o produto.", createdAt: "2026-09-25T12:00:00Z" },
  { id: "m2", direction: "inbound", author: "cliente", type: "text", body: "Pode enviar um orçamento?", createdAt: "2026-09-25T12:01:00Z" }
];
const input = { workspaceId: "w", anchorMessageId: "m2", messages };

describe("inbox triage classifier", () => {
  it("uses the configured primary result and preserves the anchor", async () => {
    const luna = vi.fn().mockResolvedValue({ decision: "needs_reply", reason: "Cliente pediu orçamento", anchorMessageId: "m2", model: "gpt-6-luna" });
    const jev = vi.fn();
    const result = await createInboxTriageClassifier({ primary: "luna", luna: { assess: luna }, jev: { assess: jev } }).assess(input);
    expect(result).toMatchObject({ decision: "needs_reply", anchorMessageId: "m2" });
    expect(jev).not.toHaveBeenCalled();
  });

  it("falls back to JEV, then to human review, without losing requests", async () => {
    const luna = { assess: vi.fn().mockRejectedValue(new Error("timeout")) };
    const jev = { assess: vi.fn().mockResolvedValue({ decision: "no_reply", reason: "Agradecimento final", anchorMessageId: "m2", model: "jev" }) };
    expect((await createInboxTriageClassifier({ primary: "luna", luna, jev }).assess(input)).decision).toBe("no_reply");
    jev.assess.mockRejectedValue(new Error("offline"));
    expect(await createInboxTriageClassifier({ primary: "luna", jev, luna }).assess(input))
      .toMatchObject({ decision: "uncertain", model: "fallback" });
  });

  it("does not call a model when the anchor is stale or an attachment has no readable content", async () => {
    const luna = { assess: vi.fn() };
    const classifier = createInboxTriageClassifier({ primary: "luna", luna });
    await expect(classifier.assess({ ...input, anchorMessageId: "m1" })).rejects.toThrow("STALE_TRIAGE_ANCHOR");
    expect(await classifier.assess({ ...input, messages: [messages[0], { ...messages[1], type: "file", body: null }] }))
      .toMatchObject({ decision: "uncertain", model: "content_guard" });
    expect(luna.assess).not.toHaveBeenCalled();
  });

  it("sends ordered messages with explicit authors to JEV", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answers: {
      decision: { type: "choice", choice: "needs_reply" },
      reason: { type: "choice", choice: "customer_request" }
    } }) });
    const result = await createJevInboxTriage({ apiKey: "test", fetchImpl }).assess(input);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.state.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "m1", author: "empresa_humano" }),
      expect.objectContaining({ id: "m2", author: "cliente" })
    ]));
    expect(result).toMatchObject({ decision: "needs_reply", model: "jev-latest", anchorMessageId: "m2" });
  });
});
