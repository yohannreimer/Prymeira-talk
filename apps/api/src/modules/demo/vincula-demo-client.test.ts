import { describe, expect, it, vi } from "vitest";
import { createVinculaDemoClient } from "./vincula-demo-client.js";

describe("Vincula demo client", () => {
  it("resets the protected Vincula demo with the configured token", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          workspaceId: "70000000-0000-4000-8000-000000000001",
          users: 5,
          companies: 4,
          contacts: 4,
          deals: 4,
          notes: 4
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createVinculaDemoClient({
      resetUrl: "http://localhost:3003/api/demo/reset",
      token: "local-demo-token",
      fetch
    });

    await expect(client.reset()).resolves.toMatchObject({ ok: true, users: 5, deals: 4 });
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
});
