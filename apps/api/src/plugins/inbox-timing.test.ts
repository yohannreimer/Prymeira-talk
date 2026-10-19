import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { databaseWallTime, inboxTimingPlugin, measureInboxAssembly, measureInboxDatabase, measureInboxHub } from "./inbox-timing.js";

describe("inbox read timings", () => {
  it("counts parallel database operations as occupied wall time", () => {
    expect(databaseWallTime([[5, 15], [0, 10], [30, 35], [8, 12]])).toBe(20);
    expect(databaseWallTime([])).toBe(0);
  });

  it("keeps request-local context through asynchronous authorization, SQL and serialization", async () => {
    const app = Fastify();
    await app.register(inboxTimingPlugin);
    app.get("/conversations", async () => {
      await measureInboxHub(() => new Promise(resolve => setTimeout(resolve, 3)));
      await Promise.all([measureInboxDatabase(() => new Promise(resolve => setTimeout(resolve, 5))),
        measureInboxDatabase(() => new Promise(resolve => setTimeout(resolve, 8)))]);
      return measureInboxAssembly(() => [{id: "fixture"}]);
    });
    app.get("/unrelated", async () => ({ok: true}));
    try {
      const responses = await Promise.all([app.inject("/conversations"), app.inject("/conversations")]);
      for (const response of responses) {
        expect(response.headers["cache-control"]).toBe("private, no-store");
        const header = String(response.headers["server-timing"]);
        expect(header).toMatch(/hub;dur=/); expect(header).toMatch(/db_wait;dur=/); expect(header).toMatch(/serialize;dur=/);
        const db = Number(header.match(/db_wait;dur=([\d.]+)/)![1]);
        expect(db).toBeGreaterThan(0);
        expect(response.json()).toEqual([{id: "fixture"}]);
      }
      expect((await app.inject("/unrelated")).headers["server-timing"]).toBeUndefined();
    } finally {await app.close();}
  });
});
