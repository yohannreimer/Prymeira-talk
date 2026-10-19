import { describe, expect, it } from "vitest";
import { splitReplyIntoBubbles, typingDelayMs } from "./reply-bubbles.js";

describe("splitReplyIntoBubbles", () => {
  it("keeps a single paragraph as one bubble", () => {
    expect(splitReplyIntoBubbles("Oi, João! Tudo certo?")).toEqual(["Oi, João! Tudo certo?"]);
  });

  it("splits paragraphs separated by blank lines", () => {
    expect(splitReplyIntoBubbles("Imagino a correria.\n\n  \nTenho terça às 13:30. Serve?")).toEqual([
      "Imagino a correria.",
      "Tenho terça às 13:30. Serve?"
    ]);
  });

  it("keeps single line breaks inside a bubble", () => {
    expect(splitReplyIntoBubbles("linha 1\nlinha 2")).toEqual(["linha 1\nlinha 2"]);
  });

  it("joins the extra paragraphs into the last bubble", () => {
    expect(splitReplyIntoBubbles("a\n\nb\n\nc\n\nd", 3)).toEqual(["a", "b", "c\n\nd"]);
  });

  it("returns nothing for a blank reply", () => {
    expect(splitReplyIntoBubbles("   ")).toEqual([]);
  });
});

describe("typingDelayMs", () => {
  it("stays between 1.2 and 4 seconds", () => {
    expect(typingDelayMs("ok")).toBe(1_200);
    expect(typingDelayMs("x".repeat(60))).toBe(2_700);
    expect(typingDelayMs("x".repeat(500))).toBe(4_000);
  });
});
