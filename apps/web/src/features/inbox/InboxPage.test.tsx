import { describe, expect, it } from "vitest";
import { messageDisplayText, messageMediaLabel } from "./InboxPage";

describe("messageDisplayText", () => {
  it("uses message body when present", () => {
    expect(messageDisplayText({ body: "Oi", type: "image" })).toBe("Oi");
  });

  it("uses media labels when the message has no text body", () => {
    expect(messageDisplayText({ body: null, type: "image" })).toBe("Imagem recebida");
    expect(messageDisplayText({ body: null, type: "audio" })).toBe("Audio recebido");
    expect(messageDisplayText({ body: null, type: "file" })).toBe("Arquivo recebido");
  });
});

describe("messageMediaLabel", () => {
  it("names media actions by message type", () => {
    expect(messageMediaLabel({ type: "image" })).toBe("Abrir imagem");
    expect(messageMediaLabel({ type: "audio" })).toBe("Abrir audio");
    expect(messageMediaLabel({ type: "file" })).toBe("Abrir arquivo");
  });
});
