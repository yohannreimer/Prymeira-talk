import { describe, expect, it } from "vitest";
import type { ChannelDto, ChannelHealthDto } from "@prymeira-talk/shared";
import { describeChannelProblems } from "./channel-problems";

const NOW = new Date("2026-10-02T15:00:00.000Z");
const channel = (over: Partial<ChannelDto> = {}): ChannelDto => ({
  id: "c1", workspaceId: "w", provider: "evolution", providerKey: "k", phoneNumber: null,
  displayName: "Vendas 6", status: "connected", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over
});
const health = (over: Partial<ChannelHealthDto> = {}): ChannelHealthDto => ({
  channelId: "c1", state: "ok", since: null, lastInboundAt: null, attempts: 0, ...over
});

describe("describeChannelProblems", () => {
  it("canal saudável não gera aviso", () => {
    expect(describeChannelProblems([channel()], [health()], NOW)).toEqual([]);
  });
  it("desconectado vira aviso grave", () => {
    const [problem] = describeChannelProblems([channel({ status: "disconnected" })], [], NOW);
    expect(problem).toMatchObject({ channelId: "c1", tone: "danger", title: "Vendas 6 está desconectado" });
  });
  it("falhou também é grave", () => {
    expect(describeChannelProblems([channel({ status: "failed" })], [], NOW)[0]?.tone).toBe("danger");
  });
  it("desconectado mas o vigia está tentando: aviso informativo", () => {
    const [problem] = describeChannelProblems([channel({ status: "disconnected" })], [health({ state: "reconnecting", attempts: 2 })], NOW);
    expect(problem).toMatchObject({ tone: "info", title: "Vendas 6 está reconectando" });
  });
  it("precisa de QR é grave, mesmo marcado como conectado", () => {
    const [problem] = describeChannelProblems([channel()], [health({ state: "needs_qr" })], NOW);
    expect(problem).toMatchObject({ tone: "danger", title: "Vendas 6 precisa ser reconectado" });
    expect(problem!.detail).toContain("QR");
  });
  it("silêncio mostra há quantas horas", () => {
    const [problem] = describeChannelProblems([channel()], [health({ state: "silent", lastInboundAt: new Date(NOW.getTime() - 5 * 3_600_000).toISOString() })], NOW);
    expect(problem).toMatchObject({ tone: "warning", title: "Vendas 6 pode estar sem receber mensagens" });
    expect(problem!.detail).toContain("5 h");
  });
  it("canais da Meta e sem nome são tratados", () => {
    expect(describeChannelProblems([channel({ provider: "meta_cloud", status: "disconnected" })], [], NOW)).toEqual([]);
    expect(describeChannelProblems([channel({ displayName: null, phoneNumber: "5547999", status: "disconnected" })], [], NOW)[0]?.title).toContain("5547999");
  });
  it("ordena do mais grave para o menos grave", () => {
    const list = describeChannelProblems(
      [channel({ id: "a", displayName: "A" }), channel({ id: "b", displayName: "B", status: "disconnected" })],
      [health({ channelId: "a", state: "silent", lastInboundAt: new Date(NOW.getTime() - 4 * 3_600_000).toISOString() })], NOW);
    expect(list.map((p) => p.channelId)).toEqual(["b", "a"]);
  });
});
