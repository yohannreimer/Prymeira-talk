import { describe, expect, it } from "vitest";
import {
  applyComposerMarker,
  insertComposerText,
  messageDisplayText,
  messageMediaKind,
  messageMediaLabel
} from "./InboxPage";

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
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.jpg", type: "image" })).toBe("Abrir imagem");
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.ogg", type: "audio" })).toBe("Reproduzir audio");
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.pdf", type: "file" })).toBe("Baixar arquivo");
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.mp4", type: "file" })).toBe("Baixar video");
    expect(messageMediaLabel({ mediaUrl: "data:video/mp4;base64,dmZk", type: "file" })).toBe("Baixar video");
  });
});

describe("messageMediaKind", () => {
  it("classifies media that can render inline", () => {
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.webp", type: "image" })).toBe("image");
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.ogg", type: "audio" })).toBe("audio");
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.mp4", type: "file" })).toBe("file");
    expect(messageMediaKind({ mediaUrl: "data:video/mp4;base64,dmZk", type: "file" })).toBe("file");
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.pdf", type: "file" })).toBe("file");
    expect(messageMediaKind({ mediaUrl: null, type: "image" })).toBeNull();
  });
});

describe("composer formatting helpers", () => {
  it("wraps only the selected text with the requested WhatsApp marker", () => {
    expect(applyComposerMarker("oi tudo bem", 3, 7, "*")).toEqual({
      value: "oi *tudo* bem",
      selectionStart: 4,
      selectionEnd: 8
    });
  });

  it("inserts paired markers around the cursor when nothing is selected", () => {
    expect(applyComposerMarker("oi bem", 3, 3, "_")).toEqual({
      value: "oi __bem",
      selectionStart: 4,
      selectionEnd: 4
    });
  });

  it("inserts emoji at the current selection", () => {
    expect(insertComposerText("oi mundo", 3, 8, "😊")).toEqual({
      value: "oi 😊",
      selectionStart: 5,
      selectionEnd: 5
    });
  });
});
