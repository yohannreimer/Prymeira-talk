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
