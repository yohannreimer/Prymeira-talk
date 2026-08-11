import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_CHUNK_MAX_CHARS,
  chunkKnowledgeContent
} from "./knowledge-chunking.js";

describe("chunkKnowledgeContent", () => {
  it("keeps short documents as one ranged chunk", () => {
    const content = "# Catálogo\n\nChapas e tubos.";
    expect(chunkKnowledgeContent(content)).toEqual([
      {
        index: 0,
        start: 0,
        end: content.length,
        content
      }
    ]);
  });

  it("prefers paragraph boundaries and preserves headings", () => {
    const content = `# Produtos\n\n${"Chapas lisas. ".repeat(170)}\n\n# Estoque\n\nA disponibilidade deve ser confirmada.`;
    const chunks = chunkKnowledgeContent(content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= KNOWLEDGE_CHUNK_MAX_CHARS)).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("# Estoque"))).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
  });

  it("uses overlap when one paragraph exceeds the maximum", () => {
    const content = `INÍCIO ${"estrutura metálica ".repeat(260)} FIM`;
    const chunks = chunkKnowledgeContent(content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.end).toBeGreaterThan(chunks[1]?.start ?? Number.MAX_SAFE_INTEGER);
    expect(chunks.at(-1)?.content).toContain("FIM");
  });
});
