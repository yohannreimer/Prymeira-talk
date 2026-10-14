import { readFile } from "node:fs/promises";
import { weeklyFollowupCatalogSchema } from "../src/modules/supervision/weekly-followup-catalog.js";
const path = process.argv[2];
if (!path) throw new Error("Usage: tsx scripts/validate-supervision-followup-weeks.ts /private/catalog.json");
const weeks = weeklyFollowupCatalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
for (const week of weeks) console.log(JSON.stringify({ id: week.id, conversations: week.items.length,
  followups: week.items.filter(item => item.kind === "follow_up").length,
  reminders: week.items.filter(item => item.kind === "seller_reminder").length }));
