import { describe, expect, it } from "vitest";
import {
  formatTriageContext,
  hasPendingHandoff,
  shouldShowMarked,
  shouldShowReply,
  shouldShowUnread
} from "./inbox-triage-policy.js";

describe("inbox triage policy", () => {
  const human = { aiControlStatus: "human_controlled", pendingHandoff: false };
  const agent = { aiControlStatus: "agent_allowed", pendingHandoff: false };

  it("shows unread human work and handoffs, but not normal AI traffic", () => {
    expect(shouldShowUnread({ ...human, unreadCount: 2 })).toBe(true);
    expect(shouldShowUnread({ ...agent, unreadCount: 2 })).toBe(false);
    expect(shouldShowUnread({ ...agent, pendingHandoff: true, unreadCount: 1 })).toBe(true);
    expect(shouldShowUnread({ ...human, unreadCount: 0 })).toBe(false);
  });

  it("keeps handoffs separate from semantic dismissals and closed conversations", () => {
    expect(hasPendingHandoff({ status: "open", aiControlStatus: "human_controlled", handoffReason: "Revisão" })).toBe(true);
    expect(hasPendingHandoff({ status: "closed", aiControlStatus: "human_controlled", handoffReason: "Revisão" })).toBe(false);
    expect(hasPendingHandoff({ status: "open", aiControlStatus: "agent_allowed", activeAgentSessionStatus: "handoff_requested", handoffActionCompletedAt: "2026-09-25T12:00:00Z" })).toBe(false);
    expect(shouldShowReply({ ...human, pendingHandoff: true, decision: "no_reply", dismissed: true })).toBe(true);
  });

  it("shows requests and uncertainty until the anchored message is dismissed", () => {
    expect(shouldShowReply({ ...human, decision: "needs_reply", dismissed: false })).toBe(true);
    expect(shouldShowReply({ ...human, decision: "uncertain", dismissed: false })).toBe(true);
    expect(shouldShowReply({ ...human, decision: "no_reply", dismissed: false })).toBe(false);
    expect(shouldShowReply({ ...human, decision: "needs_reply", dismissed: true })).toBe(false);
    expect(shouldShowReply({ ...agent, decision: "needs_reply", dismissed: false })).toBe(false);
    expect(shouldShowMarked({ manualMarkedAt: new Date() })).toBe(true);
    expect(shouldShowMarked({ manualMarkedAt: null })).toBe(false);
  });

  it("formats up to 20 useful messages with explicit authors and no internal notes", () => {
    const messages = [
      { id: "old", direction: "inbound" as const, author: "cliente" as const, type: "text", body: "antiga", createdAt: "2026-09-25T10:00:00Z" },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, direction: "outbound" as const, author: "empresa_humano" as const, type: "text", body: `resposta ${i}`, createdAt: `2026-09-25T10:${String(i + 1).padStart(2, "0")}:00Z` })),
      { id: "note", direction: "outbound" as const, author: "empresa_humano" as const, type: "internal_note", body: "segredo", createdAt: "2026-09-25T11:00:00Z" },
      { id: "file", direction: "inbound" as const, author: "cliente" as const, type: "file", body: null, createdAt: "2026-09-25T11:01:00Z" }
    ];
    const formatted = formatTriageContext(messages);
    expect(formatted).toContain("Cliente");
    expect(formatted).toContain("Empresa (humano)");
    expect(formatted).toContain("conteúdo indisponível");
    expect(formatted).not.toContain("segredo");
    expect(formatted).not.toContain("antiga");
    expect(formatted.match(/\[id=/g)).toHaveLength(20);
  });
});
