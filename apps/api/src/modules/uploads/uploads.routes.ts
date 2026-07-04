import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const MAX_AUTOMATION_ASSET_BYTES = 15 * 1024 * 1024;
const safeWorkspaceIdSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const safeStoredFileNameSchema = z.string().trim().min(1).max(260).regex(/^[a-zA-Z0-9._-]+$/);

const uploadAutomationAssetBodySchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(120),
  base64: z.string().min(1)
});

function safeFileName(fileName: string) {
  const parsed = path.parse(fileName.trim());
  const base = parsed.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "arquivo";
  const extension = parsed.ext
    .replace(/[^a-zA-Z0-9.]/g, "")
    .slice(0, 16);

  return `${base}${extension}`;
}

function publicUploadUrl(publicTalkUrl: string, workspaceId: string, fileName: string) {
  const baseUrl = publicTalkUrl.replace(/\/$/, "");

  return `${baseUrl}/uploads/automations/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileName)}`;
}

function publicUploadPathPrefix(publicTalkUrl: string) {
  const pathname = new URL(publicTalkUrl).pathname.replace(/\/+$/, "");
  return pathname === "/" ? "" : pathname;
}

function contentTypeForFileName(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain"
  };

  return types[extension] ?? "application/octet-stream";
}

export interface UploadsRoutesOptions {
  publicTalkUrl: string;
  uploadDir: string;
}

export const uploadsRoutes: FastifyPluginAsync<UploadsRoutesOptions> = async (app, options) => {
  async function serveAutomationAsset(request: FastifyRequest, reply: FastifyReply) {
    const params = z.object({
      workspaceId: safeWorkspaceIdSchema,
      fileName: safeStoredFileNameSchema.refine((fileName) => !fileName.includes(".."))
    }).safeParse(request.params);

    if (!params.success) {
      return reply.code(404).send({ error: "Arquivo não encontrado." });
    }

    const workspaceDir = path.resolve(options.uploadDir, "automations", params.data.workspaceId);
    const filePath = path.resolve(workspaceDir, params.data.fileName);

    if (!filePath.startsWith(`${workspaceDir}${path.sep}`)) {
      return reply.code(404).send({ error: "Arquivo não encontrado." });
    }

    try {
      const fileBuffer = await readFile(filePath);
      return reply
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .type(contentTypeForFileName(params.data.fileName))
        .send(fileBuffer);
    } catch {
      return reply.code(404).send({ error: "Arquivo não encontrado." });
    }
  }

  app.post(
    "/automation-assets",
    { bodyLimit: Math.ceil(MAX_AUTOMATION_ASSET_BYTES * 1.38) },
    async (request, reply) => {
      const body = uploadAutomationAssetBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "Invalid upload request." });
      }

      const fileBuffer = Buffer.from(body.data.base64, "base64");
      if (fileBuffer.byteLength === 0 || fileBuffer.byteLength > MAX_AUTOMATION_ASSET_BYTES) {
        return reply.code(413).send({ error: "Arquivo excede o limite de 15 MB." });
      }

      const storedFileName = `${Date.now().toString(36)}-${randomUUID()}-${safeFileName(body.data.fileName)}`;
      const workspaceDir = path.join(options.uploadDir, "automations", request.talk.workspaceId);
      const storedPath = path.join(workspaceDir, storedFileName);

      await mkdir(workspaceDir, { recursive: true });
      await writeFile(storedPath, fileBuffer);

      return reply.code(201).send({
        fileName: body.data.fileName.trim(),
        mimeType: body.data.mimeType.trim(),
        size: fileBuffer.byteLength,
        url: publicUploadUrl(options.publicTalkUrl, request.talk.workspaceId, storedFileName)
      });
    }
  );

  app.get("/uploads/automations/:workspaceId/:fileName", serveAutomationAsset);

  const publicPathPrefix = publicUploadPathPrefix(options.publicTalkUrl);
  if (publicPathPrefix) {
    app.get(`${publicPathPrefix}/uploads/automations/:workspaceId/:fileName`, serveAutomationAsset);
  }
};
