import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

describe("campaign delivery queue schema", () => {
  it("stores a durable snapshot and lease for each queued recipient", () => {
    const queued = {
      status: "pending",
      phoneSnapshot: "5547999999999",
      channelId: "11111111-1111-4111-8111-111111111111",
      sequenceNumber: 1,
      gapSeconds: 150,
      pauseSeconds: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      verifiedAt: null,
    } satisfies Pick<Prisma.CampaignRecipientUncheckedCreateInput,
      "status" | "phoneSnapshot" | "channelId" | "sequenceNumber" |
      "gapSeconds" | "pauseSeconds" | "leaseToken" | "leaseExpiresAt" | "verifiedAt">;

    expect(queued.gapSeconds).toBe(150);
  });
});
