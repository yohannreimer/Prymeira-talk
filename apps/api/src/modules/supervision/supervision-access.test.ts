import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authContextPlugin } from "../../plugins/auth-context.js";
import { validateSupervisionAccess } from "./supervision-access.js";

const grant = { id: "00000000-0000-4000-8000-000000000001", supervisor_customer_id: "00000000-0000-4000-8000-000000000002",
  seller_customer_id: "00000000-0000-4000-8000-000000000003", workspace_id: "00000000-0000-4000-8000-000000000004",
  channel_id: "00000000-0000-4000-8000-000000000005", seller_name: "Ana", seller_email: "ana@example.test" };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

async function appWith(fetch: typeof globalThis.fetch) {
  const app = Fastify(); apps.push(app);
  const requireProductAccess = vi.fn().mockResolvedValue({ allowed: false, product_key: "talk", status: "locked", reason: "no_product_seat" });
  await app.register(authContextPlugin, { accountApiUrl: "http://hub.test", productKey: "talk", fetch, requireProductAccess });
  app.get("/supervision/summary", async request => ({ access: request.supervision, sellerContext: request.talk ?? null }));
  app.get("/supervision/admin/channels", async request => ({ access: request.supervision }));
  app.post("/conversations/test/messages", async () => ({ wrote: true }));
  return { app, requireProductAccess };
}

describe("supervision authorization boundary", () => {
  it("validates every read at Hub and never installs a seller workspace context", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ grants: [grant] })));
    // Responses have single-use bodies, so each request receives a fresh one.
    fetch.mockImplementation(async () => new Response(JSON.stringify({ grants: [grant] })));
    const { app, requireProductAccess } = await appWith(fetch);
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ url: "/supervision/summary", headers: { authorization: "Bearer supervisor" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().sellerContext).toBeNull();
      expect(response.json().access.kind).toBe("viewer");
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("http://hub.test/me/talk-supervision", expect.objectContaining({
      headers: { Authorization: "Bearer supervisor" }, cache: "no-store", signal: expect.any(AbortSignal)
    }));
    expect(requireProductAccess).not.toHaveBeenCalled();
  });

  it("blocks writes, missing authentication and normal product writes without normal access", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ grants: [grant] })));
    const { app, requireProductAccess } = await appWith(fetch);
    expect((await app.inject({ url: "/supervision/summary" })).statusCode).toBe(401);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"] as const) {
      expect((await app.inject({ method, url: "/supervision/summary", headers: { authorization: "Bearer supervisor" } })).statusCode).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
    const regularWrite = await app.inject({ method: "POST", url: "/conversations/test/messages", headers: { authorization: "Bearer supervisor" } });
    expect(regularWrite.statusCode).toBe(403);
    expect(requireProductAccess).toHaveBeenCalledOnce();
  });

  it("requires live administrator verification for channel discovery", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ admin: true })));
    const { app } = await appWith(fetch);
    const response = await app.inject({ url: "/supervision/admin/channels", headers: { authorization: "Bearer admin" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().access).toEqual({ kind: "admin" });
    expect(fetch.mock.calls[0][0]).toBe("http://hub.test/admin/session");
    fetch.mockImplementation(async () => new Response(JSON.stringify({ grants: [grant] })));
    expect((await app.inject({ url: "/supervision/admin/channels", headers: { authorization: "Bearer supervisor" } })).statusCode).toBe(403);
  });

  it("fails closed for revocation, malformed grants, mixed identities, duplicates and upstream failure", async () => {
    const input = { accountApiUrl: "http://hub.test", token: "token", admin: false };
    const cases: [unknown, number][] = [
      [{ grants: [] }, 403], [{ grants: [{ ...grant, channel_id: "invented" }] }, 502],
      [{ grants: [grant, grant] }, 502],
      [{ grants: [grant, { ...grant, channel_id: grant.id, supervisor_customer_id: grant.seller_customer_id }] }, 502],
      [{ admin: true }, 502]
    ];
    for (const [body, statusCode] of cases) {
      await expect(validateSupervisionAccess({ ...input, fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body))) }))
        .rejects.toMatchObject({ statusCode });
    }
    await expect(validateSupervisionAccess({ ...input, fetch: vi.fn().mockRejectedValue(new Error("timeout")) })).rejects.toMatchObject({ statusCode: 502 });
    for (const [status, expected] of [[401, 401], [403, 403], [500, 502]]) {
      await expect(validateSupervisionAccess({ ...input, fetch: vi.fn().mockResolvedValue(new Response("", { status })) }))
        .rejects.toMatchObject({ statusCode: expected });
    }
  });
});
