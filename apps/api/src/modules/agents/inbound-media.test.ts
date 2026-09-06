import { describe, expect, it, vi } from "vitest";
import { prepareInboundMedia as prepareMedia, inspectPdfImages, extractInboundVisualText, MAX_INBOUND_MEDIA_BYTES, type InboundPdfParser } from "./inbound-media.js";

function prepareInboundMedia(input: Parameters<typeof prepareMedia>[0]) {
  return prepareMedia({
    ...(input.pdfFactory ? { pdfImageInspector: async () => ({ hasRasterContent: false, imageCount: 0, totalPixels: 0 }) } : {}),
    ...input
  });
}

const settings = { active: true as const, baseUrl: "https://ai.example/v1", apiKey: "test-key", chatModel: "vision-model" };
const attachment = { fileName: "lista.pdf", mimeType: "application/pdf", base64Content: Buffer.from("%PDF-1.7\ntest").toString("base64") };
function parser(texts: string[]): InboundPdfParser {
  return {
    getInfo: vi.fn().mockResolvedValue({ total: texts.length, pages: texts.map((_, index) => ({ pageNumber: index + 1, width: 612, height: 792 })) }),
    getText: vi.fn().mockResolvedValue({ pages: texts.map((text, index) => ({ num: index + 1, text })), total: texts.length }),
    getScreenshot: vi.fn().mockResolvedValue({ pages: texts.map((_, index) => ({ pageNumber: index + 1, dataUrl: "data:image/png;base64,aW1hZ2U=" })) }),
    destroy: vi.fn().mockResolvedValue(undefined)
  };
}

function actualPdf(lines: string[], options: { width?: number; height?: number; imageDimensions?: [number, number] } = {}) {
  const stream = `BT /F1 12 Tf ${lines.map((line, row) => line.split("  ").map((cell, column) => `1 0 0 1 ${50 + column * 170} ${750 - row * 20} Tm (${cell}) Tj`).join("\n")).join("\n")} ET${options.imageDimensions ? "\nq 100 0 0 100 50 50 cm /Im1 Do Q" : ""}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${options.width ?? 612} ${options.height ?? 792}] /Resources << /Font << /F1 4 0 R >> ${options.imageDimensions ? "/XObject << /Im1 6 0 R >>" : ""} >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  if (options.imageDimensions) objects.push(`<< /Type /XObject /Subtype /Image /Width ${options.imageDimensions[0]} /Height ${options.imageDimensions[1]} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { ...attachment, base64Content: Buffer.from(pdf).toString("base64") };
}

describe("prepareInboundMedia", () => {
  it.each([
    { pageNumber: 1, width: 612, height: 100_000 },
    { pageNumber: 1, width: 30_000, height: 30_000 },
    { pageNumber: 1, width: 1, height: 792 },
    { pageNumber: 1, width: 10_000, height: 1 },
    { pageNumber: 1, width: Infinity, height: 792 },
    { pageNumber: 1, width: 0, height: 792 }
  ])("rejects unsafe PDF page dimensions before extraction or canvas allocation: %j", async (page) => {
    const pdf = parser(["Readable customer header and long native text content"]);
    vi.mocked(pdf.getInfo).mockResolvedValue({ total: 1, pages: [page] });
    const result = await prepareInboundMedia({ attachment, settings, pdfFactory: () => pdf });
    expect(result).toMatchObject({ status: "failed", errorCode: "PDF_PAGE_TOO_LARGE" });
    expect(pdf.getText).not.toHaveBeenCalled();
    expect(pdf.getScreenshot).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalled();
  });

  it("requires complete per-page dimensions before extracting a PDF", async () => {
    const pdf = parser(["native page one with enough characters to extract", "native page two with enough characters to extract"]);
    vi.mocked(pdf.getInfo).mockResolvedValue({ total: 2, pages: [{ pageNumber: 1, width: 612, height: 792 }] });
    const result = await prepareInboundMedia({ attachment, settings, pdfFactory: () => pdf });
    expect(result).toMatchObject({ status: "failed", errorCode: "PDF_INCOMPLETE" });
    expect(pdf.getText).not.toHaveBeenCalled();
  });

  it("rejects a real PDF image exceeding the decoder bound without silently accepting its text", async () => {
    const result = await prepareInboundMedia({ attachment: actualPdf(["Long readable text header but oversized raster data below"], { imageDimensions: [10_000, 10_000] }), settings });
    expect(result).toMatchObject({ status: "failed", errorCode: "PDF_IMAGE_TOO_LARGE" });
    expect(result.extractedText).toBeUndefined();
  });

  it("rejects a real extreme-height PDF before calling visual extraction", async () => {
    const visionExtract = vi.fn();
    const result = await prepareInboundMedia({ attachment: actualPdf([], { height: 100_000 }), settings, visionExtract });
    expect(result).toMatchObject({ status: "failed", errorCode: "PDF_PAGE_TOO_LARGE" });
    expect(visionExtract).not.toHaveBeenCalled();
  });
  it("extracts a real native PDF with installed pdf-parse and retains line breaks", async () => {
    const result = await prepareInboundMedia({ attachment: actualPdf(["Material  Quantidade  Medida", "Tubo aco  12  50 x 30 x 2 mm", "Barra chata  3  2 x 1/4 polegadas"]), settings: { active: false, reason: "not_configured" } });
    expect(result).toMatchObject({ status: "processed", pages: 1 });
    expect(result.extractedText).toMatch(/Tubo aco\s+12\s+50 x 30 x 2 mm\nBarra chata/);
  });

  it("renders a real PDF page without a text layer to PNG for vision extraction", async () => {
    const visionExtract = vi.fn().mockResolvedValue("Página 1\nTubo 20 x 20: 5 peças");
    const result = await prepareInboundMedia({ attachment: actualPdf([]), settings, visionExtract });
    expect(result).toMatchObject({ status: "processed", pages: 1 });
    expect(visionExtract).toHaveBeenCalledOnce();
    const images = visionExtract.mock.calls[0][0].images;
    expect(images[0]).toMatch(/^data:image\/png;base64,iVBORw/);
  });

  it("renders mixed raster/text PDFs even when their text header is readable", async () => {
    const pdf = parser(["Long readable header without the scanned customer list below it"]);
    const visionExtract = vi.fn().mockResolvedValue("Título\nTubo aço\t12\t50 x 30 x 2 mm");
    const result = await prepareInboundMedia({ attachment, settings, pdfFactory: () => pdf, pdfImageInspector: async () => ({ hasRasterContent: true, imageCount: 1, totalPixels: 1_000_000 }), visionExtract });
    expect(result.status).toBe("processed");
    expect(pdf.getScreenshot).toHaveBeenCalledOnce();
    expect(result.extractedText).toContain("Tubo aço");
  });
  it("uses a dedicated literal extraction request and preserves content beyond the reply cap", async () => {
    const literal = Array.from({ length: 30 }, (_, i) => `${i + 1}\tTubo aço\t50 x 30 x 2 mm\t12 peças`).join("\n");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ complete: true, pages: [{ page: 1, text: literal }] }) } }] }), { status: 200 }));
    const text = await extractInboundVisualText({ settings, images: ["data:image/png;base64,aW1hZ2U="], fetchImpl });
    expect(text).toContain(literal);
    expect(text.length).toBeGreaterThan(500);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://ai.example/v1/chat/completions");
    const body = JSON.parse(request.body);
    expect(body.messages[0].content).toContain("não confiável");
    expect(body.messages[0].content).not.toContain("500");
    expect(body.tools).toBeUndefined();
  });

  it("uses the configured gpt-5.6 proxy request conventions for visual extraction", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ complete: true, pages: [{ page: 1, text: "Tubo 20 x 20 mm, 5 pecas" }] }) } }] })));
    await extractInboundVisualText({ settings: { ...settings, chatModel: "gpt-5.6-luna" }, images: ["data:image/png;base64,aQ=="], fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "gpt-5.6-luna", reasoning_effort: "none", max_completion_tokens: 8192 });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it.each([
    { complete: false, pages: [{ page: 1, text: "ilegível" }] },
    { complete: true, pages: [{ page: 2, text: "page mismatch" }] },
    { complete: true, pages: [] },
    { complete: true, pages: [{ page: 1, text: "" }] }
  ])("rejects unreadable or incomplete visual extraction", async (result) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] })));
    await expect(extractInboundVisualText({ settings, images: ["data:image/png;base64,aQ=="], fetchImpl })).rejects.toThrow();
  });
  it("preserves PDF lines, columns and every page as customer data", async () => {
    const pdf = parser(["Material\tQuantidade\tMedida\nTubo aço\t12\t50 x 30 x 2 mm", "Material\tQuantidade\tMedida\nBarra chata\t3\t2 x 1/4 polegadas"]);
    const result = await prepareInboundMedia({ attachment, settings, pdfFactory: () => pdf });
    expect(result.status).toBe("processed");
    expect(result.extractedText).toContain("Tubo aço\t12\t50 x 30 x 2 mm");
    expect(result.extractedText).toContain("Página 2");
    expect(result.pages).toBe(2);
    expect(pdf.destroy).toHaveBeenCalled();
  });

  it("rejects more than five PDF pages before extracting or silently omitting pages", async () => {
    const pdf = parser(Array(6).fill("long enough native content"));
    const result = await prepareInboundMedia({ attachment, settings, pdfFactory: () => pdf });
    expect(result).toMatchObject({ status: "failed", errorCode: "PDF_TOO_MANY_PAGES" });
    expect(pdf.getText).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalled();
  });

  it("renders scanned PDFs and transcribes all pages in one vision call", async () => {
    const pdf = parser(["", ""]);
    const visionExtract = vi.fn().mockResolvedValue("Página 1\nTubo 20 x 20: 5 peças\nPágina 2\nBarra 1/4: 8 peças");
    const result = await prepareInboundMedia({ attachment, settings, pdfFactory: () => pdf, visionExtract });
    expect(result).toMatchObject({ status: "processed", pages: 2 });
    expect(visionExtract).toHaveBeenCalledOnce();
    expect(visionExtract.mock.calls[0][0].images).toHaveLength(2);
  });

  it.each(["incomplete", "corrupt"])("safely fails %s PDFs without agent inference", async (kind) => {
    const pdf = parser(["", ""]);
    if (kind === "corrupt") vi.mocked(pdf.getInfo).mockRejectedValue(new Error("private provider details"));
    else vi.mocked(pdf.getScreenshot).mockResolvedValue({ pages: [{ pageNumber: 1, dataUrl: "data:image/png;base64,aQ==" }] });
    const visionExtract = vi.fn();
    const result = await prepareInboundMedia({ attachment, settings, pdfFactory: () => pdf, visionExtract });
    expect(result.status).toBe("failed");
    expect(result.fallback).toMatch(/reenviar/i);
    expect(JSON.stringify(result)).not.toContain("private provider details");
    expect(visionExtract).not.toHaveBeenCalled();
  });

  it("enforces encoded size before decode and rejects malformed encoding and arbitrary URLs", async () => {
    for (const base64Content of ["https://internal/file", "!not-base64!", "A".repeat(Math.ceil(MAX_INBOUND_MEDIA_BYTES / 3) * 4 + 4)]) {
      const result = await prepareInboundMedia({ attachment: { ...attachment, base64Content }, settings });
      expect(result.status).toBe("failed");
    }
  });

  it("uses the configured audio transcriber and requires a real provider for visual extraction", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "Preciso de 12 tubos de 6 metros", playback: null });
    const result = await prepareInboundMedia({ attachment: { fileName: "pedido.mp3", mimeType: "audio/mpeg", base64Content: "YXVkaW8=" }, settings, audioTranscriberFactory: () => ({ transcribe }) });
    expect(result).toMatchObject({ status: "processed", kind: "audio", extractedText: "Preciso de 12 tubos de 6 metros" });
    const image = await prepareInboundMedia({ attachment: { fileName: "pedido.png", mimeType: "image/png", base64Content: "aW1hZ2U=" }, settings: { active: false, reason: "simulated" } });
    expect(image).toMatchObject({ status: "failed", errorCode: "MEDIA_PROVIDER_UNAVAILABLE" });
  });
});

describe("bounded PDF image metadata inspection", () => {
  const header = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n";
  const listing = (width: number, height: number, count = 1) => header + Array.from({ length: count }, (_, index) => `1 ${index} image ${width} ${height} rgb 3 8 image no 3 0 100 100 1K 1%`).join("\n");

  it("recognizes bounded raster images from metadata without decoding them", async () => {
    const result = await inspectPdfImages(Buffer.from("pdf"), async () => ({ stdout: listing(1132, 1600), stderr: "" }));
    expect(result).toEqual({ hasRasterContent: true, imageCount: 1, totalPixels: 1_811_200 });
    await expect(inspectPdfImages(Buffer.from("pdf"), async () => ({ stdout: header, stderr: "" }))).resolves.toEqual({ hasRasterContent: false, imageCount: 0, totalPixels: 0 });
  });

  it.each([listing(10_000, 10_000), listing(2000, 2000, 8), listing(10, 10, 51)])("rejects per-image, aggregate and image-count excess before decoding", async (stdout) => {
    await expect(inspectPdfImages(Buffer.from("pdf"), async () => ({ stdout, stderr: "" }))).rejects.toMatchObject({ code: "PDF_IMAGE_TOO_LARGE" });
  });

  it.each([
    { stdout: "", stderr: "" },
    { stdout: "unexpected listing", stderr: "" },
    { stdout: header + "1 0 image NaN 500 rgb", stderr: "" },
    { stdout: header, stderr: "Syntax Warning: truncated stream" }
  ])("fails closed on missing or malformed metadata and parser warnings", async (result) => {
    await expect(inspectPdfImages(Buffer.from("pdf"), async () => result)).rejects.toMatchObject({ code: "PDF_IMAGE_INSPECTION_FAILED" });
  });

  it("fails closed when the metadata command is unavailable or times out", async () => {
    for (const code of ["ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
      await expect(inspectPdfImages(Buffer.from("pdf"), async () => { throw Object.assign(new Error("private filesystem information"), { code }); })).rejects.toMatchObject({ code: "PDF_IMAGE_INSPECTION_FAILED" });
    }
  });
});
