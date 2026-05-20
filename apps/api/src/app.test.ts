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

  it("returns 403 when product access is denied", async () => {
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        requireProductAccess: vi.fn(async () => ({
          allowed: false,
          product_key: "talk",
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

  it("returns workspace id and role from allowed account products", async () => {
    const app = await buildApp(
      {},
      {
        authEnabled: true,
        requireProductAccess: vi.fn(async () => ({
          allowed: true,
          product_key: "talk",
          status: "active",
          reason: "allowed"
        })),
        fetch: vi.fn(async () =>
          new Response(
            JSON.stringify({
              workspace: { id: "workspace_1", role: "agent" },
              products: [
                {
                  product_key: "talk",
                  allowed: true,
                  workspace_id: "workspace_1",
                  product_role: "manager"
                }
              ]
            }),
            { status: 200 }
          )
        )
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
});
