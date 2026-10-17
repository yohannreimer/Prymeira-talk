import { describe, expect, it } from "vitest";
import { dataIso, horarioComercial } from "./buyer-agent.js";

describe("buyer agent helpers", () => {
  it("turns the supplier's validity into a date only when it is one", () => {
    const hoje = new Date("2026-10-19T12:00:00Z");
    expect(dataIso("30/10/2026", hoje)).toBe("2026-10-30");
    expect(dataIso("válida até 5/11", hoje)).toBe("2026-11-05");
    expect(dataIso("2026-12-01", hoje)).toBe("2026-12-01");
    expect(dataIso("15 dias", hoje)).toBeNull();
    expect(dataIso("32/13", hoje)).toBeNull();
    expect(dataIso(null, hoje)).toBeNull();
  });

  it("chases only on weekdays from 8h to 18h in São Paulo", () => {
    expect(horarioComercial(new Date("2026-10-19T11:00:00Z"))).toBe(true); // Monday 8h
    expect(horarioComercial(new Date("2026-10-19T10:59:00Z"))).toBe(false); // Monday 7h59
    expect(horarioComercial(new Date("2026-10-19T21:00:00Z"))).toBe(false); // Monday 18h
    expect(horarioComercial(new Date("2026-10-24T14:00:00Z"))).toBe(false); // Saturday
  });
});
