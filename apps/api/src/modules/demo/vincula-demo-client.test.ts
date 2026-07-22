import { describe, expect, it, vi } from "vitest";
import { createVinculaDemoClient } from "./vincula-demo-client.js";

describe("Vincula demo client", () => {
  it("resets the protected Vincula demo with the configured token", async () => {
    const vinculaResult = {
      ok: true,
      workspaceId: "70000000-0000-4000-8000-000000000001",
      sales: 5,
      companies: 9,
      contacts: 9,
      deals: 6,
      notes: 6
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(vinculaResult),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createVinculaDemoClient({
      resetUrl: "http://localhost:3003/api/demo/reset",
      token: "local-demo-token",
      fetch
    });

    await expect(client.reset()).resolves.toEqual(vinculaResult);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3003/api/demo/reset",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer local-demo-token" },
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("fails before making a request when reset configuration is incomplete", async () => {
    const fetch = vi.fn();
    const client = createVinculaDemoClient({ fetch });

    await expect(client.reset()).rejects.toThrow("Vincula demo reset is not configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a rejected reset response", async () => {
    const client = createVinculaDemoClient({
      resetUrl: "http://localhost:3003/api/demo/reset",
      token: "wrong-token",
      fetch: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }))
    });

    await expect(client.reset()).rejects.toThrow("Vincula demo reset failed with status 401");
  });

  it("rejects invalid JSON returned by Vincula", async () => {
    const client = createVinculaDemoClient({
      resetUrl: "http://localhost:3003/api/demo/reset",
      token: "local-demo-token",
      fetch: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 }))
    });

    await expect(client.reset()).rejects.toThrow("Vincula demo reset returned invalid JSON");
  });

  it.each([
    ["an unsuccessful result", { ok: false }],
    [
      "missing fields",
      {
        ok: true,
        workspaceId: "70000000-0000-4000-8000-000000000001",
        sales: 5
      }
    ],
    [
      "a different workspace",
      {
        ok: true,
        workspaceId: "customer-workspace",
        sales: 5,
        companies: 9,
        contacts: 9,
        deals: 6,
        notes: 6
      }
    ],
    [
      "unexpected counts",
      {
        ok: true,
        workspaceId: "70000000-0000-4000-8000-000000000001",
        sales: 5,
        companies: 9,
        contacts: 8,
        deals: 6,
        notes: 6
      }
    ],
    [
      "unexpected fields",
      {
        ok: true,
        workspaceId: "70000000-0000-4000-8000-000000000001",
        sales: 5,
        companies: 9,
        contacts: 9,
        deals: 6,
        notes: 6,
        users: 5
      }
    ]
  ])("rejects %s", async (_label, payload) => {
    const client = createVinculaDemoClient({
      resetUrl: "http://localhost:3003/api/demo/reset",
      token: "local-demo-token",
      fetch: vi.fn().mockResolvedValue(Response.json(payload))
    });

    await expect(client.reset()).rejects.toThrow("Vincula demo reset returned an invalid payload");
  });
});
