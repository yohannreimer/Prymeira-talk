import { describe, expect, it } from "vitest";
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
});
