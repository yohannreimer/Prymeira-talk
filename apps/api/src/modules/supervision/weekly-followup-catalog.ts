import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SupervisionError } from "./supervision-access.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const item = z.object({
  workspaceId: z.string().uuid(), conversationId: z.string().uuid(),
  kind: z.enum(["follow_up", "seller_reminder"]), suggestion: z.string().trim().min(1).max(4000)
}).strict();
const week = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), label: z.string().trim().min(1).max(120),
  startDate: date, endDate: date, items: z.array(item).max(500)
}).strict().refine(value => value.startDate <= value.endDate, "Invalid date range")
  .refine(value => new Set(value.items.map(row => `${row.workspaceId}:${row.conversationId}`)).size === value.items.length, "Duplicate conversation");
export const weeklyFollowupCatalogSchema = z.array(week).max(52)
  .refine(value => new Set(value.map(row => row.id)).size === value.length, "Duplicate week");
export type WeeklyFollowupCatalog = z.infer<typeof weeklyFollowupCatalogSchema>;

/** Operator-managed JSON; re-read each time so publishing a week does not need a restart or DB write. */
export async function loadWeeklyFollowupCatalog(configuredPath = process.env.TALK_SUPERVISION_FOLLOWUP_WEEKS_FILE): Promise<WeeklyFollowupCatalog> {
  try {
    const path = configuredPath || join(process.env.TALK_MEDIA_STORE_PATH || "/data/media", "supervision-followup-weeks.json");
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 1_000_000) throw new Error("Catalog too large");
    return weeklyFollowupCatalogSchema.parse(JSON.parse(text));
  } catch (error) {
    if (!configuredPath && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SupervisionError(503, "Não foi possível carregar a seleção semanal. Tente novamente.");
  }
}
