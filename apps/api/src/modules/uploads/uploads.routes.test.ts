import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeWorkspaceAsset } from "./uploads.routes.js";

const createdDirs: string[] = [];

async function createUploadDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "talk-uploads-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("storeWorkspaceAsset", () => {
  it("stores a workspace asset and returns its public url", async () => {
    const uploadDir = await createUploadDir();

    const stored = await storeWorkspaceAsset({
      uploadDir,
      publicTalkUrl: "https://talk.example.com",
      workspaceId: "workspace_a",
      fileName: "Catálogo Villefer.pdf",
      base64: Buffer.from("pdf test").toString("base64"),
      maxBytes: 1024
    });

    expect(stored.size).toBe("pdf test".length);
    expect(stored.url).toMatch(
      /^https:\/\/talk\.example\.com\/uploads\/automations\/workspace_a\//
    );
    expect(stored.url.endsWith(".pdf")).toBe(true);

    const storedFileName = path.basename(new URL(stored.url).pathname);
    const contents = await readFile(
      path.join(uploadDir, "automations", "workspace_a", storedFileName),
      "utf8"
    );
    expect(contents).toBe("pdf test");
  });

  it("rejects assets above the size limit", async () => {
    const uploadDir = await createUploadDir();

    await expect(
      storeWorkspaceAsset({
        uploadDir,
        publicTalkUrl: "https://talk.example.com",
        workspaceId: "workspace_a",
        fileName: "grande.pdf",
        base64: Buffer.from("conteudo grande").toString("base64"),
        maxBytes: 4
      })
    ).rejects.toThrow("UPLOAD_TOO_LARGE");
  });
});