import { describe, expect, it, vi } from "vitest";
import { resolveAgentMedia, type AgentMediaPolicy } from "./agent-media-resolver.js";

const imagePolicy: AgentMediaPolicy = {
  kind: "image",
  maxBytes: 10 * 1024 * 1024,
  allowedMimeTypes: new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
};

const publicResolver = vi.fn().mockResolvedValue(["203.0.113.10"]);

describe("resolveAgentMedia", () => {
  it("decodes a valid base64 image data URL", async () => {
    await expect(resolveAgentMedia({
      mediaUrl: "data:image/jpeg;base64,aW1hZ2Vt",
      policy: imagePolicy
    })).resolves.toEqual({
      bytes: Buffer.from("imagem"),
      mimeType: "image/jpeg",
      source: "data_url"
    });
  });

  it.each([
    ["data:image/jpeg;base64,%%%", "INVALID_BASE64"],
    ["data:text/plain;base64,b2k=", "UNSUPPORTED_MEDIA_TYPE"]
  ])("rejects invalid media %s", async (mediaUrl, code) => {
    await expect(resolveAgentMedia({ mediaUrl, policy: imagePolicy }))
      .rejects.toMatchObject({ code });
  });

  it("rejects decoded data over the application limit", async () => {
    await expect(resolveAgentMedia({
      mediaUrl: `data:image/jpeg;base64,${Buffer.alloc(9).toString("base64")}`,
      policy: { ...imagePolicy, maxBytes: 8 }
    })).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it.each([
    "http://127.0.0.1/media.jpg",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/media.jpg",
    "http://10.0.0.2/media.jpg"
  ])("blocks non-public literal targets: %s", async (mediaUrl) => {
    await expect(resolveAgentMedia({ mediaUrl, policy: imagePolicy }))
      .rejects.toMatchObject({ code: "MEDIA_NETWORK_BLOCKED" });
  });

  it("blocks hostnames that resolve to a private target", async () => {
    await expect(resolveAgentMedia({
      mediaUrl: "https://media.example.com/image.jpg",
      policy: imagePolicy,
      resolveHost: vi.fn().mockResolvedValue(["10.0.0.4"])
    })).rejects.toMatchObject({ code: "MEDIA_NETWORK_BLOCKED" });
  });

  it("downloads a public image with a normalized MIME type", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      Buffer.from("image"),
      { headers: { "content-type": "image/jpeg; charset=binary" } }
    ));

    await expect(resolveAgentMedia({
      mediaUrl: "https://media.example.com/image.jpg",
      policy: imagePolicy,
      fetchImpl,
      resolveHost: publicResolver
    })).resolves.toEqual({
      bytes: Buffer.from("image"),
      mimeType: "image/jpeg",
      source: "remote"
    });
  });

  it("stops when the response content-length exceeds maxBytes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      Buffer.alloc(9),
      { headers: { "content-type": "image/jpeg", "content-length": "9" } }
    ));
    await expect(resolveAgentMedia({
      mediaUrl: "https://media.example.com/image.jpg",
      policy: { ...imagePolicy, maxBytes: 8 },
      fetchImpl,
      resolveHost: publicResolver
    })).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("validates redirect targets and follows at most three redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.com/image.jpg" }
      }))
      .mockResolvedValueOnce(new Response(Buffer.from("image"), {
        headers: { "content-type": "image/png" }
      }));

    await expect(resolveAgentMedia({
      mediaUrl: "https://media.example.com/start",
      policy: imagePolicy,
      fetchImpl,
      resolveHost: publicResolver
    })).resolves.toMatchObject({ mimeType: "image/png", source: "remote" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps aborted downloads to a stable timeout error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" })
    );
    await expect(resolveAgentMedia({
      mediaUrl: "https://media.example.com/image.jpg",
      policy: imagePolicy,
      fetchImpl,
      resolveHost: publicResolver
    })).rejects.toMatchObject({ code: "MEDIA_TIMEOUT" });
  });
});
