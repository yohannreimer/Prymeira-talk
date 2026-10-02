import { describe, expect, it } from "vitest";
import { channelHealthSchema, channelWatchdogStatusSchema } from "./domain.js";
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

  it("valida o status do watchdog", () => {
    const status = { enabled: true, lastTickAt: "2026-10-02T12:00:00.000Z", lastTickOk: false, lastError: "boom", unreachable: true };
    expect(channelWatchdogStatusSchema.parse(status)).toEqual(status);
    expect(channelWatchdogStatusSchema.parse({ ...status, lastTickAt: null, lastError: null })).toMatchObject({ lastTickAt: null });
    expect(channelWatchdogStatusSchema.safeParse({ ...status, lastTickAt: "ontem" }).success).toBe(false);
    expect(channelWatchdogStatusSchema.safeParse({ ...status, enabled: undefined }).success).toBe(false);
  });
});
