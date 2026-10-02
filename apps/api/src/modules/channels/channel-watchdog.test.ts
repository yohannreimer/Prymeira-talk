import { describe, expect, it, vi } from "vitest";
import { createChannelWatchdog } from "./channel-watchdog.js";

const NOON = new Date("2026-10-02T15:00:00.000Z");
const row = (id: string, status = "connected") => ({
  id, workspaceId: "w1", provider: "evolution", providerKey: `inst-${id}`, phoneNumber: null,
  displayName: `Canal ${id}`, status, createdAt: NOON, updatedAt: NOON
});

function setup(options: {
  channels?: ReturnType<typeof row>[];
  states?: Record<string, "open" | "connecting" | "close" | "throw">;
  lastInbound?: Date | null;
  qr?: string | null;
} = {}) {
  const channels = options.channels ?? [row("a")];
  const events: unknown[] = [];
  let clock = NOON.getTime();
  const prisma = {
    channel: {
      findMany: vi.fn(async () => channels),
      update: vi.fn(async (args: { where: { workspaceId_id: { id: string } }; data: { status: string } }) => {
        const found = channels.find((c) => c.id === args.where.workspaceId_id.id)!;
        found.status = args.data.status;
        return { ...found };
      })
    },
    message: { findFirst: vi.fn(async () => options.lastInbound === undefined ? { createdAt: new Date(NOON.getTime() - 60_000) } : options.lastInbound ? { createdAt: options.lastInbound } : null) }
  };
  const client = {
    getConnectionState: vi.fn(async ({ instanceName }: { instanceName: string }) => {
      const state = options.states?.[instanceName.replace("inst-", "")] ?? "open";
      if (state === "throw") throw new Error("evolution unreachable");
      return state;
    }),
    connectInstance: vi.fn(async () => ({ instanceName: "x", qrCode: options.qr ?? null, raw: {} })),
    setWebhook: vi.fn(async () => ({ raw: {} }))
  };
  const watchdog = createChannelWatchdog({
    prisma: prisma as never,
    evolution: { client: client as never, webhookSecret: "secret", publicWebhookUrl: (w: string) => `https://talk.test/webhooks/evolution/${w}` },
    publish: (event) => { events.push(event); },
    now: () => new Date(clock),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
  return { watchdog, prisma, client, events, advance: (ms: number) => { clock += ms; } };
}

describe("channel watchdog", () => {
  it("canal aberto e saudável: não publica nada e reafirma o webhook uma vez", async () => {
    const { watchdog, client, events, advance } = setup();
    await watchdog.tick();
    expect(events).toEqual([]);
    expect(client.setWebhook).toHaveBeenCalledWith({ instanceName: "inst-a", webhookUrl: "https://talk.test/webhooks/evolution/w1", webhookSecret: "secret" });
    await watchdog.tick();
    expect(client.setWebhook).toHaveBeenCalledTimes(1);
    advance(16 * 60_000);
    await watchdog.tick();
    expect(client.setWebhook).toHaveBeenCalledTimes(2);
  });

  it("corrige o status velho de 'conectado' quando a Evolution diz que fechou, e tenta reconectar", async () => {
    const { watchdog, prisma, client, events } = setup({ states: { a: "close" } });
    await watchdog.tick();
    expect(prisma.channel.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "disconnected" } }));
    expect(client.connectInstance).toHaveBeenCalledWith({ instanceName: "inst-a" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "channel.updated", workspaceId: "w1" }),
      expect.objectContaining({ type: "channel.health", workspaceId: "w1", payload: expect.objectContaining({ channelId: "a", state: "reconnecting", attempts: 1 }) })
    ]));
  });

  it("corrige o status velho de 'desconectado' quando a Evolution diz que abriu", async () => {
    const { watchdog, prisma } = setup({ channels: [row("a", "disconnected")] });
    await watchdog.tick();
    expect(prisma.channel.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "connected" } }));
  });

  it("respeita a espera entre tentativas", async () => {
    const { watchdog, client, advance } = setup({ states: { a: "close" } });
    await watchdog.tick();
    advance(60_000);
    await watchdog.tick();
    expect(client.connectInstance).toHaveBeenCalledTimes(1);
    advance(2 * 60_000);
    await watchdog.tick();
    expect(client.connectInstance).toHaveBeenCalledTimes(2);
  });

  it("se a Evolution devolve QR ao reconectar, marca needs_qr e para de tentar", async () => {
    const { watchdog, client, events, advance } = setup({ states: { a: "close" }, qr: "QRDATA" });
    await watchdog.tick();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "channel.health", payload: expect.objectContaining({ state: "needs_qr" }) })
    ]));
    advance(10 * 60_000);
    await watchdog.tick();
    expect(client.connectInstance).toHaveBeenCalledTimes(1);
  });

  it("Evolution inalcançável: não altera status, não reconecta, não publica", async () => {
    const { watchdog, prisma, client, events } = setup({ states: { a: "throw" } });
    await watchdog.tick();
    expect(prisma.channel.update).not.toHaveBeenCalled();
    expect(client.connectInstance).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("silêncio suspeito vira silent e é publicado só uma vez", async () => {
    const { watchdog, events } = setup({ lastInbound: new Date(NOON.getTime() - 4 * 60 * 60_000) });
    await watchdog.tick();
    await watchdog.tick();
    const health = events.filter((e) => (e as { type: string }).type === "channel.health");
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ payload: { state: "silent" } });
  });

  it("falha em um canal não impede os outros", async () => {
    const { watchdog, client } = setup({ channels: [row("a"), row("b")], states: { a: "throw", b: "close" } });
    await watchdog.tick();
    expect(client.connectInstance).toHaveBeenCalledWith({ instanceName: "inst-b" });
  });

  it("getHealth devolve a saúde dos canais do workspace", async () => {
    const { watchdog } = setup({ states: { a: "close" } });
    await watchdog.tick();
    expect(watchdog.getHealth("w1")).toEqual([expect.objectContaining({ channelId: "a", state: "reconnecting" })]);
    expect(watchdog.getHealth("outro")).toEqual([]);
  });

  it("depois de needs_qr, quando a Evolution volta a abrir, a saúde volta a ok e o evento é publicado", async () => {
    const states: Record<string, "open" | "connecting" | "close" | "throw"> = { a: "close" };
    const { watchdog, events, prisma } = setup({ states, qr: "QRDATA" });
    await watchdog.tick();
    states.a = "open";
    await watchdog.tick();
    const health = events.filter((e) => (e as { type: string }).type === "channel.health");
    expect(health.at(-1)).toMatchObject({ payload: { channelId: "a", state: "ok", attempts: 0 } });
    expect(prisma.channel.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { status: "connected" } }));
    expect(watchdog.getHealth("w1")).toEqual([expect.objectContaining({ state: "ok" })]);
  });
});
