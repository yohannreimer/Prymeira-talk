import type { ConversationDto } from "@prymeira-talk/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { inboxTriageRoutes } from "./inbox-triage.routes.js";
import { InboxTriageConflictError, InboxTriageNotFoundError, type createInboxTriageService } from "./inbox-triage.service.js";

const conversationId = "00000000-0000-4000-8000-000000000001";
const anchorMessageId = "00000000-0000-4000-8000-000000000002";

async function buildRouteApp(overrides: { handoff?: boolean } = {}) {
  const app = Fastify({ logger: false });
  const publish = vi.fn();
  const prisma = { userProfile: { findFirst: vi.fn().mockResolvedValue({ id: "user_1" }) } };
  const triage = {
    observeMessage: vi.fn(), setManualMark: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined), undoDismiss: vi.fn().mockResolvedValue(undefined)
  };
  const getConversation = vi.fn().mockResolvedValue({
    id: conversationId, workspaceId: "workspace_a", status: "open",
    aiControlStatus: "human_controlled",
    activeAgentSessionStatus: overrides.handoff ? "handoff_requested" : null,
    handoffReason: overrides.handoff ? "Revisar" : null,
    handoffActionCompletedAt: null,
    replyTriageDecision: "needs_reply", replyTriageAnchorMessageId: anchorMessageId
  } as ConversationDto);
  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish, addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", clerkUserId: "clerk_1", role: "agent" };
  });
  await app.register(inboxTriageRoutes, { triage: triage as unknown as ReturnType<typeof createInboxTriageService>, getConversation });
  return { app, triage, publish, getConversation, prisma };
}

describe("inbox triage routes", () => {
  it("marks a conversation for everyone in the workspace and publishes the new card", async () => {
    const { app, triage, publish } = await buildRouteApp();
    try {
      const response = await app.inject({ method: "POST", url: `/conversations/${conversationId}/manual-mark`, payload: { marked: true } });
      expect(response.statusCode).toBe(200);
      expect(triage.setManualMark).toHaveBeenCalledWith({ workspaceId: "workspace_a", conversationId, actorId: "user_1", marked: true });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation.updated", workspaceId: "workspace_a" }));
    } finally { await app.close(); }
  });

  it("rejects stale anchors and does not dismiss a human handoff", async () => {
    const { app, triage } = await buildRouteApp();
    try {
      triage.dismiss.mockRejectedValueOnce(new InboxTriageConflictError());
      const response = await app.inject({ method: "POST", url: `/conversations/${conversationId}/reply-dismiss`, payload: { anchorMessageId } });
      expect(response.statusCode).toBe(409);
      expect(triage.dismiss).toHaveBeenCalledWith({ workspaceId: "workspace_a", conversationId, expectedAnchorMessageId: anchorMessageId });
    } finally { await app.close(); }
    const handoff = await buildRouteApp({ handoff: true });
    try {
      const response = await handoff.app.inject({ method: "POST", url: `/conversations/${conversationId}/reply-dismiss`, payload: { anchorMessageId } });
      expect(response.statusCode).toBe(409);
      expect(handoff.triage.dismiss).not.toHaveBeenCalled();
    } finally { await handoff.app.close(); }
  });

  it("uses workspace scope and returns 404 for a conversation outside it", async () => {
    const { app, triage } = await buildRouteApp();
    try {
      triage.setManualMark.mockRejectedValueOnce(new InboxTriageNotFoundError());
      const response = await app.inject({ method: "POST", url: `/conversations/${conversationId}/manual-mark`, payload: { marked: false } });
      expect(response.statusCode).toBe(404);
      expect(triage.setManualMark).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace_a" }));
    } finally { await app.close(); }
  });
});
