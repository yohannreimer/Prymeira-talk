import { describe, expect, it } from "vitest";
import { decideChannelHealth, isBusinessHours, MAX_RECONNECT_ATTEMPTS, RECONNECT_BACKOFF_MS, type HealthMemory } from "./channel-health.js";

const noon = new Date("2026-10-02T15:00:00.000Z"); // sexta, 12:00 em São Paulo
const minutes = (n: number) => n * 60_000;
const fresh = (state: HealthMemory["state"] = "ok"): HealthMemory => ({ state, since: null, attempts: 0, nextAttemptAt: null });

describe("isBusinessHours", () => {
  it("vale de segunda a sábado, 8h às 19h em São Paulo", () => {
    expect(isBusinessHours(new Date("2026-10-02T15:00:00Z"))).toBe(true);   // sex 12h
    expect(isBusinessHours(new Date("2026-10-03T15:00:00Z"))).toBe(true);   // sáb 12h
    expect(isBusinessHours(new Date("2026-10-04T15:00:00Z"))).toBe(false);  // dom 12h
    expect(isBusinessHours(new Date("2026-10-02T10:00:00Z"))).toBe(false);  // sex 07h
    expect(isBusinessHours(new Date("2026-10-02T22:30:00Z"))).toBe(false);  // sex 19h30
  });
});

describe("decideChannelHealth", () => {
  it("aberto e recebendo: ok e conectado", () => {
    const d = decideChannelHealth({ evolutionState: "open", previous: null, lastInboundAt: new Date(noon.getTime() - minutes(20)), now: noon });
    expect(d).toMatchObject({ state: "ok", talkStatus: "connected", action: "none", attempts: 0 });
  });
  it("aberto mas sem receber há 3h no horário comercial: silent", () => {
    const d = decideChannelHealth({ evolutionState: "open", previous: fresh(), lastInboundAt: new Date(noon.getTime() - minutes(200)), now: noon });
    expect(d.state).toBe("silent");
    expect(d.since).toBe(noon.toISOString());
  });
  it("silêncio fora do horário comercial ou de canal dormente não alerta", () => {
    const night = new Date("2026-10-02T23:00:00Z");
    expect(decideChannelHealth({ evolutionState: "open", previous: null, lastInboundAt: new Date(night.getTime() - minutes(300)), now: night }).state).toBe("ok");
    expect(decideChannelHealth({ evolutionState: "open", previous: null, lastInboundAt: new Date(noon.getTime() - 8 * 24 * 60 * minutes(1)), now: noon }).state).toBe("ok");
    expect(decideChannelHealth({ evolutionState: "open", previous: null, lastInboundAt: null, now: noon }).state).toBe("ok");
  });
  it("conectando: reconnecting, sem agir e preservando tentativas", () => {
    const d = decideChannelHealth({ evolutionState: "connecting", previous: { ...fresh("reconnecting"), attempts: 2 }, lastInboundAt: null, now: noon });
    expect(d).toMatchObject({ state: "reconnecting", talkStatus: "connecting", action: "none", attempts: 2 });
  });
  it("fechado pela primeira vez: tenta reconectar já e agenda a próxima", () => {
    const d = decideChannelHealth({ evolutionState: "close", previous: fresh(), lastInboundAt: null, now: noon });
    expect(d).toMatchObject({ state: "reconnecting", talkStatus: "disconnected", action: "reconnect", attempts: 1 });
    expect(d.nextAttemptAt).toBe(new Date(noon.getTime() + RECONNECT_BACKOFF_MS[0]!).toISOString());
  });
  it("fechado antes da hora da próxima tentativa: espera", () => {
    const previous: HealthMemory = { state: "reconnecting", since: noon.toISOString(), attempts: 1, nextAttemptAt: new Date(noon.getTime() + minutes(2)).toISOString() };
    const d = decideChannelHealth({ evolutionState: "close", previous, lastInboundAt: null, now: new Date(noon.getTime() + minutes(1)) });
    expect(d).toMatchObject({ state: "reconnecting", action: "none", attempts: 1 });
  });
  it("na hora da próxima tentativa: reconecta de novo com espera maior", () => {
    const previous: HealthMemory = { state: "reconnecting", since: noon.toISOString(), attempts: 1, nextAttemptAt: new Date(noon.getTime() + minutes(2)).toISOString() };
    const later = new Date(noon.getTime() + minutes(3));
    const d = decideChannelHealth({ evolutionState: "close", previous, lastInboundAt: null, now: later });
    expect(d).toMatchObject({ action: "reconnect", attempts: 2 });
    expect(d.nextAttemptAt).toBe(new Date(later.getTime() + RECONNECT_BACKOFF_MS[1]!).toISOString());
  });
  it("esgotadas as tentativas: needs_qr e para de tentar", () => {
    const previous: HealthMemory = { state: "reconnecting", since: noon.toISOString(), attempts: MAX_RECONNECT_ATTEMPTS, nextAttemptAt: new Date(noon.getTime() - 1).toISOString() };
    const d = decideChannelHealth({ evolutionState: "close", previous, lastInboundAt: null, now: noon });
    expect(d).toMatchObject({ state: "needs_qr", talkStatus: "disconnected", action: "none" });
  });
  it("Evolution inalcançável: não muda nada", () => {
    const previous: HealthMemory = { state: "silent", since: "2026-10-02T14:00:00.000Z", attempts: 0, nextAttemptAt: null };
    const d = decideChannelHealth({ evolutionState: null, previous, lastInboundAt: null, now: noon });
    expect(d).toMatchObject({ state: "silent", since: "2026-10-02T14:00:00.000Z", talkStatus: null, action: "none" });
  });
  it("só atualiza 'since' quando o estado muda", () => {
    const previous: HealthMemory = { state: "ok", since: "2026-10-01T00:00:00.000Z", attempts: 0, nextAttemptAt: null };
    const d = decideChannelHealth({ evolutionState: "open", previous, lastInboundAt: new Date(noon.getTime() - minutes(5)), now: noon });
    expect(d.since).toBe("2026-10-01T00:00:00.000Z");
  });
});
