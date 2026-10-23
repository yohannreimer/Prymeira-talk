import { describe, expect, it } from "vitest";
import { inboundMediaFallback, prepareInboundMedia } from "./inbound-media.js";

describe("video failure keeps the actual attachment type", () => {
  it("does not call an MP4 a PDF when the inbox stored it as a file", async () => {
    const result = await prepareInboundMedia({
      kind: "document",
      settings: { active: false, reason: "not_configured" },
      attachment: { fileName: "video.mp4", mimeType: "video/mp4", base64Content: Buffer.from("video").toString("base64") }
    });
    expect(result.status).toBe("failed");
    expect(result.fallback).toMatch(/vídeo/);
    expect(result.fallback).not.toMatch(/PDF|páginas/);
  });
  it("preserves PDF and audio fallback behavior", () => {
    expect(inboundMediaFallback("document")).toContain("PDF");
    expect(inboundMediaFallback("audio")).toContain("áudio");
  });
  it("uses the persisted transport MIME when an oversized durable video fails before download", async () => {
    const result = await prepareInboundMedia({ kind: "document", mimeType: "video/mp4", mediaUrl: "https://media.example/video", settings: { active: false, reason: "not_configured" }, mediaResolver: async () => { throw Object.assign(new Error("too big"), { code: "MEDIA_TOO_LARGE" }); } });
    expect(result).toMatchObject({ status: "failed", errorCode: "MEDIA_TOO_LARGE", fallback: expect.stringContaining("vídeo") });
    expect(result.fallback).not.toMatch(/PDF|páginas/);
  });
});
