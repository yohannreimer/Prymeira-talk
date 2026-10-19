import { z } from "zod";

/**
 * Messages an agent sends before a call it booked with "Marcar call".
 * Each step fires a number of minutes before the call and sends up to three
 * messages in order: text (links allowed) and/or a media file by URL.
 *
 * Placeholders in text: {{nome}}, {{primeiro_nome}}, {{dia}}, {{hora}},
 * {{horario}} (day and time together) and {{link}} (the Google Meet link).
 */

export const MEETING_REMINDER_PLACEHOLDERS = ["nome", "primeiro_nome", "dia", "hora", "horario", "link"] as const;

export const meetingReminderMessageSchema = z
  .object({
    text: z.string().trim().max(1000).default(""),
    mediaUrl: z.string().trim().url().max(1000).nullable().optional()
  })
  .refine((message) => message.text.length > 0 || Boolean(message.mediaUrl), "Escreva um texto ou informe o link de um arquivo.");

export const meetingReminderStepSchema = z.object({
  minutesBefore: z.number().int().min(5).max(10_080),
  messages: z.array(meetingReminderMessageSchema).min(1).max(3)
});

export const meetingRemindersConfigSchema = z
  .object({
    enabled: z.boolean(),
    steps: z.array(meetingReminderStepSchema).max(5)
  })
  .superRefine((value, context) => {
    const minutes = value.steps.map((step) => step.minutesBefore);
    if (new Set(minutes).size !== minutes.length) {
      context.addIssue({ code: "custom", path: ["steps"], message: "Dois lembretes não podem ter a mesma antecedência." });
    }
  });

export type MeetingReminderMessage = z.infer<typeof meetingReminderMessageSchema>;
export type MeetingReminderStep = z.infer<typeof meetingReminderStepSchema>;
export type MeetingRemindersConfig = z.infer<typeof meetingRemindersConfigSchema>;

export const DEFAULT_MEETING_REMINDERS: MeetingRemindersConfig = {
  enabled: true,
  steps: [
    {
      minutesBefore: 60,
      messages: [{ text: "Oi, {{primeiro_nome}}! Passando pra lembrar da nossa call hoje às {{hora}}. Até já!", mediaUrl: null }]
    }
  ]
};

/** The agent's reminder plan; agents that never saved one get the default 1-hour reminder. */
export function readMeetingRemindersConfig(behaviorConfig: unknown): MeetingRemindersConfig {
  const value = isRecord(behaviorConfig) ? behaviorConfig.meetingReminders : undefined;
  if (value === undefined) return DEFAULT_MEETING_REMINDERS;
  const parsed = meetingRemindersConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_MEETING_REMINDERS;
}

/** Whether the agent sends a reply split on blank lines as separate WhatsApp messages. */
export function readReplyInBubbles(behaviorConfig: unknown): boolean {
  return isRecord(behaviorConfig) && behaviorConfig.replyInBubbles === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
