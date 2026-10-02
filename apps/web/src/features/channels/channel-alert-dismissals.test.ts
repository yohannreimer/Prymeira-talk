import { describe, expect, it } from "vitest";
import {
  DISMISSALS_STORAGE_KEY, dismissProblem, isDismissed, pruneDismissals, readDismissals, writeDismissals
} from "./channel-alert-dismissals";
import type { ChannelProblem } from "./channel-problems";

const HOUR = 3_600_000;
const NOW = new Date("2026-10-02T15:00:00.000Z");
const problem = (over: Partial<ChannelProblem> = {}): ChannelProblem => ({
  channelId: "c1", tone: "danger", title: "Vendas 6 está desconectado", detail: "x", ...over
});
const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};
const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };

describe("dismissProblem / isDismissed", () => {
  it("dispensa por 8 horas com assinatura tone|title", () => {
    const map = dismissProblem({}, problem(), NOW);
    expect(map.c1).toEqual({ signature: "danger|Vendas 6 está desconectado", until: NOW.getTime() + 8 * HOUR });
    expect(isDismissed(map, problem(), NOW)).toBe(true);
  });
  it("não muta o mapa original", () => {
    const base = {};
    dismissProblem(base, problem(), NOW);
    expect(base).toEqual({});
  });
  it("volta a aparecer depois de expirar", () => {
    const map = dismissProblem({}, problem(), NOW);
    expect(isDismissed(map, problem(), new Date(NOW.getTime() + 8 * HOUR - 1))).toBe(true);
    expect(isDismissed(map, problem(), new Date(NOW.getTime() + 8 * HOUR))).toBe(false);
  });
  it("volta a aparecer quando o problema muda", () => {
    const map = dismissProblem({}, problem({ tone: "info", title: "Vendas 6 está reconectando" }), NOW);
    expect(isDismissed(map, problem({ tone: "info", title: "Vendas 6 está reconectando" }), NOW)).toBe(true);
    expect(isDismissed(map, problem({ tone: "danger", title: "Vendas 6 precisa ser reconectado" }), NOW)).toBe(false);
  });
  it("não dispensa outro canal e inclui o watchdog", () => {
    const map = dismissProblem({}, problem({ channelId: "watchdog", tone: "warning", title: "W" }), NOW);
    expect(isDismissed(map, problem(), NOW)).toBe(false);
    expect(isDismissed(map, problem({ channelId: "watchdog", tone: "warning", title: "W" }), NOW)).toBe(true);
  });
});

describe("pruneDismissals", () => {
  it("remove entradas expiradas e mantém as válidas", () => {
    const map = { a: { signature: "s", until: NOW.getTime() - 1 }, b: { signature: "s", until: NOW.getTime() + 1 } };
    expect(pruneDismissals(map, NOW)).toEqual({ b: map.b });
  });
});

describe("readDismissals / writeDismissals", () => {
  it("faz ida e volta pelo storage", () => {
    const storage = fakeStorage();
    const map = dismissProblem({}, problem(), NOW);
    writeDismissals(map, storage);
    expect(storage.data[DISMISSALS_STORAGE_KEY]).toBeTruthy();
    expect(readDismissals(storage)).toEqual(map);
  });
  it("storage ausente ou que lança não quebra", () => {
    expect(readDismissals(undefined)).toEqual({});
    expect(readDismissals(throwing)).toEqual({});
    expect(() => writeDismissals({}, throwing)).not.toThrow();
  });
  it("ignora JSON malformado e formatos inválidos", () => {
    expect(readDismissals(fakeStorage({ [DISMISSALS_STORAGE_KEY]: "{oops" }))).toEqual({});
    expect(readDismissals(fakeStorage({ [DISMISSALS_STORAGE_KEY]: "[1,2]" }))).toEqual({});
    expect(readDismissals(fakeStorage({ [DISMISSALS_STORAGE_KEY]: JSON.stringify({ a: { signature: 1, until: "x" }, b: { signature: "s", until: 5 } }) })))
      .toEqual({ b: { signature: "s", until: 5 } });
  });
});
