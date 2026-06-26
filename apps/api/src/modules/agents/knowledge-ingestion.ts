import { PDFParse } from "pdf-parse";

export type KnowledgeCategory =
  | "precos"
  | "produto"
  | "faq"
  | "politicas"
  | "onboarding"
  | "comercial"
  | "suporte"
  | "outro";

type SourceKind = "pdf" | "text";

export type KnowledgeIngestionMetadata = {
  category: KnowledgeCategory;
  sourceKind: SourceKind;
  extractionMethod: "pdf-parse" | "plain-text";
  extractedAt: string;
  keywords: string[];
  textCharCount: number;
};

function normalizeExtractedText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function deriveKeywords(text: string) {
  return Array.from(
    new Set(
      text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLocaleLowerCase("pt-BR")
        .split(/\W+/)
        .filter((term) => term.length >= 5)
    )
  ).slice(0, 24);
}

async function extractPdfText(buffer: Buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const result = await parser.getText();
    return result.text;
  } catch {
    return "";
  } finally {
    await parser.destroy();
  }
}

export async function ingestKnowledgeUpload(input: {
  fileName: string;
  mimeType: string;
  base64Content: string;
  category: KnowledgeCategory;
}): Promise<{
  content: string;
  metadata: KnowledgeIngestionMetadata;
}> {
  const buffer = Buffer.from(input.base64Content, "base64");
  const lowerFileName = input.fileName.toLocaleLowerCase("pt-BR");
  const lowerMimeType = input.mimeType.toLocaleLowerCase("pt-BR");
  const isPdf = lowerMimeType === "application/pdf" || lowerFileName.endsWith(".pdf");
  const isText = lowerMimeType === "text/plain" || lowerFileName.endsWith(".txt");

  if (!isPdf && !isText) {
    throw new Error("Unsupported knowledge file type.");
  }

  const sourceKind: SourceKind = isPdf ? "pdf" : "text";
  const rawText = isPdf ? await extractPdfText(buffer) : buffer.toString("utf8");
  const content = normalizeExtractedText(rawText);

  if (!content) {
    throw new Error("Knowledge file did not contain readable text.");
  }

  return {
    content,
    metadata: {
      category: input.category,
      sourceKind,
      extractionMethod: isPdf ? "pdf-parse" : "plain-text",
      extractedAt: new Date().toISOString(),
      keywords: deriveKeywords(content),
      textCharCount: content.length
    }
  };
}
