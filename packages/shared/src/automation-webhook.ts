import { z } from "zod";

// Public endpoint used by the "Webhook externo" trigger. The API serves it at
// this path; the web app prefixes it with its own API base URL.
export const AUTOMATION_WEBHOOK_PATH_PREFIX = "/webhooks/automations/";

export const automationWebhookSchema = z.object({
  automationId: z.string().min(1),
  token: z.string().min(1),
  path: z.string().startsWith(AUTOMATION_WEBHOOK_PATH_PREFIX),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AutomationWebhookDto = z.infer<typeof automationWebhookSchema>;

export function automationWebhookPath(token: string) {
  return `${AUTOMATION_WEBHOOK_PATH_PREFIX}${token}`;
}
