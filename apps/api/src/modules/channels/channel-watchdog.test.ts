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
  activity?: boolean;
  dryRun?: boolean;
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
    message: {
      findFirst: vi.fn(async (args: { select: { id?: true; createdAt?: true } }) => {
        if (args.select.id) return options.activity === false ? null : { id: "m1" };
        return options.lastInbound === undefined ? { createdAt: new Date(NOON.getTime() - 60_000) } : options.lastInbound ? { createdAt: options.lastInbound } : null;
      })
    }
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
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const watchdog = createChannelWatchdog({
    prisma: prisma as never,
    evolution: { client: client as never, webhookSecret: "secret", publicWebhookUrl: (w: string) => `https://talk.test/webhooks/evolution/${w}` },
    publish: (event) => { events.push(event); },
    now: () => new Date(clock),
    dryRun: options.dryRun,
    log
  });
  return { watchdog, prisma, client, events, log, advance: (ms: number) => { clock += ms; } };
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

  it("canal dormente (sem mensagens há 7 dias): reconcilia o status, mas não reconecta nem alerta", async () => {
    const { watchdog, prisma, client, events } = setup({ states: { a: "close" }, activity: false });
    await watchdog.tick();
    expect(prisma.channel.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "disconnected" } }));
    expect(client.connectInstance).not.toHaveBeenCalled();
    expect(events.filter((e) => (e as { type: string }).type === "channel.health")).toEqual([]);
    expect(prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ createdAt: { gte: new Date(NOON.getTime() - 7 * 24 * 60 * 60_000) } })
    }));
  });

  it("canal dormente aberto não reafirma o webhook", async () => {
    const { watchdog, client } = setup({ activity: false });
    await watchdog.tick();
    expect(client.setWebhook).not.toHaveBeenCalled();
  });

  it("desconexão manual: não reconecta nem alerta; ao limpar volta ao normal", async () => {
    const { watchdog, prisma, client, events } = setup({ states: { a: "close" } });
    watchdog.markManualDisconnect("a");
    await watchdog.tick();
    expect(prisma.channel.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "disconnected" } }));
    expect(client.connectInstance).not.toHaveBeenCalled();
    expect(events.filter((e) => (e as { type: string }).type === "channel.health")).toEqual([]);
    watchdog.clearManualDisconnect("a");
    await watchdog.tick();
    expect(client.connectInstance).toHaveBeenCalledTimes(1);
  });

  it("ao marcar desconexão manual de um canal em alerta, publica o retorno a ok", async () => {
    const { watchdog, events } = setup({ states: { a: "close" } });
    await watchdog.tick();
    watchdog.markManualDisconnect("a");
    await watchdog.tick();
    const health = events.filter((e) => (e as { type: string }).type === "channel.health");
    expect(health.at(-1)).toMatchObject({ payload: { channelId: "a", state: "ok", attempts: 0 } });
  });

  it("tick nunca rejeita: falha no findMany é registrada, aparece no status e o próximo tick funciona", async () => {
    const { watchdog, prisma, log, advance } = setup();
    prisma.channel.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(watchdog.tick()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel_watchdog_tick_failed", err: expect.any(Error) }),
      "Channel watchdog tick failed."
    );
    expect(watchdog.status()).toEqual({ lastTickAt: NOON.toISOString(), lastTickOk: false, lastError: "db down", unreachable: false });
    advance(1000);
    await watchdog.tick();
    expect(watchdog.status()).toEqual({ lastTickAt: new Date(NOON.getTime() + 1000).toISOString(), lastTickOk: true, lastError: null, unreachable: false });
    expect(watchdog.getHealth("w1")).toEqual([expect.objectContaining({ channelId: "a", state: "ok" })]);
  });

  it("registra Evolution inalcançável no máximo uma vez a cada 10 minutos por canal, sem segredos", async () => {
    const { watchdog, log, advance } = setup({ states: { a: "throw" } });
    await watchdog.tick();
    advance(5 * 60_000);
    await watchdog.tick();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { event: "channel_watchdog_evolution_unreachable", channelId: "a", err: "evolution unreachable" },
      "Channel watchdog could not reach Evolution."
    );
    advance(5 * 60_000);
    await watchdog.tick();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("status.unreachable só liga após 3 ticks seguidos com todos os canais inalcançáveis e desliga quando algum responde", async () => {
    const states: Record<string, "open" | "connecting" | "close" | "throw"> = { a: "throw", b: "throw" };
    const { watchdog } = setup({ channels: [row("a"), row("b")], states });
    await watchdog.tick();
    await watchdog.tick();
    expect(watchdog.status().unreachable).toBe(false);
    await watchdog.tick();
    expect(watchdog.status().unreachable).toBe(true);
    states.b = "open";
    await watchdog.tick();
    expect(watchdog.status().unreachable).toBe(false);
  });

  it("status.unreachable fica falso sem canais e antes do primeiro tick", async () => {
    const { watchdog } = setup({ channels: [] });
    expect(watchdog.status()).toEqual({ lastTickAt: null, lastTickOk: true, lastError: null, unreachable: false });
    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();
    expect(watchdog.status().unreachable).toBe(false);
  });

  it("registra eventos estáveis ao corrigir status, mudar de estado e reconectar", async () => {
    const { watchdog, log } = setup({ states: { a: "close" } });
    await watchdog.tick();
    expect(log.info).toHaveBeenCalledWith({ event: "channel_watchdog_status_corrected", channelId: "a", from: "connected", to: "disconnected" }, expect.any(String));
    expect(log.info).toHaveBeenCalledWith({ event: "channel_watchdog_state_changed", channelId: "a", from: null, to: "reconnecting" }, expect.any(String));
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "channel_watchdog_reconnect_attempted", channelId: "a" }), "Channel watchdog reconnect attempted.");
  });

  it("falhas de check, webhook e reconexão têm event estável", async () => {
    const a = setup();
    a.client.setWebhook.mockRejectedValueOnce(new Error("x"));
    await a.watchdog.tick();
    expect(a.log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "channel_watchdog_webhook_failed" }), "Channel watchdog could not reassert the webhook.");
    const b = setup({ states: { a: "close" } });
    b.client.connectInstance.mockRejectedValueOnce(new Error("x"));
    await b.watchdog.tick();
    expect(b.log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "channel_watchdog_reconnect_failed" }), "Channel watchdog reconnect attempt failed.");
    const c = setup();
    c.prisma.message.findFirst.mockRejectedValueOnce(new Error("x"));
    await c.watchdog.tick();
    expect(c.log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "channel_watchdog_check_failed", channelId: "a" }), "Channel watchdog check failed.");
  });
});

describe("channel watchdog dry run", () => {
  it("update_status: só registra, sem update nem publish", async () => {
    const { watchdog, prisma, events, log } = setup({ channels: [row("a", "disconnected")], dryRun: true });
    await watchdog.tick();
    expect(prisma.channel.update).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      { event: "channel_watchdog_dry_run", action: "update_status", channelId: "a", from: "disconnected", to: "connected" },
      "Channel watchdog dry run: would update the channel status."
    );
  });

  it("reassert_webhook: só registra, sem setWebhook", async () => {
    const { watchdog, client, events, log } = setup({ dryRun: true });
    await watchdog.tick();
    expect(client.setWebhook).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      { event: "channel_watchdog_dry_run", action: "reassert_webhook", channelId: "a", instanceName: "inst-a" },
      "Channel watchdog dry run: would reassert the webhook."
    );
    await watchdog.tick();
    expect(log.info.mock.calls.filter(([m]) => (m as { action?: string }).action === "reassert_webhook")).toHaveLength(1);
  });

  it("reconnect: só registra, sem connectInstance nem publish, mas a memória avança e getHealth reflete", async () => {
    const { watchdog, client, prisma, events, log, advance } = setup({ states: { a: "close" }, dryRun: true });
    await watchdog.tick();
    expect(client.connectInstance).not.toHaveBeenCalled();
    expect(prisma.channel.update).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      { event: "channel_watchdog_dry_run", action: "reconnect", channelId: "a", attempt: 1 },
      "Channel watchdog dry run: would attempt a reconnect."
    );
    expect(watchdog.getHealth("w1")).toEqual([expect.objectContaining({ state: "reconnecting", attempts: 1 })]);
    advance(3 * 60_000);
    await watchdog.tick();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ action: "reconnect", attempt: 2 }), expect.any(String));
    expect(client.connectInstance).not.toHaveBeenCalled();
  });
});
