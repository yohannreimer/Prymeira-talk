import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./test/build-app.js";

describe("app", () => {
  it("returns health status", async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, product: "talk" });
    } finally {
      await app.close();
    }
  });

  it("returns ready only when the database check succeeds", async () => {
    const readinessCheck = vi.fn().mockResolvedValue(undefined);
    const requireProductAccess = vi.fn();
    const app = await buildApp(
      {},
      { authEnabled: true, readinessCheck, requireProductAccess }
    );

    try {
      const response = await app.inject({ method: "GET", url: "/ready" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, product: "talk" });
      expect(readinessCheck).toHaveBeenCalledTimes(1);
      expect(requireProductAccess).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 503 without leaking database errors", async () => {
    const app = await buildApp(
      {},
      {
        readinessCheck: vi
          .fn()
          .mockRejectedValue(new Error("postgresql://user:secret@database/internal"))
      }
    );

    try {
      const response = await app.inject({ method: "GET", url: "/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, product: "talk" });
      expect(response.body).not.toContain("postgresql://user:secret@database/internal");
    } finally {
      await app.close();
    }
  });

  it("allows browser preflight requests for PATCH endpoints", async () => {
    const app = await buildApp({}, { authEnabled: false, prismaEnabled: false });

    try {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/board-memberships/membership_1",
        headers: {
          origin: "http://localhost:5176",
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "authorization,content-type"
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    } finally {
      await app.close();
    }
  });

  it("exposes realtime hub on the root app after registration", async () => {
    const app = await buildApp({}, { authEnabled: false, prismaEnabled: false });

    try {
      expect(app.realtime.publish).toEqual(expect.any(Function));
    } finally {
      await app.close();
    }
  });

  it("skips auth for health requests with a query string", async () => {
    const requireProductAccess = vi.fn();
    const fetchProducts = vi.fn();
    const app = await buildApp(
      {},
      { authEnabled: true, requireProductAccess, fetch: fetchProducts }
    );

    try {
      const response = await app.inject({ method: "GET", url: "/health?x=1" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, product: "talk" });
      expect(requireProductAccess).not.toHaveBeenCalled();
      expect(fetchProducts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 401 for /me without a token", async () => {
    const requireProductAccess = vi.fn();
    const fetchProducts = vi.fn();
    const app = await buildApp(
      {},
      { authEnabled: true, requireProductAccess, fetch: fetchProducts }
    );

    try {
      const response = await app.inject({ method: "GET", url: "/me" });

      expect(response.statusCode).toBe(401);
      expect(requireProductAccess).not.toHaveBeenCalled();
      expect(fetchProducts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("uses explicit local auth bypass after a bearer token is present", async () => {
    const requireProductAccess = vi.fn();
    const fetchProducts = vi.fn();
    const app = await buildApp(
      {
        PRYMEIRA_LOCAL_AUTH_BYPASS: true,
        PRYMEIRA_LOCAL_WORKSPACE_ID: "local_test_workspace",
        PRYMEIRA_LOCAL_ROLE: "owner"
      },
      { authEnabled: true, requireProductAccess, fetch: fetchProducts }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer clerk-token" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ workspaceId: "local_test_workspace", role: "owner" });
      expect(requireProductAccess).not.toHaveBeenCalled();
      expect(fetchProducts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 403 when product access is denied", async () => {
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        requireProductAccess: vi.fn(async () => ({
          allowed: false,
          product_key: "talk",
          workspace_id: "workspace_1",
          status: "disabled",
          reason: "denied"
        })),
        fetch: vi.fn()
      }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer clerk-token" }
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("preserves 401 errors from product access checks", async () => {
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        requireProductAccess: vi.fn(async () => {
          throw Object.assign(new Error("No session"), { statusCode: 401 });
        }),
        fetch: vi.fn()
      }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer expired-token" }
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("does not authenticate /me with a query token", async () => {
    const requireProductAccess = vi.fn();
    const fetchProducts = vi.fn();
    const app = await buildApp(
      {},
      { authEnabled: true, requireProductAccess, fetch: fetchProducts }
    );

    try {
      const response = await app.inject({ method: "GET", url: "/me?token=abc" });

      expect(response.statusCode).toBe(401);
      expect(requireProductAccess).not.toHaveBeenCalled();
      expect(fetchProducts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not authenticate realtime with a query token", async () => {
    const requireProductAccess = vi.fn();
    const fetchProducts = vi.fn();
    const app = await buildApp(
      {},
      { authEnabled: true, requireProductAccess, fetch: fetchProducts }
    );

    try {
      const response = await app.inject({ method: "GET", url: "/realtime?token=abc" });

      expect(response.statusCode).toBe(401);
      expect(requireProductAccess).not.toHaveBeenCalled();
      expect(fetchProducts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("authenticates realtime with a websocket protocol token", async () => {
    const requireProductAccess = vi.fn(async () => ({
      allowed: true,
      product_key: "talk",
      status: "active",
      reason: "allowed",
      workspace_id: "workspace_ws",
      product_role: "agent"
    }));
    const fetchProducts = vi.fn();
    const app = await buildApp(
      {},
      { authEnabled: true, requireProductAccess, fetch: fetchProducts }
    );

    try {
      await app.ready();
      const socket = await app.injectWS("/realtime", {
        socket: { remoteAddress: "127.0.0.1" } as Socket,
        headers: { "sec-websocket-protocol": "prymeira-talk-auth, token_ws" }
      });

      expect(requireProductAccess).toHaveBeenCalledWith("talk", {
        accountApiUrl: "http://localhost:3001",
        clerkToken: "token_ws"
      });

      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("returns workspace id and role from an allowed access decision", async () => {
    const fetchAccess = vi.fn();
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        requireProductAccess: vi.fn(async () => ({
          allowed: true,
          product_key: "talk",
          workspace_id: "workspace_1",
          product_role: "manager",
          status: "active",
          reason: "allowed"
        })),
        fetch: fetchAccess
      }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer clerk-token" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ workspaceId: "workspace_1", role: "manager" });
      expect(fetchAccess).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("validates product access through Account access-check by default", async () => {
    const fetchAccess = vi.fn(async () =>
      new Response(
        JSON.stringify({
          allowed: true,
          product_key: "talk",
          workspace_id: "workspace_1",
          workspace_role: "owner",
          status: "active",
          reason: "allowed"
        }),
        { status: 200 }
      )
    );
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        fetch: fetchAccess
      }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer clerk-token" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ workspaceId: "workspace_1", role: "owner" });
      expect(fetchAccess).toHaveBeenCalledWith("http://localhost:3001/access-check?product_key=talk", {
        headers: { Authorization: "Bearer clerk-token" }
      });
    } finally {
      await app.close();
    }
  });

  it("returns 403 when product access omits the workspace id", async () => {
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        requireProductAccess: vi.fn(async () => ({
          allowed: true,
          product_key: "talk",
          status: "active",
          reason: "allowed"
        }))
      }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer clerk-token" }
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 403 when product access includes an empty workspace id", async () => {
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        requireProductAccess: vi.fn(async () => ({
          allowed: true,
          product_key: "talk",
          workspace_id: "",
          product_role: "owner",
          status: "active",
          reason: "allowed"
        }))
      }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer clerk-token" }
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 502 when access-check returns an upstream failure", async () => {
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        fetch: vi.fn(async () => new Response("Account unavailable", { status: 500 }))
      }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer clerk-token" }
      });

      expect(response.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it("does not skip auth for evolution-admin webhook paths", async () => {
    const requireProductAccess = vi.fn();
    const fetchProducts = vi.fn();
    const app = await buildApp(
      {},
      { authEnabled: true, requireProductAccess, fetch: fetchProducts }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/webhooks/evolution-admin"
      });

      expect(response.statusCode).toBe(401);
      expect(requireProductAccess).not.toHaveBeenCalled();
      expect(fetchProducts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("stores automation uploads and serves them from a public URL without a token", async () => {
    const uploadDir = `tmp/test-uploads-${randomUUID()}`;
    const app = await buildApp(
      {
        PRYMEIRA_LOCAL_AUTH_BYPASS: true,
        PRYMEIRA_LOCAL_WORKSPACE_ID: "workspace_uploads",
        TALK_UPLOAD_DIR: uploadDir,
        PUBLIC_TALK_URL: "https://talk.example.com/app"
      },
      { authEnabled: true, prismaEnabled: false }
    );

    try {
      const uploadResponse = await app.inject({
        method: "POST",
        url: "/automation-assets",
        headers: { authorization: "Bearer local-token" },
        payload: {
          fileName: "Proposta Final.pdf",
          mimeType: "application/pdf",
          base64: Buffer.from("pdf test").toString("base64")
        }
      });

      expect(uploadResponse.statusCode).toBe(201);
      const upload = uploadResponse.json() as { fileName: string; mimeType: string; url: string };
      expect(upload).toMatchObject({
        fileName: "Proposta Final.pdf",
        mimeType: "application/pdf"
      });
      expect(upload.url).toMatch(
        /^https:\/\/talk\.example\.com\/app\/uploads\/automations\/workspace_uploads\//
      );

      const publicPath = new URL(upload.url).pathname;
      const publicResponse = await app.inject({ method: "GET", url: publicPath });

      expect(publicResponse.statusCode).toBe(200);
      expect(publicResponse.headers["content-type"]).toContain("application/pdf");
      expect(publicResponse.body).toBe("pdf test");
    } finally {
      await app.close();
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  it("does not serve automation uploads outside the automations directory", async () => {
    const uploadDir = `tmp/test-uploads-${randomUUID()}`;
    await mkdir(`${uploadDir}/automations`, { recursive: true });
    await writeFile(`${uploadDir}/automations/secret.txt`, "do not expose");
    const app = await buildApp(
      {
        TALK_UPLOAD_DIR: uploadDir
      },
      { authEnabled: false, prismaEnabled: false }
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/uploads/automations/workspace_a/%2e%2e%2fsecret.txt"
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toBe("do not expose");
    } finally {
      await app.close();
      await rm(uploadDir, { recursive: true, force: true });
    }
  });
});
