import { describe, expect, it } from "vitest";
import {
  candidateStarts,
  createGoogleCalendarMeetingScheduler,
  formatSlotLabel,
  parseMeetingHours,
  parseMeetingWeekdays,
  type MeetingSchedulerConfig
} from "./meeting-scheduler.js";

const config: MeetingSchedulerConfig = {
  calendarId: "primary",
  timeZone: "America/Sao_Paulo",
  durationMinutes: 15,
  weekdays: [1, 2, 3, 4, 5],
  hours: { start: 9 * 60, end: 12 * 60 },
  slotStepMinutes: 30,
  minNoticeMinutes: 120,
  daysAhead: 2,
  maxSlots: 9,
  title: "Call Prymeira"
};

// Monday 12 Oct 2026, 08:00 in São Paulo (UTC-3).
const now = new Date("2026-10-12T11:00:00Z");

type Call = { url: string; method: string; body?: unknown };

function fakeGoogle(handlers: {
  busy?: Array<{ start: string; end: string }>;
  existing?: Array<Record<string, unknown>>;
  created?: Record<string, unknown>;
}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    const body = init.body && url.includes("googleapis.com/calendar") ? JSON.parse(init.body) : init.body;
    calls.push({ url, method, body });
    let payload: unknown = {};
    if (url.startsWith("https://oauth2.googleapis.com/token")) payload = { access_token: "token-1", expires_in: 3600 };
    else if (url.endsWith("/freeBusy")) payload = { calendars: { primary: { busy: handlers.busy ?? [] } } };
    else if (method === "GET" && url.includes("/events?")) payload = { items: handlers.existing ?? [] };
    else if (method === "POST" && url.includes("/events?")) payload = handlers.created ?? {};
    return { ok: true, status: method === "DELETE" ? 204 : 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { calls, fetch };
}

function scheduler(fetch: ReturnType<typeof fakeGoogle>["fetch"]) {
  return createGoogleCalendarMeetingScheduler({
    credentials: { clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
    config,
    fetch
  });
}

describe("meeting scheduler", () => {
  it.each(["freeBusy", "prior events"])("does not invite or replace a call when reset happens during %s reads", async (stage) => {
    const google = fakeGoogle({
      existing: [{ id: "ev-old", status: "confirmed", start: { dateTime: "2026-10-13T09:00:00-03:00" } }],
      created: { id: "ev-new", start: { dateTime: "2026-10-13T10:30:00-03:00" }, hangoutLink: "https://meet.google.com/new" }
    });
    let current = true;
    const fetch: typeof google.fetch = async (url, init) => {
      const response = await google.fetch(url, init);
      if ((stage === "freeBusy" && url.endsWith("/freeBusy")) || (stage === "prior events" && init?.method === "GET" && url.includes("/events?"))) current = false;
      return response;
    };
    await expect(scheduler(fetch).book({ conversationId: "conv-1", startsAt: "2026-10-13T10:30:00-03:00", now, stillCurrent: async () => current })).rejects.toThrow("Conversation history was reset.");
    expect(google.calls.filter(call => call.method === "DELETE" || (call.method === "POST" && call.url.includes("/events?")))).toEqual([]);
  });

  it("revalidates before each deletion after the new invitation was already accepted", async () => {
    const google = fakeGoogle({
      existing: ["ev-old-1", "ev-old-2"].map(id => ({ id, status: "confirmed", start: { dateTime: "2026-10-13T09:00:00-03:00" } })),
      created: { id: "ev-new", start: { dateTime: "2026-10-13T10:30:00-03:00" }, hangoutLink: "https://meet.google.com/new" }
    });
    let current = true;
    const fetch: typeof google.fetch = async (url, init) => {
      const response = await google.fetch(url, init);
      if (init?.method === "DELETE") current = false;
      return response;
    };
    await expect(scheduler(fetch).book({ conversationId: "conv-1", startsAt: "2026-10-13T10:30:00-03:00", now, stillCurrent: async () => current })).rejects.toThrow("Conversation history was reset.");
    expect(google.calls.filter(call => call.method === "DELETE").map(call => call.url)).toEqual([expect.stringContaining("/events/ev-old-1?")]);
  });

  it("builds the local grid after the minimum notice, skipping weekends", () => {
    const starts = candidateStarts(config, now).map((start) => new Date(start).toISOString());
    // Monday from 10:00 local (08:00 + 2h notice); Tuesday the full morning; Wednesday is past daysAhead=2.
    expect(starts.slice(0, 4)).toEqual([
      "2026-10-12T13:00:00.000Z",
      "2026-10-12T13:30:00.000Z",
      "2026-10-12T14:00:00.000Z",
      "2026-10-12T14:30:00.000Z"
    ]);
    expect(starts).toContain("2026-10-13T12:00:00.000Z");
    expect(starts).toContain("2026-10-14T14:30:00.000Z");
    expect(starts).not.toContain("2026-10-15T12:00:00.000Z");
  });

  it("offers free slots in local time with Portuguese labels and the booked call", async () => {
    const google = fakeGoogle({
      busy: [{ start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" }],
      existing: [{ id: "ev-old", status: "confirmed", start: { dateTime: "2026-10-13T09:00:00-03:00" }, hangoutLink: "https://meet.google.com/old" }]
    });
    const availability = await scheduler(google.fetch).availability({ conversationId: "conv-1", now });

    expect(availability.availableSlots[0]).toEqual({
      startsAt: "2026-10-12T11:00:00-03:00",
      label: "segunda-feira, 12/10 às 11:00"
    });
    expect(availability.availableSlots.some((slot) => slot.startsAt.startsWith("2026-10-12T10:"))).toBe(false);
    expect(availability.bookedMeeting).toMatchObject({ eventId: "ev-old", meetLink: "https://meet.google.com/old" });
    const listCall = google.calls.find((call) => call.method === "GET");
    expect(listCall?.url).toContain("privateExtendedProperty=talkConversationId%3Dconv-1");
  });

  it("books with a Meet link and replaces the earlier call of the same conversation", async () => {
    const google = fakeGoogle({
      existing: [{ id: "ev-old", status: "confirmed", start: { dateTime: "2026-10-13T09:00:00-03:00" } }],
      created: { id: "ev-new", start: { dateTime: "2026-10-13T10:30:00-03:00" }, hangoutLink: "https://meet.google.com/abc-defg-hij", htmlLink: "https://calendar.google.com/e/1" }
    });
    const result = await scheduler(google.fetch).book({
      conversationId: "conv-1",
      startsAt: "2026-10-13T10:30:00-03:00",
      contactName: "Ana",
      contactPhone: "5547999990000",
      attendeeEmail: "ana@example.com",
      now
    });

    expect(result).toEqual({
      status: "booked",
      meeting: {
        eventId: "ev-new",
        createdAt: null,
        startsAt: "2026-10-13T10:30:00-03:00",
        label: "terça-feira, 13/10 às 10:30",
        meetLink: "https://meet.google.com/abc-defg-hij",
        htmlLink: "https://calendar.google.com/e/1"
      },
      replacedEventIds: ["ev-old"]
    });
    const insert = google.calls.find((call) => call.method === "POST" && call.url.includes("/events?"));
    expect(insert?.url).toContain("conferenceDataVersion=1");
    expect(insert?.url).toContain("sendUpdates=all");
    expect(insert?.body).toMatchObject({
      summary: "Call Prymeira · Ana",
      start: { dateTime: "2026-10-13T13:30:00.000Z", timeZone: "America/Sao_Paulo" },
      end: { dateTime: "2026-10-13T13:45:00.000Z" },
      attendees: [{ email: "ana@example.com", displayName: "Ana" }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } },
      extendedProperties: { private: { talkConversationId: "conv-1" } }
    });
    expect(google.calls.some((call) => call.method === "DELETE" && call.url.includes("/events/ev-old"))).toBe(true);
  });

  it("refuses a busy or off-grid time and offers fresh slots instead", async () => {
    const google = fakeGoogle({ busy: [{ start: "2026-10-13T13:30:00Z", end: "2026-10-13T13:45:00Z" }] });
    const service = scheduler(google.fetch);

    const busy = await service.book({ conversationId: "conv-1", startsAt: "2026-10-13T10:30:00-03:00", now });
    expect(busy.status).toBe("unavailable");
    expect(busy.status === "unavailable" && busy.availableSlots.length).toBeGreaterThan(0);

    const offGrid = await service.book({ conversationId: "conv-1", startsAt: "2026-10-13T10:10:00-03:00", now });
    expect(offGrid).toMatchObject({ status: "unavailable", reason: "Horário fora da agenda disponível." });
    expect(google.calls.some((call) => call.method === "POST" && call.url.includes("/events?"))).toBe(false);
  });

  it("parses the env formats", () => {
    expect(parseMeetingHours("09:00-18:30")).toEqual({ start: 540, end: 1110 });
    expect(parseMeetingWeekdays("1-5")).toEqual([1, 2, 3, 4, 5]);
    expect(parseMeetingWeekdays("1,3,6")).toEqual([1, 3, 6]);
    expect(() => parseMeetingHours("18:00-09:00")).toThrow();
    expect(formatSlotLabel(Date.parse("2026-10-16T17:00:00Z"), "America/Sao_Paulo")).toBe("sexta-feira, 16/10 às 14:00");
  });
});

it('read-only recovery requires confirmed scoped private property and real created time without free/busy', async () => {
 const enabledAt = new Date('2026-10-12T10:00:00Z');
 const valid = { id: 'confirmed', status: 'confirmed', created: '2026-10-12T11:00:00Z', start: { dateTime: '2026-10-13T10:30:00-03:00' }, extendedProperties: { private: { talkConversationId: 'conv-1' } } };
 const google=fakeGoogle({existing:[valid,{...valid,id:'cancelled',status:'cancelled'},{...valid,id:'missing-property',extendedProperties:undefined},{...valid,id:'wrong-conversation',extendedProperties:{private:{talkConversationId:'other'}}},{...valid,id:'old',created:'2026-10-11T11:00:00Z'},{...valid,id:'missing-created',created:undefined}]});
 const rows=await scheduler(google.fetch).confirmedBookings!({conversationId:'conv-1',createdAfter:enabledAt});
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({eventId:'confirmed',createdAt:valid.created});
 expect(google.calls.filter(call=>call.url.includes('/calendar/')).every(call=>call.method==='GET'&&!call.url.includes('freeBusy'))).toBe(true);
});
