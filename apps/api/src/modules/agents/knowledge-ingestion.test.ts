import { describe, expect, it, vi } from "vitest";
import { ingestKnowledgeUpload } from "./knowledge-ingestion.js";

vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn().mockImplementation(function MockPDFParse() {
    return {
      getText: vi.fn(async () => ({
        text: "Politica   Comercial\n\nTrocas em ate 7 dias"
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
      base64Content: Buffer.from("Plano  Operacao\nR$ 299").toString("base64"),
      category: "precos"
    });

    expect(result.content).toBe("Plano Operacao R$ 299");
    expect(result.metadata).toMatchObject({
      category: "precos",
      sourceKind: "text",
      extractionMethod: "plain-text",
      keywords: expect.arrayContaining(["plano", "operacao"]),
      textCharCount: 21
    });
    expect(result.metadata.extractedAt).toEqual(expect.any(String));
  });

  it("extracts normalized PDF text with metadata", async () => {
    const result = await ingestKnowledgeUpload({
      fileName: "politicas.pdf",
      mimeType: "application/pdf",
      base64Content: Buffer.from("%PDF-1.4").toString("base64"),
      category: "politicas"
    });

    expect(result.content).toBe("Politica Comercial Trocas em ate 7 dias");
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
    ).rejects.toThrow("Unsupported knowledge file type.");
  });

  it("rejects non plain-text text uploads", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "pagina.html",
        mimeType: "text/html",
        base64Content: Buffer.from("<p>Produto</p>").toString("base64"),
        category: "produto"
      })
    ).rejects.toThrow("Unsupported knowledge file type.");
  });

  it("rejects files without readable text", async () => {
    await expect(
      ingestKnowledgeUpload({
        fileName: "vazio.txt",
        mimeType: "text/plain",
        base64Content: Buffer.from(" \n\t ").toString("base64"),
        category: "outro"
      })
    ).rejects.toThrow("Knowledge file did not contain readable text.");
  });
});
