import { describe, expect, it } from "vitest";
import { whatsappPhoneCandidates } from "./lead-whatsapp-numbers.js";

describe("WhatsApp phone candidates", () => {
  it.each([
    ["+55 (47) 99139-6920", { key: "554791396920", primary: "5547991396920", alternate: "554791396920" }],
    ["(47) 99139-6920", { key: "554791396920", primary: "5547991396920", alternate: "554791396920" }],
    ["554791396920", { key: "554791396920", primary: "554791396920", alternate: "5547991396920" }],
    ["(47) 3333-4444", { key: "554733334444", primary: "554733334444", alternate: null }],
    ["554733334444", { key: "554733334444", primary: "554733334444", alternate: null }],
    ["14155552671", { key: "14155552671", primary: "14155552671", alternate: null }]
  ] as const)("builds safe candidates for %s", (value, expected) => {
    expect(whatsappPhoneCandidates(value)).toEqual(expected);
  });

  it("rejects values without a plausible phone length", () => {
    expect(whatsappPhoneCandidates("invalid")).toBeNull();
  });
});
