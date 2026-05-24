import { describe, expect, it } from "vitest";
import {
  buildPhoneLookupCandidates,
  canonicalizePhone,
  normalizePhoneForStorage
} from "./phone-normalization.js";

describe("phone normalization", () => {
  it("normalizes Brazilian mobile numbers with or without the ninth digit to the same key", () => {
    expect(canonicalizePhone("5547991396920")).toBe("554791396920");
    expect(canonicalizePhone("554791396920")).toBe("554791396920");
  });

  it("keeps only digits for stored phone values", () => {
    expect(normalizePhoneForStorage("+55 (47) 99139-6920")).toBe("554791396920");
  });

  it("looks up both Brazilian ninth-digit variants", () => {
    expect(buildPhoneLookupCandidates("554791396920")).toEqual([
      "554791396920",
      "5547991396920"
    ]);
    expect(buildPhoneLookupCandidates("5547991396920")).toEqual([
      "554791396920",
      "5547991396920"
    ]);
  });
});
