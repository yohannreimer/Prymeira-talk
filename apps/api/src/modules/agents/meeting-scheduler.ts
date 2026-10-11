import { randomUUID } from "node:crypto";

/**
 * Lets an agent offer free slots from one Google Calendar and book a short call
 * with a Google Meet link. Talks to the Calendar REST API with an OAuth refresh
 * token of the calendar owner (a service account cannot create Meet links or
 * invite guests on a personal Google account).
 */

export type MeetingSchedulerConfig = {
  calendarId: string;
  timeZone: string;
  durationMinutes: number;
  /** Weekdays (0 = Sunday) on which calls can be booked. */
  weekdays: number[];
  /** Local opening and closing time, in minutes after midnight. */
  hours: { start: number; end: number };
  slotStepMinutes: number;
  minNoticeMinutes: number;
  daysAhead: number;
  maxSlots: number;
  title: string;
};

export type MeetingSlot = { startsAt: string; label: string };

export type BookedMeeting = {
  eventId: string;
  startsAt: string;
  label: string;
  meetLink: string | null;
  htmlLink: string | null;
};

export type MeetingAvailability = {
  durationMinutes: number;
  timeZone: string;
  availableSlots: MeetingSlot[];
  bookedMeeting: BookedMeeting | null;
};

export type MeetingBookingResult =
  | { status: "booked"; meeting: BookedMeeting; replacedEventIds: string[] }
  | { status: "unavailable"; reason: string; availableSlots: MeetingSlot[] };

export interface MeetingScheduler {
  availability(input: { conversationId: string; now?: Date }): Promise<MeetingAvailability>;
  book(input: {
    conversationId: string;
    startsAt: string;
    contactName?: string | null;
    contactPhone?: string | null;
    attendeeEmail?: string | null;
    notes?: string | null;
    now?: Date;
  }): Promise<MeetingBookingResult>;
}

export type GoogleCalendarCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

type Interval = { start: number; end: number };

const MINUTE = 60_000;
const CONVERSATION_PROPERTY = "talkConversationId";

export function createGoogleCalendarMeetingScheduler(input: {
  credentials: GoogleCalendarCredentials;
  config: MeetingSchedulerConfig;
  fetch?: FetchLike;
}): MeetingScheduler {
  const { config, credentials } = input;
  const request = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const calendarPath = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}`;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken() {
    if (token && token.expiresAt > Date.now() + MINUTE) return token.value;
    const response = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token"
      }).toString()
    });
    if (!response.ok) {
      throw new Error(`Google OAuth token refresh failed (${response.status}): ${await response.text()}`);
    }
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google OAuth token refresh returned no access_token.");
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function google<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await request(url, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      throw new Error(`Google Calendar ${method} failed (${response.status}): ${await response.text()}`);
    }
    return (response.status === 204 ? {} : await response.json()) as T;
  }

  async function busyIntervals(from: Date, to: Date): Promise<Interval[]> {
    const result = await google<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>(
      "POST",
      "https://www.googleapis.com/calendar/v3/freeBusy",
      { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: config.timeZone, items: [{ id: config.calendarId }] }
    );
    const calendar = result.calendars?.[config.calendarId];
    if (!calendar || (calendar.errors && calendar.errors.length > 0)) {
      throw new Error(`Google Calendar free/busy failed for ${config.calendarId}: ${JSON.stringify(calendar?.errors ?? "calendar missing")}`);
    }
    return (calendar.busy ?? []).map((entry) => ({ start: Date.parse(entry.start), end: Date.parse(entry.end) }));
  }

  async function conversationEvents(conversationId: string, now: Date): Promise<GoogleEvent[]> {
    const query = new URLSearchParams({
      privateExtendedProperty: `${CONVERSATION_PROPERTY}=${conversationId}`,
      timeMin: now.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "5"
    });
    const result = await google<{ items?: GoogleEvent[] }>("GET", `${calendarPath}/events?${query.toString()}`);
    return (result.items ?? []).filter((event) => event.status !== "cancelled" && event.start?.dateTime);
  }

  async function freeSlots(now: Date): Promise<MeetingSlot[]> {
    const candidates = candidateStarts(config, now);
    if (candidates.length === 0) return [];
    const busy = await busyIntervals(new Date(candidates[0]), new Date(candidates[candidates.length - 1] + config.durationMinutes * MINUTE));
    const free = candidates.filter((start) => isFree(busy, start, start + config.durationMinutes * MINUTE));
    return spreadSlots(free, config).map((start) => toSlot(start, config));
  }

  return {
    async availability({ conversationId, now = new Date() }) {
      const [availableSlots, events] = await Promise.all([freeSlots(now), conversationEvents(conversationId, now)]);
      const booked = events[0];
      return {
        durationMinutes: config.durationMinutes,
        timeZone: config.timeZone,
        availableSlots,
        bookedMeeting: booked ? toBookedMeeting(booked, config) : null
      };
    },

    async book({ conversationId, startsAt, contactName, contactPhone, attendeeEmail, notes, now = new Date() }) {
      const start = Date.parse(startsAt);
      if (!Number.isFinite(start) || !candidateStarts(config, now).includes(start)) {
        return { status: "unavailable", reason: "Horário fora da agenda disponível.", availableSlots: await freeSlots(now) };
      }
      const end = start + config.durationMinutes * MINUTE;
      if (!isFree(await busyIntervals(new Date(start), new Date(end)), start, end)) {
        return { status: "unavailable", reason: "Horário já ocupado na agenda.", availableSlots: await freeSlots(now) };
      }

      const previous = await conversationEvents(conversationId, now);
      const who = contactName?.trim() || contactPhone?.trim() || "lead";
      const email = attendeeEmail?.trim() && isEmail(attendeeEmail.trim()) ? attendeeEmail.trim() : null;
      const query = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: email ? "all" : "none" });
      let event = await google<GoogleEvent>("POST", `${calendarPath}/events?${query.toString()}`, {
        summary: `${config.title} · ${who}`,
        description: [
          "Call marcada pelo agente do Prymeira Talk.",
          contactName ? `Contato: ${contactName}` : null,
          contactPhone ? `WhatsApp: ${contactPhone}` : null,
          email ? `E-mail: ${email}` : null,
          notes?.trim() ? `\n${notes.trim()}` : null
        ].filter(Boolean).join("\n"),
        start: { dateTime: new Date(start).toISOString(), timeZone: config.timeZone },
        end: { dateTime: new Date(end).toISOString(), timeZone: config.timeZone },
        ...(email ? { attendees: [{ email, ...(contactName ? { displayName: contactName } : {}) }] } : {}),
        conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
        extendedProperties: { private: { [CONVERSATION_PROPERTY]: conversationId } }
      });
      if (!meetLinkOf(event) && event.conferenceData?.createRequest?.status?.statusCode === "pending" && event.id) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        event = await google<GoogleEvent>("GET", `${calendarPath}/events/${encodeURIComponent(event.id)}`);
      }

      // A new booking for the same conversation is a reschedule: drop the older call.
      const replacedEventIds: string[] = [];
      for (const old of previous) {
        if (!old.id || old.id === event.id) continue;
        await google("DELETE", `${calendarPath}/events/${encodeURIComponent(old.id)}?sendUpdates=all`);
        replacedEventIds.push(old.id);
      }

      return { status: "booked", meeting: toBookedMeeting(event, config), replacedEventIds };
    }
  };
}

type GoogleEvent = {
  id?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string };
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    createRequest?: { status?: { statusCode?: string } };
  };
};

function meetLinkOf(event: GoogleEvent) {
  return event.hangoutLink
    ?? event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri
    ?? null;
}

function toBookedMeeting(event: GoogleEvent, config: MeetingSchedulerConfig): BookedMeeting {
  const start = Date.parse(event.start?.dateTime ?? "");
  return {
    eventId: event.id ?? "",
    startsAt: Number.isFinite(start) ? toSlot(start, config).startsAt : event.start?.dateTime ?? "",
    label: Number.isFinite(start) ? formatSlotLabel(start, config.timeZone) : "",
    meetLink: meetLinkOf(event),
    htmlLink: event.htmlLink ?? null
  };
}

function isFree(busy: Interval[], start: number, end: number) {
  return busy.every((interval) => interval.end <= start || interval.start >= end);
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Every bookable start (epoch ms) on the configured grid between now + notice and the booking horizon. */
export function candidateStarts(config: MeetingSchedulerConfig, now: Date): number[] {
  const earliest = now.getTime() + config.minNoticeMinutes * MINUTE;
  const today = localParts(now.getTime(), config.timeZone);
  const starts: number[] = [];
  for (let offset = 0; offset <= config.daysAhead; offset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!config.weekdays.includes(day.getUTCDay())) continue;
    for (let minute = config.hours.start; minute + config.durationMinutes <= config.hours.end; minute += config.slotStepMinutes) {
      const start = localToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), minute, config.timeZone);
      if (start >= earliest) starts.push(start);
    }
  }
  return starts;
}

/** Keeps the offer short and varied: earliest days first, up to three spread-out times per day. */
function spreadSlots(free: number[], config: MeetingSchedulerConfig) {
  const byDay = new Map<string, number[]>();
  for (const start of free) {
    const parts = localParts(start, config.timeZone);
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    byDay.set(key, [...(byDay.get(key) ?? []), start]);
  }
  const picked: number[] = [];
  for (const starts of byDay.values()) {
    const indexes = starts.length <= 3 ? starts.map((_, index) => index) : [0, Math.floor(starts.length / 2), starts.length - 1];
    picked.push(...indexes.map((index) => starts[index]));
    if (picked.length >= config.maxSlots) break;
  }
  return picked.slice(0, config.maxSlots);
}

function toSlot(start: number, config: MeetingSchedulerConfig): MeetingSlot {
  return { startsAt: toOffsetIso(start, config.timeZone), label: formatSlotLabel(start, config.timeZone) };
}

export function formatSlotLabel(start: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(start));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("weekday")}, ${part("day")}/${part("month")} às ${part("hour")}:${part("minute")}`;
}

function localParts(epoch: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(epoch));
  const value = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

function offsetMinutes(epoch: number, timeZone: string) {
  const parts = localParts(epoch, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(epoch / 1000) * 1000) / MINUTE);
}

function localToEpoch(year: number, month: number, day: number, minuteOfDay: number, timeZone: string) {
  const naive = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  let epoch = naive - offsetMinutes(naive, timeZone) * MINUTE;
  epoch = naive - offsetMinutes(epoch, timeZone) * MINUTE;
  return epoch;
}

function toOffsetIso(epoch: number, timeZone: string) {
  const offset = offsetMinutes(epoch, timeZone);
  const local = new Date(epoch + offset * MINUTE).toISOString().slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function parseMeetingHours(value: string) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid meeting hours "${value}"; expected HH:MM-HH:MM.`);
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start >= end || end > 24 * 60) throw new Error(`Invalid meeting hours "${value}".`);
  return { start, end };
}

export function parseMeetingWeekdays(value: string) {
  const days = new Set<number>();
  for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);
    if (!range) throw new Error(`Invalid meeting weekdays "${value}"; expected e.g. 1-5 or 1,3,5.`);
    const from = Number(range[1]);
    const to = Number(range[2] ?? range[1]);
    for (let day = from; day <= to; day += 1) if (day <= 6) days.add(day);
  }
  if (days.size === 0) throw new Error(`Invalid meeting weekdays "${value}".`);
  return [...days];
}
