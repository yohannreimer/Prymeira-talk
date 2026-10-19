import { describe, expect, it, vi } from "vitest";
import {
  createMeetingReminderService,
  describeMedia,
  reminderValues,
  renderReminderText,
  type MeetingRemindersPrismaLike
} from "./meeting-reminders.js";

const TZ = "America/Sao_Paulo";
const startsAt = "2026-10-13T13:30:00-03:00";
const start = new Date(startsAt);

function buildPrisma(rows: unknown[] = []) {
  return {
    meetingReminder: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue(rows),
      update: vi.fn().mockResolvedValue({})
    },
    conversation: {
      findUnique: vi.fn().mockResolvedValue({
        id: "conv-1",
        workspaceId: "ws-1",
        channel: { provider: "evolution", providerKey: "prymeira" },
        contact: { name: "João Silva", phone: "5547999990000" }
      }),
      update: vi.fn().mockResolvedValue({})
    },
    message: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `msg-${Math.random()}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        mediaUrl: null,
        providerMessageId: null,
        sentByUserId: null,
        ...data
      }))
    }
  } satisfies MeetingRemindersPrismaLike;
}

function buildEvolution() {
  return {
    mode: "real" as const,
    client: {
      sendText: vi.fn().mockResolvedValue({ providerMessageId: "wa-1" }),
      sendMedia: vi.fn().mockResolvedValue({ providerMessageId: "wa-2" })
    }
  };
}

function buildScheduler(bookedStartsAt: string | null = startsAt) {
  return {
    availability: vi.fn().mockResolvedValue({
      durationMinutes: 30,
      timeZone: TZ,
      availableSlots: [],
      bookedMeeting: bookedStartsAt
        ? { eventId: "ev-1", startsAt: bookedStartsAt, label: "x", meetLink: "https://meet.google.com/abc-defg-hij", htmlLink: null }
        : null
    })
  };
}

function reminderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rem-1",
    workspaceId: "ws-1",
    conversationId: "conv-1",
    agentId: "agent-1",
    eventId: "ev-1",
    meetingStartsAt: start,
    minutesBefore: 60,
    dueAt: new Date(start.getTime() - 60 * 60_000),
    messages: [{ text: "Oi, {{primeiro_nome}}! Nossa call é hoje às {{hora}}.\nLink: {{link}}", mediaUrl: null }],
    status: "scheduled",
    ...overrides
  };
}

describe("meeting reminders", () => {
  describe("scheduleForBooking", () => {
    it("cancels the earlier call's reminders and plans the default one hour before", async () => {
      const prisma = buildPrisma();
      const service = createMeetingReminderService({ prisma, timeZone: TZ });

      const result = await service.scheduleForBooking({
        workspaceId: "ws-1", conversationId: "conv-1", agentId: "agent-1", behaviorConfig: {},
        meeting: { eventId: "ev-1", startsAt }, now: new Date("2026-10-12T10:00:00-03:00")
      });

      expect(result.scheduled).toEqual([60]);
      expect(prisma.meetingReminder.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1", conversationId: "conv-1", status: "scheduled" },
        data: { status: "canceled", error: "A call foi remarcada." }
      });
      expect(prisma.meetingReminder.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ minutesBefore: 60, dueAt: new Date("2026-10-13T12:30:00-03:00"), eventId: "ev-1" })]
      });
    });

    it("leaves out steps whose time already passed", async () => {
      const prisma = buildPrisma();
      const service = createMeetingReminderService({ prisma, timeZone: TZ });
      const behaviorConfig = {
        meetingReminders: {
          enabled: true,
          steps: [
            { minutesBefore: 180, messages: [{ text: "Daqui a pouco tem call." }] },
            { minutesBefore: 60, messages: [{ text: "Em 1 hora." }, { text: "", mediaUrl: "https://example.com/video.mp4" }] }
          ]
        }
      };

      const result = await service.scheduleForBooking({
        workspaceId: "ws-1", conversationId: "conv-1", agentId: "agent-1", behaviorConfig,
        meeting: { eventId: "ev-1", startsAt }, now: new Date("2026-10-13T11:00:00-03:00")
      });

      expect(result.scheduled).toEqual([60]);
      expect(prisma.meetingReminder.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ minutesBefore: 60, messages: behaviorConfig.meetingReminders.steps[1]!.messages })]
      });
    });

    it("plans nothing when the agent turned reminders off", async () => {
      const prisma = buildPrisma();
      const service = createMeetingReminderService({ prisma, timeZone: TZ });

      const result = await service.scheduleForBooking({
        workspaceId: "ws-1", conversationId: "conv-1", agentId: "agent-1",
        behaviorConfig: { meetingReminders: { enabled: false, steps: [] } },
        meeting: { eventId: "ev-1", startsAt }, now: new Date("2026-10-12T10:00:00-03:00")
      });

      expect(result.scheduled).toEqual([]);
      expect(prisma.meetingReminder.updateMany).toHaveBeenCalled();
      expect(prisma.meetingReminder.createMany).not.toHaveBeenCalled();
    });
  });

  describe("processDue", () => {
    it("does not send or overwrite cancellation when reset happens during calendar lookup", async () => {
      const prisma = buildPrisma([reminderRow()]);
      let canceled = false;
      prisma.meetingReminder.findMany.mockImplementation(async (args: any) => args.where.status === "processing" ? canceled ? [] : [reminderRow({ status: "processing" })] : [reminderRow()]);
      const scheduler = buildScheduler();
      scheduler.availability.mockImplementation(async () => { canceled = true; return { durationMinutes: 30, timeZone: TZ, availableSlots: [], bookedMeeting: null }; });
      const evolution = buildEvolution();
      await createMeetingReminderService({ prisma, evolution, meetingScheduler: scheduler, timeZone: TZ }).processDue(new Date("2026-10-13T12:30:30-03:00"));
      expect(evolution.client.sendText).not.toHaveBeenCalled();
      expect(prisma.meetingReminder.update).not.toHaveBeenCalled();
      expect(prisma.meetingReminder.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent" }) }));
    });

    const now = new Date("2026-10-13T12:30:30-03:00");

    it("sends a due reminder with the contact's name, the time and the Meet link", async () => {
      const prisma = buildPrisma([reminderRow()]);
      const evolution = buildEvolution();
      const realtime = { publish: vi.fn() };
      const service = createMeetingReminderService({ prisma, evolution, meetingScheduler: buildScheduler(), timeZone: TZ, realtime });

      const results = await service.processDue(now);

      expect(results).toEqual([{ id: "rem-1", status: "sent" }]);
      expect(evolution.client.sendText).toHaveBeenCalledWith(expect.objectContaining({
        instanceName: "prymeira",
        number: "5547999990000",
        text: "Oi, João! Nossa call é hoje às 13:30.\nLink: https://meet.google.com/abc-defg-hij"
      }));
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ direction: "outbound", type: "text", metadata: expect.objectContaining({ source: "meeting_reminder" }) })
      });
      expect(realtime.publish).toHaveBeenCalledTimes(1);
      expect(prisma.meetingReminder.updateMany).toHaveBeenCalledWith({
        where: { id: "rem-1", status: "processing" },
        data: expect.objectContaining({ status: "sent", error: null })
      });
    });

    it("sends media with the text as caption, in order", async () => {
      const prisma = buildPrisma([reminderRow({
        messages: [
          { text: "Separei um vídeo curto pra você ver antes:", mediaUrl: null },
          { text: "Até já!", mediaUrl: "https://cdn.example.com/raio-x.mp4" }
        ]
      })]);
      const evolution = buildEvolution();
      const service = createMeetingReminderService({ prisma, evolution, meetingScheduler: buildScheduler(), timeZone: TZ });

      await service.processDue(now);

      expect(evolution.client.sendText).toHaveBeenCalledTimes(1);
      expect(evolution.client.sendMedia).toHaveBeenCalledWith(expect.objectContaining({
        mediatype: "video", mimetype: "video/mp4", media: "https://cdn.example.com/raio-x.mp4", fileName: "raio-x.mp4", caption: "Até já!"
      }));
      expect(evolution.client.sendText.mock.invocationCallOrder[0]).toBeLessThan(evolution.client.sendMedia.mock.invocationCallOrder[0]!);
    });

    it("cancels the reminder when the call was moved or removed from the calendar", async () => {
      const prisma = buildPrisma([reminderRow()]);
      const evolution = buildEvolution();
      const service = createMeetingReminderService({
        prisma, evolution, meetingScheduler: buildScheduler("2026-10-14T09:00:00-03:00"), timeZone: TZ
      });

      const results = await service.processDue(now);

      expect(results).toEqual([{ id: "rem-1", status: "canceled" }]);
      expect(evolution.client.sendText).not.toHaveBeenCalled();
    });

    it("skips a reminder whose call already started", async () => {
      const prisma = buildPrisma([reminderRow()]);
      const evolution = buildEvolution();
      const service = createMeetingReminderService({ prisma, evolution, meetingScheduler: buildScheduler(), timeZone: TZ });

      const results = await service.processDue(new Date("2026-10-13T13:31:00-03:00"));

      expect(results).toEqual([{ id: "rem-1", status: "skipped" }]);
      expect(evolution.client.sendText).not.toHaveBeenCalled();
    });

    it("does nothing with a row another instance already claimed", async () => {
      const prisma = buildPrisma([reminderRow()]);
      prisma.meetingReminder.updateMany
        .mockResolvedValueOnce({ count: 0 }) // stale sweep
        .mockResolvedValueOnce({ count: 0 }); // claim lost
      const evolution = buildEvolution();
      const service = createMeetingReminderService({ prisma, evolution, meetingScheduler: buildScheduler(), timeZone: TZ });

      expect(await service.processDue(now)).toEqual([]);
      expect(evolution.client.sendText).not.toHaveBeenCalled();
    });

    it("marks the reminder failed when the channel cannot send", async () => {
      const prisma = buildPrisma([reminderRow()]);
      const evolution = buildEvolution();
      evolution.client.sendText.mockRejectedValue(new Error("Evolution 500"));
      const service = createMeetingReminderService({ prisma, evolution, meetingScheduler: buildScheduler(), timeZone: TZ });

      expect(await service.processDue(now)).toEqual([{ id: "rem-1", status: "failed" }]);
      expect(prisma.meetingReminder.updateMany).toHaveBeenCalledWith({
        where: { id: "rem-1", status: "processing" },
        data: expect.objectContaining({ status: "failed", error: "Evolution 500" })
      });
    });
  });

  describe("text helpers", () => {
    it("fills placeholders in pt-BR", () => {
      const values = reminderValues("Ana Paula", start, TZ, null);
      expect(values).toMatchObject({ primeiro_nome: "Ana", dia: "terça-feira, 13/10", hora: "13:30", horario: "terça-feira, 13/10 às 13:30" });
    });

    it("drops a line that only carried a missing value", () => {
      const values = reminderValues("Ana", start, TZ, null);
      expect(renderReminderText("Oi, {{primeiro_nome}}! Às {{hora}}.\nLink da call: {{link}}", values)).toBe("Oi, Ana! Às 13:30.");
    });

    it("tells images, videos and documents apart by the file name", () => {
      expect(describeMedia("https://x.com/a/foto.JPG").mediatype).toBe("image");
      expect(describeMedia("https://x.com/a/apresentacao.pdf")).toEqual({ mediatype: "document", mimetype: "application/pdf", fileName: "apresentacao.pdf" });
    });
  });
});
