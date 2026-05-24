import { z } from "zod";

export const evolutionWebhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  instance: z.string().min(1),
  data: z.unknown().optional()
});

export const evolutionWebhookSchema = evolutionWebhookEnvelopeSchema.extend({
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

export const evolutionConnectionUpdateSchema = evolutionWebhookEnvelopeSchema.extend({
  data: z
    .object({
      state: z.string().optional(),
      status: z.string().optional()
    })
    .passthrough()
    .optional()
});

export const evolutionMessageStatusUpdateSchema = evolutionWebhookEnvelopeSchema.extend({
  data: z
    .object({
      id: z.string().min(1).optional(),
      keyId: z.string().min(1).optional(),
      messageId: z.string().min(1).optional(),
      status: z.union([z.string(), z.number()]).optional(),
      key: z
        .object({
          id: z.string().min(1).optional()
        })
        .passthrough()
        .optional()
    })
    .passthrough()
    .optional()
});

export const evolutionQrUpdateSchema = evolutionWebhookEnvelopeSchema.extend({
  data: z
    .object({
      qrcode: z.unknown().optional(),
      qrCode: z.string().min(1).optional(),
      code: z.string().min(1).optional(),
      base64: z.string().min(1).optional()
    })
    .passthrough()
    .optional()
});

export type EvolutionWebhookEnvelope = z.infer<typeof evolutionWebhookEnvelopeSchema>;
export type EvolutionWebhookPayload = z.infer<typeof evolutionWebhookSchema>;
export type EvolutionConnectionUpdatePayload = z.infer<typeof evolutionConnectionUpdateSchema>;
export type EvolutionMessageStatusUpdatePayload = z.infer<typeof evolutionMessageStatusUpdateSchema>;
export type EvolutionQrUpdatePayload = z.infer<typeof evolutionQrUpdateSchema>;
