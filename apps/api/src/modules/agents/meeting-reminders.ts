import {
  readMeetingRemindersConfig,
  type MeetingReminderMessage
} from "@prymeira-talk/shared";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { toMessageDto } from "../conversations/conversations.service.js";
import type { BookedMeeting, MeetingScheduler } from "./meeting-scheduler.js";
import { typingDelayMs } from "./reply-bubbles.js";

/**
 * Messages an agent sends before a call it booked. Booking creates one row per
 * configured step ("1 hora antes", "3 horas antes"...); a poller sends the rows
 * that are due through the conversation's WhatsApp channel. Before sending, the
 * call is looked up again in Google Calendar, so a call that was moved or
 * deleted by hand does not get a reminder.
 */

const MINUTE = 60_000;
const STALE_PROCESSING_MS = 10 * MINUTE;
export const DEFAULT_MEETING_REMINDER_POLL_INTERVAL_MS = 30_000;

type ReminderRecord = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  eventId: string;
  meetingStartsAt: Date;
  minutesBefore: number;
  dueAt: Date;
  messages: unknown;
  status: string;
};

type ReminderConversation = {
  id: string;
  workspaceId: string;
  channel?: { provider?: string | null; providerKey?: string | null } | null;
  contact?: { name?: string | null; phone?: string | null } | null;
};

type ReminderMessageRecord = Parameters<typeof toMessageDto>[0];

export interface MeetingRemindersPrismaLike {
  meetingReminder: {
    createMany(args: unknown): Promise<{ count: number }>;
    updateMany(args: unknown): Promise<{ count: number }>;
    findMany(args: unknown): Promise<ReminderRecord[]>;
    update(args: unknown): Promise<unknown>;
  };
  conversation: {
    findUnique(args: unknown): Promise<ReminderConversation | null>;
    update(args: unknown): Promise<unknown>;
  };
  message: {
    create(args: unknown): Promise<ReminderMessageRecord>;
  };
}

type ReminderEvolution = {
  mode: EvolutionRuntime["mode"];
  client?:
    | (Pick<NonNullable<EvolutionRuntime["client"]>, "sendText"> &
        Partial<Pick<NonNullable<EvolutionRuntime["client"]>, "sendMedia">>)
    | null;
};

export type MeetingReminderService = ReturnType<typeof createMeetingReminderService>;

export function createMeetingReminderService(input: {
  prisma: MeetingRemindersPrismaLike;
  evolution?: ReminderEvolution;
  meetingScheduler?: Pick<MeetingScheduler, "availability">;
  timeZone: string;
  realtime?: { publish(event: unknown): void };
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
  batchSize?: number;
}) {
  const { prisma } = input;
  const batchSize = input.batchSize ?? 20;

  async function finish(id: string, data: { status: string; error?: string | null; sentAt?: Date }) {
    await prisma.meetingReminder.update({
      where: { id },
      data: { status: data.status, error: data.error ?? null, lockedAt: null, ...(data.sentAt ? { sentAt: data.sentAt } : {}) }
    });
  }

  async function stillBooked(reminder: ReminderRecord): Promise<{ booked: boolean; meetLink: string | null }> {
    if (!input.meetingScheduler) return { booked: true, meetLink: null };
    try {
      const { bookedMeeting } = await input.meetingScheduler.availability({ conversationId: reminder.conversationId });
      if (!bookedMeeting || Date.parse(bookedMeeting.startsAt) !== reminder.meetingStartsAt.getTime()) {
        return { booked: false, meetLink: null };
      }
      return { booked: true, meetLink: bookedMeeting.meetLink };
    } catch (error) {
      // A calendar hiccup should not cost the reminder of a call that is most likely still on.
      input.logger?.warn({ err: error, reminderId: reminder.id }, "Meeting reminder could not re-check the calendar");
      return { booked: true, meetLink: null };
    }
  }

  async function send(reminder: ReminderRecord, conversation: ReminderConversation, meetLink: string | null) {
    const instanceName = conversation.channel?.providerKey;
    const number = conversation.contact?.phone;
    const client = input.evolution?.mode === "real" ? input.evolution.client : null;
    if (conversation.channel?.provider !== "evolution" || !client || !instanceName || !number) {
      throw new Error("Esta conversa não tem um canal de WhatsApp que envie lembretes.");
    }

    const values = reminderValues(conversation.contact?.name ?? null, reminder.meetingStartsAt, input.timeZone, meetLink);
    const messages = readReminderMessages(reminder.messages);
    let preview: string | null = null;
    for (const message of messages) {
      const text = renderReminderText(message.text, values);
      const media = message.mediaUrl ? describeMedia(message.mediaUrl) : null;
      if (media && !client.sendMedia) throw new Error("O canal não envia arquivos.");
      const providerSend = media
        ? await client.sendMedia!({
            instanceName,
            number,
            mediatype: media.mediatype,
            mimetype: media.mimetype,
            media: message.mediaUrl!,
            fileName: media.fileName,
            ...(text ? { caption: text } : {})
          })
        : await client.sendText({ instanceName, number, text, delay: typingDelayMs(text) });
      const record = await prisma.message.create({
        data: {
          workspaceId: reminder.workspaceId,
          conversationId: reminder.conversationId,
          direction: "outbound",
          type: media ? (media.mediatype === "image" ? "image" : "file") : "text",
          body: text || media?.fileName || "",
          ...(media ? { mediaUrl: message.mediaUrl } : {}),
          providerMessageId: providerSend.providerMessageId ?? undefined,
          status: "sent",
          sentByUserId: null,
          metadata: { source: "meeting_reminder", agentId: reminder.agentId, reminderId: reminder.id, minutesBefore: reminder.minutesBefore }
        }
      });
      input.realtime?.publish({ type: "message.created", workspaceId: reminder.workspaceId, payload: toMessageDto(record) });
      preview = text || media?.fileName || preview;
    }
    await prisma.conversation.update({
      where: { workspaceId_id: { workspaceId: reminder.workspaceId, id: reminder.conversationId } },
      data: { lastMessageAt: new Date(), ...(preview ? { lastMessagePreview: preview } : {}) }
    });
  }

  return {
    /**
     * Plans the reminders of a call the agent just booked. Pending reminders of
     * the conversation's earlier call are cancelled first (a reschedule).
     * Steps whose time already passed are left out.
     */
    async scheduleForBooking(args: {
      workspaceId: string;
      conversationId: string;
      agentId: string;
      behaviorConfig: unknown;
      meeting: Pick<BookedMeeting, "eventId" | "startsAt">;
      now?: Date;
    }) {
      const now = args.now ?? new Date();
      await prisma.meetingReminder.updateMany({
        where: { workspaceId: args.workspaceId, conversationId: args.conversationId, status: "scheduled" },
        data: { status: "canceled", error: "A call foi remarcada." }
      });
      const config = readMeetingRemindersConfig(args.behaviorConfig);
      const start = Date.parse(args.meeting.startsAt);
      if (!config.enabled || !Number.isFinite(start)) return { scheduled: [] as number[] };
      const steps = config.steps.filter((step) => start - step.minutesBefore * MINUTE > now.getTime());
      if (steps.length > 0) {
        await prisma.meetingReminder.createMany({
          data: steps.map((step) => ({
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            agentId: args.agentId,
            eventId: args.meeting.eventId,
            meetingStartsAt: new Date(start),
            minutesBefore: step.minutesBefore,
            dueAt: new Date(start - step.minutesBefore * MINUTE),
            messages: step.messages,
            status: "scheduled"
          }))
        });
      }
      return { scheduled: steps.map((step) => step.minutesBefore) };
    },

    /** Sends every reminder that is due. Safe to run from several instances: each row is claimed first. */
    async processDue(now = new Date()) {
      await prisma.meetingReminder.updateMany({
        where: { status: "processing", lockedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } },
        data: { status: "failed", lockedAt: null, error: "O envio foi interrompido." }
      });
      const due = await prisma.meetingReminder.findMany({
        where: { status: "scheduled", dueAt: { lte: now } },
        orderBy: [{ dueAt: "asc" }],
        take: batchSize
      });
      const results: Array<{ id: string; status: string }> = [];
      for (const reminder of due) {
        const claim = await prisma.meetingReminder.updateMany({
          where: { id: reminder.id, status: "scheduled" },
          data: { status: "processing", lockedAt: now }
        });
        if (claim.count !== 1) continue;
        try {
          if (now.getTime() >= reminder.meetingStartsAt.getTime()) {
            await finish(reminder.id, { status: "skipped", error: "A call já começou." });
            results.push({ id: reminder.id, status: "skipped" });
            continue;
          }
          const check = await stillBooked(reminder);
          if (!check.booked) {
            await finish(reminder.id, { status: "canceled", error: "A call não está mais na agenda." });
            results.push({ id: reminder.id, status: "canceled" });
            continue;
          }
          const conversation = await prisma.conversation.findUnique({
            where: { workspaceId_id: { workspaceId: reminder.workspaceId, id: reminder.conversationId } },
            include: { channel: true, contact: true }
          });
          if (!conversation) {
            await finish(reminder.id, { status: "canceled", error: "A conversa não existe mais." });
            results.push({ id: reminder.id, status: "canceled" });
            continue;
          }
          await send(reminder, conversation, check.meetLink);
          await finish(reminder.id, { status: "sent", sentAt: new Date() });
          results.push({ id: reminder.id, status: "sent" });
        } catch (error) {
          input.logger?.warn({ err: error, reminderId: reminder.id }, "Meeting reminder failed");
          await finish(reminder.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
          results.push({ id: reminder.id, status: "failed" });
        }
      }
      return results;
    }
  };
}

export function createMeetingReminderPoller(input: {
  service: Pick<MeetingReminderService, "processDue">;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  function poll() {
    if (running) return;
    running = input.service
      .processDue()
      .catch((error: unknown) => input.onError?.(error))
      .finally(() => {
        running = null;
      });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(poll, input.pollIntervalMs ?? DEFAULT_MEETING_REMINDER_POLL_INTERVAL_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    }
  };
}

type ReminderValues = Record<"nome" | "primeiro_nome" | "dia" | "hora" | "horario" | "link", string>;

export function reminderValues(name: string | null, startsAt: Date, timeZone: string, meetLink: string | null): ReminderValues {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(startsAt);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const dia = `${part("weekday")}, ${part("day")}/${part("month")}`;
  const hora = `${part("hour")}:${part("minute")}`;
  const nome = name?.trim() ?? "";
  return { nome, primeiro_nome: nome.split(/\s+/)[0] ?? "", dia, hora, horario: `${dia} às ${hora}`, link: meetLink ?? "" };
}

/** Fills {{placeholders}}; a line that only carried missing values (like "Link: {{link}}" without a link) is dropped. */
export function renderReminderText(text: string, values: ReminderValues) {
  const placeholder = /\{\{\s*([a-z_]+)\s*\}\}/gi;
  const valueOf = (key: string) => values[key.toLowerCase() as keyof ReminderValues] ?? "";
  return text
    .split("\n")
    .flatMap((line) => {
      const keys = [...line.matchAll(placeholder)].map((match) => match[1]!);
      if (keys.length > 0 && keys.every((key) => !valueOf(key))) {
        const rest = line.replace(placeholder, "").trim();
        if (!rest || rest.endsWith(":")) return [];
      }
      return [line.replace(placeholder, (_match, key: string) => valueOf(key))];
    })
    .join("\n")
    .trim();
}

function readReminderMessages(value: unknown): MeetingReminderMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    const mediaUrl = typeof record.mediaUrl === "string" && record.mediaUrl.trim() ? record.mediaUrl.trim() : null;
    return text.trim() || mediaUrl ? [{ text, mediaUrl }] : [];
  });
}

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO = /\.(mp4|mov|webm|m4v)$/i;
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/mp4", pdf: "application/pdf"
};

export function describeMedia(url: string): { mediatype: "image" | "video" | "document"; mimetype: string; fileName: string } {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep the raw value */ }
  const fileName = decodeURIComponent(path.split("/").pop() || "arquivo");
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  return {
    mediatype: IMAGE.test(fileName) ? "image" : VIDEO.test(fileName) ? "video" : "document",
    mimetype: MIME[extension] ?? "application/octet-stream",
    fileName
  };
}
