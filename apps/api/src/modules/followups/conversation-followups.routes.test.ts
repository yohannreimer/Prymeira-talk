import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { realtimeEventSchema } from "@prymeira-talk/shared";
import { OutboundDeliveryUncertainError } from "../conversations/conversations.service.js";
import { conversationFollowupsRoutes } from "./conversation-followups.routes.js";

const ids = {
  workspaceA: "workspace_a",
  workspaceB: "workspace_b",
  followup: "00000000-0000-4000-8000-000000000701",
  followupB: "00000000-0000-4000-8000-000000000702",
  agent: "00000000-0000-4000-8000-000000000703",
  conversation: "00000000-0000-4000-8000-000000000704"
};
const initialUpdatedAt = new Date("2026-09-21T12:00:00.000Z");
const fixedNow = new Date("2026-09-21T22:00:00.000Z");

type Followup = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  kind: "qualification" | "human_commercial";
  status: "scheduled" | "processing" | "review" | "sent" | "cancelled" | "failed";
  activeKey: string | null;
  stepIndex: number;
  scheduledAt: Date;
  lockedAt: Date | null;
  draftBody: string | null;
  finalBody: string | null;
  reason: string | null;
  sentByUserId: string | null;
  sentAt: Date | null;
  cancelledByUserId: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Deliberately sensitive fields that must never cross the route boundary.
  decision?: unknown;
  providerLog?: unknown;
};

function followup(overrides: Partial<Followup> = {}): Followup {
  return {
    id: ids.followup,
    workspaceId: ids.workspaceA,
    conversationId: ids.conversation,
    agentId: ids.agent,
    kind: "human_commercial",
    status: "review",
    activeKey: "active",
    stepIndex: 1,
    scheduledAt: new Date("2026-09-22T12:00:00.000Z"),
    lockedAt: null,
    draftBody: "Podemos retomar a proposta?",
    finalBody: null,
    reason: null,
    sentByUserId: null,
    sentAt: null,
    cancelledByUserId: null,
    cancelledAt: null,
    createdAt: new Date("2026-09-21T10:00:00.000Z"),
    updatedAt: initialUpdatedAt,
    decision: { prompt: "system prompt must stay private" },
    providerLog: { authorization: "provider secret must stay private" },
    ...overrides
  };
}

function matches(value: unknown, where: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.entries(where).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as { in?: unknown[] };
      if (condition.in) return condition.in.includes(actual);
    }
    if (expected instanceof Date) {
      return actual instanceof Date && actual.getTime() === expected.getTime();
    }
    return actual === expected;
  });
}

function createMemoryPrisma(records: Followup[]) {
  const messages: Array<Record<string, unknown>> = [];
  let sequence = initialUpdatedAt.getTime();
  const touch = (record: Followup) => {
    sequence += 1_000;
    record.updatedAt = new Date(sequence);
  };
  const store = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      records.find((record) => matches(record, where)) ?? null
    ),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      records.filter((record) => matches(record, where))
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const found = records.filter((record) => matches(record, where));
      for (const record of found) {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) {
            record[key as keyof Followup] = ((record[key as keyof Followup] as number | undefined) ?? 0) + Number(value.increment) as never;
          } else {
            record[key as keyof Followup] = value as never;
          }
        }
        touch(record);
      }
      return { count: found.length };
    }),
    create: vi.fn()
  };
  const db = {
    conversationFollowup: store,
    message: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_id: { workspaceId: string; id: string } } }) =>
        messages.find((message) =>
          message.workspaceId === where.workspaceId_id.workspaceId && message.id === where.workspaceId_id.id
        ) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const message = { ...data };
        messages.push(message);
        return message;
      }),
      update: vi.fn(async ({ where, data }: { where: { workspaceId_id: { workspaceId: string; id: string } }; data: Record<string, unknown> }) => {
        const index = messages.findIndex((message) =>
          message.workspaceId === where.workspaceId_id.workspaceId && message.id === where.workspaceId_id.id
        );
        if (index < 0) throw new Error("reserved message missing");
        messages[index] = { ...messages[index], ...data };
        return messages[index];
      }),
      findFirst: vi.fn()
    },
    userProfile: { findFirst: vi.fn().mockResolvedValue({ id: "user_current" }) },
    records,
    messages,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const recordSnapshot = records.map((record) => ({ ...record }));
      const messageSnapshot = messages.map((message) => ({ ...message }));
      try {
        return await callback(db);
      } catch (error) {
        records.splice(0, records.length, ...recordSnapshot);
        messages.splice(0, messages.length, ...messageSnapshot);
        throw error;
      }
    })
  };
  return db;
}

async function buildRouteApp(input: {
  records?: Followup[];
  role?: "owner" | "manager" | "agent" | "viewer";
  revalidate?: () => Promise<unknown>;
  outbound?: ReturnType<typeof vi.fn>;
} = {}) {
  const db = createMemoryPrisma(input.records ?? [followup()]);
  const events: unknown[] = [];
  const outbound = input.outbound ?? vi.fn().mockResolvedValue({ message: { id: "message_1", status: "sent" } });
  const revalidate = vi.fn(input.revalidate ?? (async () => ({ status: "valid", context: {} })));
  const app = Fastify();
  app.decorateRequest("talk");
  app.addHook("onRequest", async (request) => {
    request.talk = {
      workspaceId: ids.workspaceA,
      role: (input.role ?? "owner") as "owner",
      clerkUserId: "clerk_current"
    };
  });
  await app.register(conversationFollowupsRoutes, {
    prisma: db as never,
    followups: { revalidateActiveFollowup: revalidate } as never,
    outbound: { createPendingOutboundMessage: outbound } as never,
    now: () => new Date(fixedNow),
    realtime: { publish: (event) => events.push(event) },
    resolveActorUserId: async () => "user_current"
  });

  return { app, db, events, outbound, revalidate };
}

function expected(record: Followup) {
  return record.updatedAt.toISOString();
}

describe("conversation follow-up review routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists only the talk workspace and emits a safe review DTO", async () => {
    const { app, db } = await buildRouteApp({
      records: [
        followup(),
        followup({ id: ids.followupB, workspaceId: ids.workspaceB, draftBody: "Other workspace" })
      ]
    });
    try {
      const response = await app.inject("/followups?status=review");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({ id: ids.followup, workspaceId: ids.workspaceA, draftBody: "Podemos retomar a proposta?" })
      ]);
      expect(response.body).not.toContain("system prompt must stay private");
      expect(response.body).not.toContain("provider secret must stay private");

      const crossWorkspaceAction = await app.inject({
        method: "POST",
        url: `/followups/${ids.followupB}/cancel`,
        payload: { reason: "manual_cancelled", expectedUpdatedAt: expected(db.records[1]) }
      });
      expect(crossWorkspaceAction.statusCode).toBe(404);
      expect(db.records[1]).toMatchObject({ workspaceId: ids.workspaceB, status: "review", activeKey: "active" });
    } finally {
      await app.close();
    }
  });

  it("rejects missing, extra and workspace-controlled query parameters", async () => {
    const { app } = await buildRouteApp();
    try {
      for (const url of ["/followups", "/followups?status=review&workspace_id=workspace_b", "/followups?status=invalid"]) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe("FOLLOWUP_INVALID_QUERY");
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a role without conversation.reply before loading or changing a follow-up", async () => {
    const { app, db } = await buildRouteApp({ role: "viewer" });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/send`,
        payload: { body: "Mensagem", expectedUpdatedAt: expected(db.records[0]) }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("FOLLOWUP_FORBIDDEN");
      expect(db.conversationFollowup.findFirst).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("sends the edited review through the injected real-delivery boundary and records its author", async () => {
    const { app, db, outbound, events } = await buildRouteApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/send`,
        payload: { body: "Oi, consigo te ajudar com mais alguma informação?", expectedUpdatedAt: expected(db.records[0]) }
      });
      expect(response.statusCode).toBe(200);
      expect(outbound).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: ids.workspaceA,
        conversationId: ids.conversation,
        body: "Oi, consigo te ajudar com mais alguma informação?",
        sentByUserId: "user_current"
      }));
      expect(db.records[0]).toMatchObject({
        status: "sent",
        activeKey: null,
        finalBody: "Oi, consigo te ajudar com mais alguma informação?",
        sentByUserId: "user_current"
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "conversation_followup.updated",
        workspaceId: ids.workspaceA,
        payload: expect.objectContaining({ status: "sent", finalBody: "Oi, consigo te ajudar com mais alguma informação?" })
      }));
      const followupEvent = events.find((event) => (event as { type?: string }).type === "conversation_followup.updated");
      expect(realtimeEventSchema.parse(followupEvent)).toEqual(followupEvent);
    } finally {
      await app.close();
    }
  });

  it("cancels after a customer reply during server revalidation and never sends", async () => {
    let dbRef: ReturnType<typeof createMemoryPrisma> | undefined;
    const { app, db, outbound } = await buildRouteApp({
      revalidate: async () => {
        const record = dbRef!.records[0];
        record.status = "cancelled";
        record.activeKey = null;
        record.reason = "customer_replied";
        record.cancelledAt = fixedNow;
        record.updatedAt = new Date(initialUpdatedAt.getTime() + 1_000);
        return { status: "cancelled", reason: "customer_replied", followup: record };
      }
    });
    dbRef = db;
    try {
      const response = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/send`,
        payload: { body: "Mensagem", expectedUpdatedAt: initialUpdatedAt.toISOString() }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(expect.objectContaining({
        code: "FOLLOWUP_STALE",
        followup: expect.objectContaining({ status: "cancelled", reason: "customer_replied" })
      }));
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns FOLLOWUP_STALE with the current DTO instead of accepting an old timestamp", async () => {
    const { app, db, outbound } = await buildRouteApp();
    db.records[0].updatedAt = new Date(initialUpdatedAt.getTime() + 60_000);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/send`,
        payload: { body: "Mensagem", expectedUpdatedAt: initialUpdatedAt.toISOString() }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(expect.objectContaining({
        code: "FOLLOWUP_STALE",
        followup: expect.objectContaining({ id: ids.followup, updatedAt: db.records[0].updatedAt.toISOString() })
      }));
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not duplicate a confirmed send when the same confirmation is submitted twice", async () => {
    const { app, db, outbound } = await buildRouteApp();
    const request = {
      method: "POST" as const,
      url: `/followups/${ids.followup}/send`,
      payload: { body: "Mensagem única", expectedUpdatedAt: expected(db.records[0]) }
    };
    try {
      expect((await app.inject(request)).statusCode).toBe(200);
      const duplicate = await app.inject(request);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual(expect.objectContaining({
        code: "FOLLOWUP_STALE",
        followup: expect.objectContaining({ status: "sent" })
      }));
      expect(outbound).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("never retries after the provider may have accepted a reserved manual delivery", async () => {
    const outbound = vi.fn().mockRejectedValue(new OutboundDeliveryUncertainError());
    const { app, db } = await buildRouteApp({ outbound });
    const request = {
      method: "POST" as const,
      url: `/followups/${ids.followup}/send`,
      payload: { body: "Mensagem única", expectedUpdatedAt: expected(db.records[0]) }
    };
    try {
      const first = await app.inject(request);
      expect(first.statusCode).toBe(502);
      expect(first.json().code).toBe("FOLLOWUP_DELIVERY_UNCERTAIN");
      expect(db.records[0]).toMatchObject({ status: "failed", activeKey: null });

      const second = await app.inject(request);
      expect(second.statusCode).toBe(409);
      expect(outbound).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("can retry safely when durable reservation fails before transport starts", async () => {
    const { app, db, outbound } = await buildRouteApp();
    db.message.create.mockRejectedValueOnce(new Error("database unavailable before provider"));
    const request = {
      method: "POST" as const,
      url: `/followups/${ids.followup}/send`,
      payload: { body: "Mensagem reservada", expectedUpdatedAt: expected(db.records[0]) }
    };
    try {
      const first = await app.inject(request);
      expect(first.statusCode).toBe(503);
      expect(first.json().code).toBe("FOLLOWUP_RESERVATION_FAILED");
      expect(outbound).not.toHaveBeenCalled();
      expect(db.records[0]).toMatchObject({ status: "review", activeKey: "active", updatedAt: initialUpdatedAt });

      const second = await app.inject(request);
      expect(second.statusCode).toBe(200);
      expect(outbound).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("guards a confirmed delivery if terminal persistence cannot complete", async () => {
    const { app, db, outbound } = await buildRouteApp();
    const originalUpdate = db.conversationFollowup.updateMany.getMockImplementation()!;
    let sentCompletionAttempt = 0;
    db.conversationFollowup.updateMany.mockImplementation(async (args) => {
      if ((args.data as { status?: string }).status === "sent") {
        sentCompletionAttempt += 1;
        return { count: 0 };
      }
      return originalUpdate(args);
    });
    const request = {
      method: "POST" as const,
      url: `/followups/${ids.followup}/send`,
      payload: { body: "Mensagem única", expectedUpdatedAt: expected(db.records[0]) }
    };
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(409);
      expect(sentCompletionAttempt).toBe(1);
      expect(db.records[0]).toMatchObject({ status: "failed", activeKey: null, reason: "delivery_completion_failed" });
      expect((await app.inject(request)).statusCode).toBe(409);
      expect(outbound).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("postpones within the next São Paulo business window without advancing the step", async () => {
    const { app, db } = await buildRouteApp({ records: [followup({ status: "scheduled", draftBody: null })] });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/postpone`,
        payload: { expectedUpdatedAt: expected(db.records[0]) }
      });
      expect(response.statusCode).toBe(200);
      expect(db.records[0]).toMatchObject({ status: "scheduled", activeKey: "active", stepIndex: 1 });
      expect(db.records[0].scheduledAt.getTime()).toBeGreaterThan(fixedNow.getTime());
      expect(db.records[0].scheduledAt.toISOString()).toBe("2026-09-22T12:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  it("cancels and suppresses a follow-up with distinct terminal reasons", async () => {
    const { app, db } = await buildRouteApp();
    try {
      const cancelled = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/cancel`,
        payload: { reason: "not_interested", expectedUpdatedAt: expected(db.records[0]) }
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toEqual(expect.objectContaining({ status: "cancelled", reason: "not_interested", cancelledByUserId: "user_current" }));

      db.records[0] = followup();
      const suppressed = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/no-followup`,
        payload: { expectedUpdatedAt: expected(db.records[0]) }
      });
      expect(suppressed.statusCode).toBe(200);
      expect(suppressed.json()).toEqual(expect.objectContaining({ status: "cancelled", reason: "no_followup", cancelledByUserId: "user_current" }));
    } finally {
      await app.close();
    }
  });

  it("never leaks decision or provider detail through a follow-up realtime event", async () => {
    const { app, db, events } = await buildRouteApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/followups/${ids.followup}/cancel`,
        payload: { reason: "manual_cancelled", expectedUpdatedAt: expected(db.records[0]) }
      });
      expect(response.statusCode).toBe(200);
      const event = events.find((candidate) => (candidate as { type?: string }).type === "conversation_followup.updated");
      expect(JSON.stringify(event)).not.toContain("system prompt must stay private");
      expect(JSON.stringify(event)).not.toContain("provider secret must stay private");
      expect((event as { workspaceId?: string }).workspaceId).toBe(ids.workspaceA);
      expect(realtimeEventSchema.parse(event)).toEqual(event);
    } finally {
      await app.close();
    }
  });
});
