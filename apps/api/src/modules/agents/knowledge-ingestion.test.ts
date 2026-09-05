import { describe, expect, it, vi } from "vitest";
import {
  ingestKnowledgeUpload,
  MAX_KNOWLEDGE_TEXT_CHARS,
  MAX_KNOWLEDGE_UPLOAD_BYTES
} from "./knowledge-ingestion.js";

vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn().mockImplementation(function MockPDFParse() {
    return {
      getText: vi.fn(async () => ({
        text: "Política   Comercial\n\nTrocas em até 7 dias"
      })),
      destroy: vi.fn(async () => {})
    };
  })
}));

describe("ingestKnowledgeUpload", () => {
  it("normalizes plain text uploads", async () => {
    const result = await ingestKnowledgeUpload({
      fileName: "precos.txt",
      mimeType: "text/plain",
      base64Content: Buffer.from("Plano  Operação\nR$ 299").toString("base64"),
      category: "precos"
    });

    expect(result.content).toBe("Plano Operação R$ 299");
    expect(result.metadata).toMatchObject({
      category: "precos",
      sourceKind: "text",
      extractionMethod: "plain-text",
      keywords: expect.arrayContaining(["plano", "operacao"]),
      textCharCount: 21
    });
    expect(result.metadata.extractedAt).toEqual(expect.any(String));
  });

  it("accepts custom category slugs", async () => {
    const result = await ingestKnowledgeUpload({
      fileName: "materiais.txt",
      mimeType: "text/plain",
      base64Content: Buffer.from("Chapas galvanizadas sob consulta.").toString("base64"),
      category: "materials_catalog"
    });

    expect(result.metadata.category).toBe("materials_catalog");
  });

  it("rejects invalid custom category slugs", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "materiais.txt",
        mimeType: "text/plain",
        base64Content: Buffer.from("Chapas galvanizadas sob consulta.").toString("base64"),
        category: "Materiais e Aço"
      })
    ).rejects.toThrow("A categoria de conhecimento é inválida.");
  });

  it("accepts txt uploads with a generic browser mime type", async () => {
    const result = await ingestKnowledgeUpload({
      fileName: "base-produtos.txt",
      mimeType: "application/octet-stream",
      base64Content: Buffer.from("Produtos Prymeira\nTalk e CRM").toString("base64"),
      category: "produto"
    });

    expect(result.content).toBe("Produtos Prymeira Talk e CRM");
    expect(result.metadata).toMatchObject({
      category: "produto",
      sourceKind: "text",
      extractionMethod: "plain-text"
    });
  });

  it("accepts larger plain text knowledge bases under the extracted text limit", async () => {
    const largeBase = `Produto Prymeira Talk\n${"Atendimento com automações e agentes. ".repeat(850)}`;

    const result = await ingestKnowledgeUpload({
      fileName: "base-completa.txt",
      mimeType: "text/plain",
      base64Content: Buffer.from(largeBase).toString("base64"),
      category: "produto"
    });

    expect(result.content.length).toBeGreaterThan(20_000);
    expect(result.content.length).toBeLessThan(MAX_KNOWLEDGE_TEXT_CHARS);
    expect(result.metadata.textCharCount).toBe(result.content.length);
  });

  it("extracts normalized PDF text with metadata", async () => {
    const result = await ingestKnowledgeUpload({
      fileName: "politicas.pdf",
      mimeType: "application/pdf",
      base64Content: Buffer.from("%PDF-1.4").toString("base64"),
      category: "politicas"
    });

    expect(result.content).toBe("Política Comercial Trocas em até 7 dias");
    expect(result.metadata).toMatchObject({
      category: "politicas",
      sourceKind: "pdf",
      extractionMethod: "pdf-parse",
      textCharCount: 39
    });
  });

  it("rejects unsupported file types", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "imagem.png",
        mimeType: "image/png",
        base64Content: Buffer.from("x").toString("base64"),
        category: "produto"
      })
    ).rejects.toThrow("Tipo de arquivo de conhecimento não suportado.");
  });

  it("rejects inconsistent file extension and mime type", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "precos.pdf",
        mimeType: "text/plain",
        base64Content: Buffer.from("Plano Operação R$ 299").toString("base64"),
        category: "precos"
      })
    ).rejects.toThrow("Tipo de arquivo de conhecimento não suportado.");
  });

  it("rejects invalid base64 payloads", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "precos.txt",
        mimeType: "text/plain",
        base64Content: "%%%not-base64%%%",
        category: "precos"
      })
    ).rejects.toThrow("O conteúdo do arquivo de conhecimento é inválido.");
  });

  it("rejects uploaded files above the byte limit", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "precos.txt",
        mimeType: "text/plain",
        base64Content: Buffer.alloc(MAX_KNOWLEDGE_UPLOAD_BYTES + 1, "a").toString("base64"),
        category: "precos"
      })
    ).rejects.toThrow("O arquivo de conhecimento é muito grande.");
  });

  it("rejects non plain-text text uploads", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "pagina.html",
        mimeType: "text/html",
        base64Content: Buffer.from("<p>Produto</p>").toString("base64"),
        category: "produto"
      })
    ).rejects.toThrow("Tipo de arquivo de conhecimento não suportado.");
  });

  it("rejects extracted text above the char limit", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "grande.txt",
        mimeType: "text/plain",
        base64Content: Buffer.from("x".repeat(MAX_KNOWLEDGE_TEXT_CHARS + 1)).toString("base64"),
        category: "outro"
      })
    ).rejects.toThrow("O texto extraído do arquivo de conhecimento é muito grande.");
  });

  it("rejects files without readable text", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "vazio.txt",
        mimeType: "text/plain",
        base64Content: Buffer.from(" \n\t ").toString("base64"),
        category: "outro"
      })
    ).rejects.toThrow("O arquivo de conhecimento não contém texto legível.");
  });
});
