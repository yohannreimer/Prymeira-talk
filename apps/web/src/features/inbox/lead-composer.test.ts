import { describe, expect, it } from "vitest";
import { mergeLeadComposerDraft, takeLeadDraftRequest } from "./lead-composer";

describe("lead composer handoff", () => {
  it("consumes the matching one-time flag and leaves the conversation URL intact", () => {
    expect(takeLeadDraftRequest("https://talk.test/?module=atendimento&conversation=conv-1&leadDraft=1", "conv-1"))
      .toBe("/?module=atendimento&conversation=conv-1");
    expect(takeLeadDraftRequest("https://talk.test/?module=atendimento&conversation=conv-1", "conv-1")).toBeNull();
    expect(takeLeadDraftRequest("https://talk.test/?conversation=conv-2&leadDraft=1", "conv-1")).toBeNull();
  });

  it("prefills only an empty composer and never treats a null draft as content", () => {
    expect(mergeLeadComposerDraft("", "Olá, posso ajudar?")).toBe("Olá, posso ajudar?");
    expect(mergeLeadComposerDraft("Minha edição", "Olá, posso ajudar?")).toBe("Minha edição");
    expect(mergeLeadComposerDraft("", null)).toBe("");
  });
});
