# Saúde dos canais: vigia e aviso — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detectar canais Evolution caídos/travados, corrigir o status, reafirmar o webhook, tentar reconectar e avisar visivelmente no Talk.

**Architecture:** Funções puras de decisão (`channel-health.ts`) + um vigia periódico (`channel-watchdog.ts`) que fala com a Evolution e publica `channel.health` no realtime; rota `GET /channels/health`; no web, um aviso fixo (`ChannelHealthAlerts`) alimentado por canais + saúde.

**Tech Stack:** TypeScript, Fastify, Prisma, zod, vitest (API/shared); React + TanStack Query + vitest `renderToStaticMarkup` (web); pnpm.

**Spec:** `docs/superpowers/specs/2026-10-02-channel-health-watchdog-design.md`

Todos os comandos rodam em `/Users/yohannreimer/Documents/Codex/2026-09-30/meu-x20/work/talk-canais-saude` (branch `codex/talk-channel-health-20261002`, dependências instaladas, Prisma gerado). Se o vitest estourar tempo (máquina carregada), repita com `--maxWorkers=2 --testTimeout=30000`.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `packages/shared/src/domain.ts` | modificar | `channelHealthSchema`, `ChannelHealthDto` |
| `packages/shared/src/realtime.ts` | modificar | evento `channel.health` |
| `packages/shared/src/channel-health.test.ts` | criar | testes do esquema e do evento |
| `apps/api/src/modules/channels/channel-health.ts` | criar | decisão pura de saúde |
| `apps/api/src/modules/channels/channel-health.test.ts` | criar | testes |
| `apps/api/src/modules/channels/channel-watchdog.ts` | criar | vigia periódico |
| `apps/api/src/modules/channels/channel-watchdog.test.ts` | criar | testes |
| `apps/api/src/env.ts` | modificar | variáveis do vigia |
| `apps/api/src/app.ts` | modificar | cria, inicia e para o vigia |
| `apps/api/src/modules/channels/channels.routes.ts` | modificar | `GET /channels/health` |
| `apps/web/src/app/api.ts` | modificar | `apiGetChannelHealth` |
| `apps/web/src/app/session/talk-session.ts` | modificar | trata `channel.health` |
| `apps/web/src/features/channels/channel-problems.ts` | criar | `describeChannelProblems` |
| `apps/web/src/features/channels/channel-problems.test.ts` | criar | testes |
| `apps/web/src/features/channels/ChannelHealthAlerts.tsx` | criar | aviso fixo |
| `apps/web/src/features/channels/ChannelHealthAlerts.test.tsx` | criar | testes |
| `apps/web/src/features/shell/TalkSuiteShell.tsx` | modificar | monta o aviso |
| `apps/web/src/styles.css` | modificar | estilo do aviso |

---

### Task 1: Esquema compartilhado e evento realtime

**Files:** `packages/shared/src/domain.ts`, `packages/shared/src/realtime.ts`, Test: `packages/shared/src/channel-health.test.ts`

- [ ] **Step 1: Teste que falha** — criar `packages/shared/src/channel-health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { channelHealthSchema } from "./domain.js";
import { realtimeEventSchema } from "./realtime.js";

const health = {
  channelId: "c1", state: "needs_qr" as const, since: "2026-10-02T12:00:00.000Z",
  lastInboundAt: null, attempts: 5
};

describe("channel health schema", () => {
  it("aceita um estado válido e rejeita um desconhecido", () => {
    expect(channelHealthSchema.parse(health)).toEqual(health);
    expect(channelHealthSchema.safeParse({ ...health, state: "explodiu" }).success).toBe(false);
  });
  it("é aceito como evento realtime channel.health", () => {
    const event = { type: "channel.health", workspaceId: "w1", payload: health };
    expect(realtimeEventSchema.parse(event)).toEqual(event);
  });
});
```
Antes de rodar, abra `packages/shared/src/realtime.ts` e confirme o nome exato do schema exportado que valida eventos (se não for `realtimeEventSchema`, use o nome real no teste).

- [ ] **Step 2: Rodar e ver falhar** — `pnpm --filter @prymeira-talk/shared exec vitest run src/channel-health.test.ts` → FAIL (`channelHealthSchema` não existe).

- [ ] **Step 3: Implementar**

Em `domain.ts`, logo depois de `export type ChannelDto = ...`:
```ts
export const channelHealthStateSchema = z.enum(["ok", "reconnecting", "disconnected", "needs_qr", "silent"]);
export const channelHealthSchema = z.object({
  channelId: z.string().min(1),
  state: channelHealthStateSchema,
  since: z.string().datetime().nullable(),
  lastInboundAt: z.string().datetime().nullable(),
  attempts: z.number().int().min(0)
});
export type ChannelHealthDto = z.infer<typeof channelHealthSchema>;
```

Em `realtime.ts`: importar `channelHealthSchema` de `./domain.js` junto do import que já traz `channelSchema`; declarar, perto de `channelQrUpdatedEventSchema`:
```ts
const channelHealthEventSchema = z.object({
  type: z.literal("channel.health"),
  workspaceId: z.string().min(1),
  payload: channelHealthSchema
});
```
e acrescentar `channelHealthEventSchema` à união discriminada de eventos (a lista onde já estão `channelUpdatedEventSchema` e `channelQrUpdatedEventSchema`). Se existir um tipo/lista manual de nomes de evento (por exemplo um `switch` ou array), acrescentar `channel.health` ali também.

- [ ] **Step 4: Rodar** — `pnpm --filter @prymeira-talk/shared exec vitest run && pnpm --filter @prymeira-talk/shared typecheck` → PASS. Rode também `pnpm typecheck` na raiz: se algum `switch` exaustivo sobre eventos quebrar, trate o novo caso minimamente (ignorar) e reporte onde.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src
git commit -m "feat(shared): channel health schema and realtime event

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Decisão pura de saúde

**Files:** Create `apps/api/src/modules/channels/channel-health.ts`, Test `apps/api/src/modules/channels/channel-health.test.ts`

- [ ] **Step 1: Testes que falham**

```ts
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
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm --filter @prymeira-talk/api exec vitest run src/modules/channels/channel-health.test.ts` → FAIL (módulo ausente).

- [ ] **Step 3: Implementar** `channel-health.ts`:

```ts
import type { ChannelHealthDto, ChannelStatus } from "@prymeira-talk/shared";

export type EvolutionState = "open" | "connecting" | "close" | null;
export type HealthState = ChannelHealthDto["state"];

export const RECONNECT_BACKOFF_MS = [2, 5, 10, 30, 60].map((minutes) => minutes * 60_000);
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;
export const SILENCE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
export const SILENCE_RECENT_ACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = "America/Sao_Paulo";

export type HealthMemory = {
  state: HealthState;
  since: string | null;
  attempts: number;
  nextAttemptAt: string | null;
};

export type HealthDecision = HealthMemory & {
  talkStatus: ChannelStatus | null;
  action: "none" | "reconnect";
};

export function isBusinessHours(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE, weekday: "short", hour: "numeric", hourCycle: "h23"
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return weekday !== "Sun" && hour >= 8 && hour < 19;
}

export function decideChannelHealth(input: {
  evolutionState: EvolutionState;
  previous: HealthMemory | null;
  lastInboundAt: Date | null;
  now: Date;
}): HealthDecision {
  const { evolutionState, previous, lastInboundAt, now } = input;
  const nowIso = now.toISOString();
  const finish = (state: HealthState, rest: Omit<HealthDecision, "state" | "since">): HealthDecision => ({
    state,
    since: previous && previous.state === state ? previous.since : nowIso,
    ...rest
  });

  if (evolutionState === null) {
    return {
      state: previous?.state ?? "ok",
      since: previous?.since ?? null,
      attempts: previous?.attempts ?? 0,
      nextAttemptAt: previous?.nextAttemptAt ?? null,
      talkStatus: null,
      action: "none"
    };
  }

  if (evolutionState === "open") {
    const silentFor = lastInboundAt ? now.getTime() - lastInboundAt.getTime() : null;
    const silent = silentFor !== null && isBusinessHours(now) &&
      silentFor >= SILENCE_THRESHOLD_MS && silentFor <= SILENCE_RECENT_ACTIVITY_MS;
    return finish(silent ? "silent" : "ok", { attempts: 0, nextAttemptAt: null, talkStatus: "connected", action: "none" });
  }

  if (evolutionState === "connecting") {
    return finish("reconnecting", {
      attempts: previous?.attempts ?? 0, nextAttemptAt: previous?.nextAttemptAt ?? null,
      talkStatus: "connecting", action: "none"
    });
  }

  const attempts = previous?.attempts ?? 0;
  if (attempts >= MAX_RECONNECT_ATTEMPTS) {
    return finish("needs_qr", { attempts, nextAttemptAt: null, talkStatus: "disconnected", action: "none" });
  }
  const due = !previous?.nextAttemptAt || new Date(previous.nextAttemptAt).getTime() <= now.getTime();
  if (!due) {
    return finish("reconnecting", {
      attempts, nextAttemptAt: previous!.nextAttemptAt, talkStatus: "disconnected", action: "none"
    });
  }
  const nextAttempts = attempts + 1;
  return finish("reconnecting", {
    attempts: nextAttempts,
    nextAttemptAt: new Date(now.getTime() + RECONNECT_BACKOFF_MS[nextAttempts - 1]!).toISOString(),
    talkStatus: "disconnected",
    action: "reconnect"
  });
}
```

- [ ] **Step 4: Rodar** — mesmo comando → PASS. Rode também `pnpm --filter @prymeira-talk/api typecheck`. Se algum teste de fuso falhar por diferença de ICU (nome do dia/hora), ajuste só `isBusinessHours` mantendo a regra (seg–sáb, 8h–19h em São Paulo) e reporte.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/modules/channels/channel-health.ts apps/api/src/modules/channels/channel-health.test.ts
git commit -m "feat(channels): pure channel health decision

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Vigia dos canais

**Files:** Create `apps/api/src/modules/channels/channel-watchdog.ts`, Test `channel-watchdog.test.ts` (mesma pasta). Antes de escrever, leia `channels.service.ts` (função exportada `toChannelDto`, tipo `ChannelRecord`) e `channel-history-import.ts` (padrão de scheduler com `start/stop`, timer com `unref`).

- [ ] **Step 1: Testes que falham**

```ts
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
});
```

- [ ] **Step 2: Rodar e ver falhar** → FAIL (módulo ausente).

- [ ] **Step 3: Implementar** `channel-watchdog.ts`:

```ts
import type { ChannelHealthDto, ChannelStatus, RealtimeEvent } from "@prymeira-talk/shared";
import { toChannelDto } from "./channels.service.js";
import { decideChannelHealth, MAX_RECONNECT_ATTEMPTS, type EvolutionState, type HealthMemory } from "./channel-health.js";

const DEFAULT_INTERVAL_MS = 120_000;
const WEBHOOK_EVERY_MS = 15 * 60_000;

type ChannelRow = {
  id: string; workspaceId: string; provider: string; providerKey: string;
  phoneNumber: string | null; displayName: string | null; status: ChannelStatus;
  createdAt: Date; updatedAt: Date;
};

export interface ChannelWatchdogPrisma {
  channel: {
    findMany(args: { where: { provider: "evolution" } }): Promise<ChannelRow[]>;
    update(args: { where: { workspaceId_id: { workspaceId: string; id: string } }; data: { status: ChannelStatus } }): Promise<ChannelRow>;
  };
  message: {
    findFirst(args: {
      where: { workspaceId: string; direction: "inbound"; conversation: { channelId: string } };
      orderBy: { createdAt: "desc" };
      select: { createdAt: true };
    }): Promise<{ createdAt: Date } | null>;
  };
}

export interface ChannelWatchdogEvolution {
  client: {
    getConnectionState?(input: { instanceName: string }): Promise<EvolutionState>;
    connectInstance(input: { instanceName: string }): Promise<{ qrCode: string | null }>;
    setWebhook(input: { instanceName: string; webhookUrl: string; webhookSecret: string }): Promise<unknown>;
  };
  webhookSecret: string;
  publicWebhookUrl(workspaceId: string): string;
}

type Logger = { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };

export function createChannelWatchdog(deps: {
  prisma: ChannelWatchdogPrisma;
  evolution: ChannelWatchdogEvolution;
  publish: (event: RealtimeEvent) => void;
  now?: () => Date;
  intervalMs?: number;
  log?: Logger;
}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const memory = new Map<string, HealthMemory & { workspaceId: string; lastInboundAt: string | null }>();
  const webhookAt = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const toDto = (channelId: string, entry: NonNullable<ReturnType<typeof memory.get>>): ChannelHealthDto => ({
    channelId, state: entry.state, since: entry.since, lastInboundAt: entry.lastInboundAt, attempts: entry.attempts
  });

  async function check(channel: ChannelRow) {
    const client = deps.evolution.client;
    if (!client.getConnectionState) return;
    const evolutionState = await client.getConnectionState({ instanceName: channel.providerKey }).catch(() => null);
    const previous = memory.get(channel.id) ?? null;
    const current = now();

    let lastInboundAt: Date | null = null;
    if (evolutionState === "open") {
      const last = await deps.prisma.message.findFirst({
        where: { workspaceId: channel.workspaceId, direction: "inbound", conversation: { channelId: channel.id } },
        orderBy: { createdAt: "desc" }, select: { createdAt: true }
      });
      lastInboundAt = last?.createdAt ?? null;
    }

    let decision = decideChannelHealth({ evolutionState, previous, lastInboundAt, now: current });

    if (decision.talkStatus && decision.talkStatus !== channel.status) {
      const updated = await deps.prisma.channel.update({
        where: { workspaceId_id: { workspaceId: channel.workspaceId, id: channel.id } },
        data: { status: decision.talkStatus }
      });
      deps.publish({ type: "channel.updated", workspaceId: channel.workspaceId, payload: toChannelDto(updated as never) });
    }

    if (evolutionState === "open" && (current.getTime() - (webhookAt.get(channel.id) ?? 0)) >= WEBHOOK_EVERY_MS) {
      webhookAt.set(channel.id, current.getTime());
      await client.setWebhook({
        instanceName: channel.providerKey,
        webhookUrl: deps.evolution.publicWebhookUrl(channel.workspaceId),
        webhookSecret: deps.evolution.webhookSecret
      }).catch((error: unknown) => log.warn({ err: error, channelId: channel.id }, "Channel watchdog could not reassert the webhook."));
    }

    if (decision.action === "reconnect") {
      const result = await client.connectInstance({ instanceName: channel.providerKey })
        .catch((error: unknown) => { log.warn({ err: error, channelId: channel.id }, "Channel watchdog reconnect attempt failed."); return null; });
      if (result?.qrCode) {
        decision = { ...decision, state: "needs_qr", attempts: MAX_RECONNECT_ATTEMPTS, nextAttemptAt: null, since: previous?.state === "needs_qr" ? previous.since : current.toISOString() };
      }
      log.info({ channelId: channel.id, attempt: decision.attempts, needsQr: Boolean(result?.qrCode) }, "Channel watchdog reconnect attempted.");
    }

    const next = {
      workspaceId: channel.workspaceId, state: decision.state, since: decision.since,
      attempts: decision.attempts, nextAttemptAt: decision.nextAttemptAt,
      lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : previous?.lastInboundAt ?? null
    };
    memory.set(channel.id, next);
    const changed = !previous ? decision.state !== "ok" : previous.state !== decision.state;
    if (changed) deps.publish({ type: "channel.health", workspaceId: channel.workspaceId, payload: toDto(channel.id, next) });
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const channels = await deps.prisma.channel.findMany({ where: { provider: "evolution" } });
      for (const channel of channels) {
        await check(channel).catch((error: unknown) => log.error({ err: error, channelId: channel.id }, "Channel watchdog check failed."));
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    getHealth(workspaceId: string): ChannelHealthDto[] {
      return [...memory.entries()]
        .filter(([, entry]) => entry.workspaceId === workspaceId)
        .map(([channelId, entry]) => toDto(channelId, entry));
    }
  };
}
```
Antes de rodar, confirme o nome real do tipo de evento realtime exportado por `@prymeira-talk/shared` (se não for `RealtimeEvent`, use o nome correto no import) e que `toChannelDto` é exportada de `channels.service.ts` (é, linha ~170).

- [ ] **Step 4: Rodar** — `pnpm --filter @prymeira-talk/api exec vitest run src/modules/channels/channel-watchdog.test.ts && pnpm --filter @prymeira-talk/api typecheck` → PASS. Se um teste falhar contra o código do plano, ache a causa real e corrija a implementação sem enfraquecer o teste; reporte.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/modules/channels/channel-watchdog.ts apps/api/src/modules/channels/channel-watchdog.test.ts
git commit -m "feat(channels): watchdog that reconciles, reasserts and reconnects Evolution channels

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Variáveis, ligação no app e rota

**Files:** `apps/api/src/env.ts`, `apps/api/src/app.ts`, `apps/api/src/modules/channels/channels.routes.ts`, Test: `apps/api/src/env.test.ts` e um teste de rota novo `apps/api/src/modules/channels/channels.health.routes.test.ts`

- [ ] **Step 1: Testes que falham**

Em `env.test.ts`, seguindo o estilo dos testes de flags existentes (por exemplo o de `INBOX_TRIAGE_ENABLED`): testar que sem as variáveis `CHANNEL_WATCHDOG_ENABLED` vira `true` e `CHANNEL_WATCHDOG_INTERVAL_SECONDS` vira `120`; que `"false"` desliga; e que um intervalo menor que 30 é rejeitado.

Criar `channels.health.routes.test.ts` usando o mesmo helper de app de teste que `channels.routes`/`app.test.ts` usam para rotas autenticadas (leia `apps/api/src/test/build-app.ts`): com um watchdog falso passado nas opções, `GET /channels/health` devolve `{ health: [...] }` só com os canais do workspace da requisição; sem watchdog (desligado) devolve `{ health: [] }`. Escreva o teste completo com o helper real (não deixe nomes de exemplo).

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar**

`env.ts`, junto das outras flags (modelo: `INBOX_TRIAGE_ENABLED`):
```ts
    CHANNEL_WATCHDOG_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    CHANNEL_WATCHDOG_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
```
`channels.routes.ts`: acrescentar `channelHealth?: { getHealth(workspaceId: string): ChannelHealthDto[] }` a `ChannelsRoutesOptions` e a rota (antes de qualquer rota `/channels/:channelId`, para o caminho estático vencer):
```ts
  app.get("/channels/health", async (request) => ({
    health: options.channelHealth?.getHealth(request.talk.workspaceId) ?? []
  }));
```
`app.ts`: onde o `evolutionRuntime` (com `client`, `webhookSecret`, `publicWebhookUrl`) já existe e antes do registro de `channelsRoutes`, criar o vigia só quando `env.CHANNEL_WATCHDOG_ENABLED`, o Prisma está habilitado e `evolutionRuntime.mode === "real"` com `client`:
```ts
  const channelWatchdog = env.CHANNEL_WATCHDOG_ENABLED && options.prismaEnabled !== false &&
    evolutionRuntime.mode === "real" && evolutionRuntime.client
    ? createChannelWatchdog({
        prisma: app.prisma as unknown as ChannelWatchdogPrisma,
        evolution: { client: evolutionRuntime.client as never, webhookSecret: evolutionRuntime.webhookSecret, publicWebhookUrl: evolutionRuntime.publicWebhookUrl },
        publish: (event) => app.realtime.publish(event),
        intervalMs: env.CHANNEL_WATCHDOG_INTERVAL_SECONDS * 1000,
        log: app.log
      })
    : undefined;
  channelWatchdog?.start();
  if (channelWatchdog) app.addHook("onClose", async () => { await channelWatchdog.stop(); });
```
Os nomes `evolutionRuntime`, `app.realtime` e a forma exata do registro `app.register(channelsRoutes, { evolution: ... })` devem ser conferidos no `app.ts` (leia as linhas em volta de `channelsRoutes`/`createChannelHistoryImportScheduler`) e passar `channelHealth: channelWatchdog` na opção de registro. Se `app.realtime` só existir depois do ponto escolhido, criar o vigia depois dele.

- [ ] **Step 4: Rodar** — `pnpm --filter @prymeira-talk/api exec vitest run src/env.test.ts src/modules/channels && pnpm --filter @prymeira-talk/api typecheck` → PASS. Documente as duas variáveis em `.env.example` e em `docs/operations` onde as demais flags do Talk já estão documentadas (leia `.env.example` e `.env.production.example`).

- [ ] **Step 5: Commit**
```bash
git add apps/api .env.example .env.production.example docs
git commit -m "feat(channels): run the channel watchdog and expose GET /channels/health

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web — dados do aviso (API client, sessão e helper)

**Files:** `apps/web/src/app/api.ts`, `apps/web/src/app/session/talk-session.ts`, Create `apps/web/src/features/channels/channel-problems.ts`, Test `channel-problems.test.ts`

- [ ] **Step 1: Teste que falha** — `channel-problems.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm --filter @prymeira-talk/web exec vitest run src/features/channels/channel-problems.test.ts`.

- [ ] **Step 3: Implementar**

`channel-problems.ts`:
```ts
import type { ChannelDto, ChannelHealthDto } from "@prymeira-talk/shared";

export type ChannelProblem = {
  channelId: string;
  tone: "danger" | "warning" | "info";
  title: string;
  detail: string;
};

const order = { danger: 0, warning: 1, info: 2 } as const;

function labelOf(channel: ChannelDto) {
  return channel.displayName?.trim() || channel.phoneNumber?.trim() || "Canal";
}

export function describeChannelProblems(channels: ChannelDto[], health: ChannelHealthDto[], now: Date = new Date()): ChannelProblem[] {
  const byChannel = new Map(health.map((item) => [item.channelId, item]));
  const problems: ChannelProblem[] = [];
  for (const channel of channels) {
    if (channel.provider !== "evolution") continue;
    const label = labelOf(channel);
    const item = byChannel.get(channel.id);
    if (item?.state === "needs_qr") {
      problems.push({ channelId: channel.id, tone: "danger", title: `${label} precisa ser reconectado`,
        detail: "O WhatsApp desvinculou este número. Abra Canais e escaneie o QR para voltar a receber mensagens." });
    } else if (channel.status === "disconnected" || channel.status === "failed") {
      if (item?.state === "reconnecting") {
        problems.push({ channelId: channel.id, tone: "info", title: `${label} está reconectando`,
          detail: "O Talk está tentando reconectar sozinho. Se continuar assim, vamos avisar que é preciso escanear o QR." });
      } else {
        problems.push({ channelId: channel.id, tone: "danger", title: `${label} está desconectado`,
          detail: "Este número não recebe nem envia mensagens agora. Abra Canais e reconecte." });
      }
    } else if (item?.state === "silent") {
      const hours = item.lastInboundAt ? Math.max(1, Math.floor((now.getTime() - new Date(item.lastInboundAt).getTime()) / 3_600_000)) : null;
      problems.push({ channelId: channel.id, tone: "warning", title: `${label} pode estar sem receber mensagens`,
        detail: `${hours ? `Nenhuma mensagem recebida há ${hours} h. ` : ""}Se o celular está normal, abra Canais e use Reconectar.` });
    }
  }
  return problems.sort((a, b) => order[a.tone] - order[b.tone]);
}
```

`api.ts`: depois de `apiGetChannels`, acrescentar (importando `channelHealthSchema`/`ChannelHealthDto` do shared como os demais schemas já importados):
```ts
export async function apiGetChannelHealth(
  getToken: () => Promise<string | null>,
  signal?: AbortSignal
): Promise<ChannelHealthDto[]> {
  return withReadDeadline(signal, async (deadline) => {
    const token = await getRequiredToken(getToken, deadline);
    const response = await fetch(`${apiUrl}/channels/health`, { signal: deadline, headers: { Authorization: `Bearer ${token}` } });
    await assertApiReadAccess(response, token, deadline);
    if (!response.ok) throw new Error(`Failed to load channel health: ${response.status}`);
    const data = await response.json() as { health?: unknown };
    return channelHealthSchema.array().parse(data.health ?? []);
  });
}
```
(copiar a forma exata de `apiGetChannels`: mesmos helpers e a mesma estrutura de retorno.)

`talk-session.ts`: dentro do tratamento de eventos, ao lado do bloco de `channel.updated`, acrescentar:
```ts
    if (event.type === 'channel.health') {
      this.client.setQueryData<ChannelHealthDto[]>(this.key('channelHealth'), rows =>
        [...(rows ?? []).filter(row => row.channelId !== event.payload.channelId), event.payload]);
    }
```
com o import do tipo `ChannelHealthDto`. Se existir um teste da sessão para eventos, acrescentar um caso para `channel.health`.

- [ ] **Step 4: Rodar** — `pnpm --filter @prymeira-talk/web exec vitest run src/features/channels src/app && pnpm --filter @prymeira-talk/web typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src
git commit -m "feat(web): channel health data and problem descriptions

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — aviso fixo e montagem no shell

**Files:** Create `apps/web/src/features/channels/ChannelHealthAlerts.tsx`, Test `ChannelHealthAlerts.test.tsx`, Modify `TalkSuiteShell.tsx`, `styles.css`

- [ ] **Step 1: Testes que falham**

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelHealthAlertList } from "./ChannelHealthAlerts";

describe("ChannelHealthAlertList", () => {
  it("não renderiza nada sem problemas", () => {
    expect(renderToStaticMarkup(<ChannelHealthAlertList problems={[]} onOpenChannels={vi.fn()} />)).toBe("");
  });
  it("mostra título, detalhe e o botão para abrir Canais", () => {
    const html = renderToStaticMarkup(<ChannelHealthAlertList onOpenChannels={vi.fn()} problems={[
      { channelId: "a", tone: "danger", title: "Vendas 6 está desconectado", detail: "Abra Canais e reconecte." }
    ]} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Vendas 6 está desconectado");
    expect(html).toContain("Abra Canais e reconecte.");
    expect(html).toContain("Abrir Canais");
    expect(html).toContain("channel-alert-danger");
  });
  it("lista vários avisos, cada um com seu tom", () => {
    const html = renderToStaticMarkup(<ChannelHealthAlertList onOpenChannels={vi.fn()} problems={[
      { channelId: "a", tone: "danger", title: "A", detail: "x" },
      { channelId: "b", tone: "warning", title: "B", detail: "y" }
    ]} />);
    expect(html).toContain("channel-alert-warning");
    expect((html.match(/channel-alert /g) ?? []).length).toBe(2);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar**

`ChannelHealthAlerts.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { useOptionalTalkSession } from "../../app/session/TalkSessionProvider";
import { apiGetChannelHealth, apiGetChannels } from "../../app/api";
import { describeChannelProblems, type ChannelProblem } from "./channel-problems";

export function ChannelHealthAlertList(props: { problems: ChannelProblem[]; onOpenChannels: () => void }) {
  if (props.problems.length === 0) return null;
  return <div className="channel-alerts" aria-live="polite">
    {props.problems.map((problem) => <div className={`channel-alert channel-alert-${problem.tone}`} role="alert" key={problem.channelId}>
      <strong>{problem.title}</strong>
      <p>{problem.detail}</p>
      <button type="button" className="secondary-button" onClick={props.onOpenChannels}>Abrir Canais</button>
    </div>)}
  </div>;
}

export function ChannelHealthAlerts(props: { onOpenChannels: () => void }) {
  const context = useOptionalTalkSession();
  if (!context) return null;
  return <ChannelHealthAlertsConnected {...props} />;
}

function ChannelHealthAlertsConnected(props: { onOpenChannels: () => void }) {
  const context = useOptionalTalkSession()!;
  const { session, getToken } = context;
  const channels = useQuery({ queryKey: session.key("channels"), staleTime: 60_000,
    queryFn: ({ signal }) => apiGetChannels(getToken, signal) });
  const health = useQuery({ queryKey: session.key("channelHealth"), staleTime: 60_000,
    queryFn: ({ signal }) => apiGetChannelHealth(getToken, signal) });
  const problems = describeChannelProblems(channels.data ?? [], health.data ?? []);
  return <ChannelHealthAlertList problems={problems} onOpenChannels={props.onOpenChannels} />;
}
```
Conferir em `InboxPage.tsx` (linha ~641) como `getFreshToken` é obtido; se `getToken` do contexto não for o equivalente adequado, usar o mesmo mecanismo. A chave `session.key("channels")` DEVE ser a mesma do InboxPage para compartilhar cache.

`TalkSuiteShell.tsx`: importar `ChannelHealthAlerts` e, depois de `{renderModule(activeModule)}`, acrescentar:
```tsx
      <ChannelHealthAlerts onOpenChannels={() => handleModuleClick("canais")} />
```

`styles.css` (ao final): estilos do aviso fixo:
```css
.channel-alerts { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: grid; gap: 8px; max-width: min(380px, calc(100vw - 32px)); }
.channel-alert { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--channel-alert-border, #d8d2c0); background: #fffdf6; box-shadow: 0 8px 24px rgba(0, 0, 0, .16); }
.channel-alert strong { display: block; margin-bottom: 4px; }
.channel-alert p { margin: 0 0 10px; font-size: 13px; line-height: 1.4; }
.channel-alert-danger { --channel-alert-border: #c0392b; background: #fdf0ee; }
.channel-alert-warning { --channel-alert-border: #c98a00; background: #fff7e0; }
.channel-alert-info { --channel-alert-border: #3b6ea5; background: #eef4fb; }
```

- [ ] **Step 4: Rodar** — `pnpm --filter @prymeira-talk/web exec vitest run && pnpm --filter @prymeira-talk/web typecheck && pnpm --filter @prymeira-talk/web build` → PASS. Se algum teste existente do shell quebrar por causa do novo componente (sessão ausente), ele deve renderizar `null` sem sessão (já tratado).

- [ ] **Step 5: Commit**
```bash
git add apps/web/src
git commit -m "feat(web): persistent channel health alert in the Talk shell

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verificação completa (sem publicar)

- [ ] **Step 1:**
```bash
pnpm typecheck
pnpm --filter @prymeira-talk/shared exec vitest run
pnpm --filter @prymeira-talk/api exec vitest run --maxWorkers=3 --testTimeout=30000
pnpm --filter @prymeira-talk/web exec vitest run
pnpm --filter @prymeira-talk/web build
git log --oneline 72bbb63..HEAD
```
Expected: tudo passa; só arquivos da File Structure mudaram.

- [ ] **Step 2: Parar e reportar.** Sem push, PR nem deploy.
