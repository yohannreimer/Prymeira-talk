import { describe, expect, it } from "vitest";
import { aggregateLeadWhatsappStatus } from "./lead-whatsapp-status.js";

describe("lead WhatsApp status", () => {
  it.each([
    [2, ["unavailable", "available"], "available"],
    [2, ["unavailable", "checking"], "checking"],
    [2, ["unavailable", "failed"], "failed"],
    [2, ["unavailable", "unavailable"], "unavailable"],
    [2, ["unavailable"], "unverified"],
    [2, [], "unverified"]
  ] as const)("returns %s phones and %j checks as %s", (phoneCount, statuses, expected) => {
    expect(aggregateLeadWhatsappStatus(phoneCount, [...statuses])).toBe(expected);
  });
});
