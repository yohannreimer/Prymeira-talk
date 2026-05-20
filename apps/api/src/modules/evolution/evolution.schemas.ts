import { z } from "zod";

export const evolutionWebhookSchema = z.object({
  event: z.string().min(1),
  instance: z.string().min(1),
  data: z
    .object({
      key: z.object({
        id: z.string().min(1),
        remoteJid: z.string().min(1),
        fromMe: z.boolean().default(false)
      }),
      message: z
        .object({
          conversation: z.string().optional()
        })
        .passthrough()
        .optional(),
      messageTimestamp: z.number().optional()
    })
    .passthrough()
});

export type EvolutionWebhookPayload = z.infer<typeof evolutionWebhookSchema>;
