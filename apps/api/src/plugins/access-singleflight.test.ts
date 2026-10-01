import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createAccessSingleflight } from "./access-singleflight.js";
import { authContextPlugin } from "./auth-context.js";

afterEach(() => vi.useRealTimers());
const allowed = {allowed: true, product_key: "talk", status: "active", reason: "ok", workspace_id: "workspace", workspace_role: "owner"};

describe("Hub access singleflight", () => {
  it("shares only concurrent checks, revalidating settled results and revocations", async () => {
    const check = createAccessSingleflight<typeof allowed>();
    let resolve!: (value: typeof allowed) => void;
    const validate = vi.fn(() => new Promise<typeof allowed>(done => {resolve = done;}));
    const first = check("talk", "https://hub.test", "token", validate);
    const simultaneous = check("talk", "https://hub.test", "token", validate);
    await Promise.resolve();
    expect(validate).toHaveBeenCalledTimes(1);
    resolve(allowed);
    expect(await first).toEqual(await simultaneous);
    const revoked = {...allowed, allowed: false};
    expect(await check("talk", "https://hub.test", "token", async () => revoked)).toEqual(revoked);
  });

  it("does not share checks across tokens, products or Hub instances", async () => {
    const check = createAccessSingleflight<boolean>();
    const validate = vi.fn(async () => true);
    await Promise.all([
      check("talk", "hub-a", "token-a", validate), check("talk", "hub-a", "token-b", validate),
      check("crm", "hub-a", "token-a", validate), check("talk", "hub-b", "token-a", validate),
    ]);
    expect(validate).toHaveBeenCalledTimes(4);
  });

  it("aborts after three seconds even when token validation ignores cancellation, and allows recovery", async () => {
    vi.useFakeTimers();
    const check = createAccessSingleflight<boolean>();
    let signal!: AbortSignal;
    const hanging = check("talk", "hub", "token", s => {signal = s; return new Promise(() => {});});
    const rejection = expect(hanging).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(3000);
    await rejection;
    expect(signal.aborted).toBe(true);
    expect(await check("talk", "hub", "token", async () => true)).toBe(true);
  });

  it("does not cache failures", async () => {
    const check = createAccessSingleflight<boolean>();
    await expect(check("talk", "hub", "token", async () => {throw new Error("Hub down");})).rejects.toThrow("Hub down");
    expect(await check("talk", "hub", "token", async () => true)).toBe(true);
  });
});

it("enforces revocation on the next HTTP request after sharing an in-flight check", async () => {
  const app = Fastify();
  let release!: () => void;
  let revoked = false;
  const wait = new Promise<void>(resolve => {release = resolve;});
  const requireProductAccess = vi.fn(async () => {await wait; return {...allowed, allowed: !revoked};});
  await app.register(authContextPlugin, {accountApiUrl: "https://hub.test", productKey: "talk", requireProductAccess});
  app.get("/test", async request => ({workspaceId: request.talk.workspaceId}));
  await app.ready();
  try {
    const headers = {authorization: "Bearer token"};
    const first = app.inject({url: "/test", headers});
    const second = app.inject({url: "/test", headers});
    // Allow Fastify to enter both request hooks before settling validation.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requireProductAccess).toHaveBeenCalledTimes(1);
    release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    revoked = true;
    expect((await app.inject({url: "/test", headers})).statusCode).toBe(403);
    expect(requireProductAccess).toHaveBeenCalledTimes(2);
  } finally {await app.close();}
});
