import { PDFParse } from "pdf-parse";

export type KnowledgeCategory = string;

type SourceKind = "pdf" | "text";

export const MAX_KNOWLEDGE_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_KNOWLEDGE_TEXT_CHARS = 500_000;

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

export function normalizeKnowledgeCategory(value: string) {
  const category = value.trim().toLocaleLowerCase("pt-BR");
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(category)) {
    throw new Error("A categoria de conhecimento é inválida.");
  }

  return category;
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
    throw new Error("Não foi possível ler o arquivo de conhecimento.");
  } finally {
    await parser.destroy();
  }
}

function decodeBase64Content(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("O conteúdo do arquivo de conhecimento é inválido.");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.toString("base64") !== normalized) {
    throw new Error("O conteúdo do arquivo de conhecimento é inválido.");
  }

  if (buffer.byteLength === 0) {
    throw new Error("O arquivo de conhecimento não contém texto legível.");
  }

  if (buffer.byteLength > MAX_KNOWLEDGE_UPLOAD_BYTES) {
    throw new Error("O arquivo de conhecimento é muito grande.");
  }

  return buffer;
}

function getSourceKind(input: { fileName: string; mimeType: string }): SourceKind {
  const lowerFileName = input.fileName.toLocaleLowerCase("pt-BR");
  const lowerMimeType = input.mimeType.toLocaleLowerCase("pt-BR");
  const isPdfExtension = lowerFileName.endsWith(".pdf");
  const isTextExtension = lowerFileName.endsWith(".txt");
  const isPdfMime = lowerMimeType === "application/pdf";
  const isGenericMime =
    lowerMimeType === "application/octet-stream" || lowerMimeType === "text/plain;charset=utf-8";
  const isTextMime = lowerMimeType === "text/plain" || isGenericMime;

  if (isPdfExtension && isPdfMime) {
    return "pdf";
  }

  if (isTextExtension && isTextMime) {
    return "text";
  }

  throw new Error("Tipo de arquivo de conhecimento não suportado.");
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
  const buffer = decodeBase64Content(input.base64Content);
  const sourceKind = getSourceKind(input);
  const rawText = sourceKind === "pdf" ? await extractPdfText(buffer) : buffer.toString("utf8");
  const content = normalizeExtractedText(rawText);

  if (!content) {
    throw new Error("O arquivo de conhecimento não contém texto legível.");
  }

  if (content.length > MAX_KNOWLEDGE_TEXT_CHARS) {
    throw new Error("O texto extraído do arquivo de conhecimento é muito grande.");
  }

  return {
    content,
    metadata: {
      category: normalizeKnowledgeCategory(input.category),
      sourceKind,
      extractionMethod: sourceKind === "pdf" ? "pdf-parse" : "plain-text",
      extractedAt: new Date().toISOString(),
      keywords: deriveKeywords(content),
      textCharCount: content.length
    }
  };
}
