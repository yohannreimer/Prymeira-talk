import { describe, expect, it } from "vitest";
import { buildApp } from "./test/build-app.js";

describe("app security controls", () => {
  it("rate-limits repeated requests by client", async () => {
    const app = await buildApp(
      {
        RATE_LIMIT_MAX: 2,
        RATE_LIMIT_TIME_WINDOW: "1 minute"
      },
      { authEnabled: false, prismaEnabled: false }
    );

    try {
      const firstResponse = await app.inject({ method: "GET", url: "/health" });
      const secondResponse = await app.inject({ method: "GET", url: "/health" });
      const thirdResponse = await app.inject({ method: "GET", url: "/health" });

      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(thirdResponse.statusCode).toBe(429);
      expect(thirdResponse.json()).toMatchObject({
        error: { code: "RATE_LIMITED" }
      });
    } finally {
      await app.close();
    }
  });
});
