import { describe, expect, it, vi } from "vitest";
import { buildContextualFollowupProfile, isPersistedAutomationForm, type ProfileInput } from "./contextual-followup-profiles.js";

function fixture() {
  const input: ProfileInput = {
    workspaceId: "w", conversationId: "c", agentId: "a", sessionId: "s", expectedGeneration: "g", profile: "commercial",
    agent: { id: "a", name: "Maria site_form", type: "attendance", handoffConfig: { prospectingGoal: "Convidar para reunião" } }, channelConfig: {},
    messages: [{ id: "in", label: "cliente", direction: "inbound", type: "text", createdAt: "2026-10-19T12:00Z", body: "Vim do formulário, quero saber mais" }],
    formEvidenceMessageIds: [], factualSourceIds: ["own-offer"], recordedBookings: []
  };
  const reservation = { workspaceId: "w", conversationId: "c", status: "confirmed", confirmedAt: new Date(), dispatchIntentAt: new Date(), agentId: "a", generation: "g", recipientId: "r", campaignId: "campaign", pendingInboundMessageId: "in" };
  const conversation = { status: "open", aiControlStatus: "agent_allowed", assignedUserId: null, activeAgentSessionId: "s", contact: { isGroup: false, phone: "5511999992222" }, channel: { provider: "evolution" } };
  const session = { id: "s", firstResponseMessageId: "in", status: "active" };
  const db = {
    campaignProspectingReservation: { findUnique: vi.fn(async (): Promise<unknown> => reservation) },
    workspaceMirror: { findUnique: vi.fn(async () => ({ limits: { modules: { campaignProspecting: true } } })) },
    conversation: { findFirst: vi.fn(async () => conversation) },
    aiAgentSession: { findFirst: vi.fn(async () => session) },
    aiAgent: { findFirst: vi.fn(async () => ({ type: "prospecting", status: "active" })) }
  };
  const sendText = vi.fn(); const book = vi.fn(); const availability = vi.fn();
  return { input, reservation, conversation, session, db, sendText, book, availability,
    build: () => buildContextualFollowupProfile({ ...db, sendText, book, availability }, input) };
}

describe("follow-up profile adapters without executors", () => {
  it("proves form origin only with persisted automation system metadata", async () => {
    const f = fixture();
    expect(isPersistedAutomationForm({ type: "system", metadata: { source: "automation_webhook" } })).toBe(true);
    expect(isPersistedAutomationForm({ type: "text", metadata: { source: "automation_webhook" } })).toBe(false);
    expect(isPersistedAutomationForm({ type: "system", metadata: { source: "customer" } })).toBe(false);
    let result = await f.build();
    expect(result.status === "ready" && result.profile.origin).toBe("direct_inbound");
    f.input.formEvidenceMessageIds = ["persisted-system-form"];
    result = await f.build();
    expect(result.status === "ready" && result.profile).toMatchObject({ origin: "site_form", formEvidenceMessageIds: ["persisted-system-form"], factualSourceIds: ["own-offer"] });
    expect(f.sendText).not.toHaveBeenCalled(); expect(f.book).not.toHaveBeenCalled(); expect(f.availability).not.toHaveBeenCalled();
  });

  it("distinguishes recorded bookings from unverified historical slots and promises", async () => {
    const f = fixture();
    f.input.messages[0]!.body = "Ontem você ofereceu terça 14h e disse que ia reservar. Está confirmado?";
    let result = await f.build();
    expect(result.status === "ready" && result.profile).toMatchObject({ meeting: { state: "unknown", availability: "unknown", currentCalendarVerified: false }, abstentions: expect.arrayContaining(["booking_not_confirmed"]) });
    f.input.recordedBookings = [{ evidenceId: "reminder", eventId: "real-event", startsAt: "2026-10-21T14:00Z" }];
    result = await f.build();
    expect(result.status === "ready" && result.profile.meeting).toMatchObject({ state: "recorded_booking", currentCalendarVerified: false, availability: "unknown" });
    expect(result.status === "ready" && result.profile.constraints.join(" ")).toContain("Do not invite to book again");
    expect(f.book).not.toHaveBeenCalled(); expect(f.availability).not.toHaveBeenCalled();
  });

  it.each(["attendance", "commercial", "prospecting"] as const)("%s does not borrow company facts or refer new buyers to outbound", async profile => {
    const f = fixture(); f.input.profile = profile; if (profile === "prospecting") f.input.agent.type = "prospecting"; f.input.factualSourceIds = [];
    const result = await f.build();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.profile.factualSourceIds).toEqual([]);
    expect(result.profile.constraints.join(" ")).toContain("later internal seller reminder");
    expect(JSON.stringify(result)).not.toMatch(/Villefer|R\$|Prymeira/);
    expect(f.sendText).not.toHaveBeenCalled(); expect(f.book).not.toHaveBeenCalled(); expect(f.availability).not.toHaveBeenCalled();
  });

  it("allows only the confirmed current prospecting generation and linked active respondent", async () => {
    const f = fixture(); f.input.profile = "prospecting"; f.input.agent.type = "prospecting";
    expect(await f.build()).toMatchObject({ status: "ready", profile: { prospecting: { campaignId: "campaign", recipientId: "r", generation: "g", sessionId: "s", goal: "Convidar para reunião" } } });
    expect(f.db.aiAgentSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", conversationId: "c", agentId: "a", sourceRecipientId: "r", prospectingGeneration: "g" } }));
  });

  it.each(["absent", "unconfirmed", "replaced_generation", "replaced_session", "closed", "optout", "emergency", "human", "cold", "no_goal", "wrong_agent", "paused_session"])("abstains for prospecting %s", async reason => {
    const f = fixture(); f.input.profile = "prospecting"; f.input.agent.type = "prospecting";
    if (reason === "absent") f.db.campaignProspectingReservation.findUnique.mockResolvedValue(null);
    if (reason === "unconfirmed") f.reservation.status = "sending";
    if (reason === "replaced_generation") f.reservation.generation = "new-generation";
    if (reason === "replaced_session") f.conversation.activeAgentSessionId = "new-session";
    if (reason === "closed") f.conversation.status = "closed";
    if (reason === "optout") f.input.messages[0]!.body = "Não tenho interesse. Pare de enviar mensagens";
    if (reason === "emergency") f.db.workspaceMirror.findUnique.mockResolvedValue({ limits: { modules: { campaignProspecting: false } } });
    if (reason === "human") f.conversation.aiControlStatus = "human_controlled";
    if (reason === "cold") f.input.messages[0]!.label = "atendente";
    if (reason === "no_goal") f.input.agent.handoffConfig = {};
    if (reason === "wrong_agent") f.reservation.agentId = "other-agent";
    if (reason === "paused_session") f.session.status = "paused_by_human";
    expect(await f.build()).toMatchObject({ status: "unavailable", reason: "policy_changed", detail: "prospecting_not_authorized" });
    expect(f.sendText).not.toHaveBeenCalled(); expect(f.book).not.toHaveBeenCalled(); expect(f.availability).not.toHaveBeenCalled();
  });
});
