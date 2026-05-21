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

  it("returns 403 when account products do not include Talk", async () => {
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
              workspace: { id: "workspace_1", role: "owner" },
              products: [
                {
                  product_key: "operis",
                  allowed: true,
                  workspace_id: "workspace_1"
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

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 403 when account products omit the Talk workspace id", async () => {
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
              workspace: { id: "workspace_1", role: "owner" },
              products: [
                {
                  product_key: "talk",
                  allowed: true,
                  product_role: "owner"
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

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 403 when account products include an empty Talk workspace id", async () => {
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
              workspace: { id: "workspace_1", role: "owner" },
              products: [
                {
                  product_key: "talk",
                  allowed: true,
                  workspace_id: "",
                  product_role: "owner"
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

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 502 when account products returns an upstream failure", async () => {
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
});
