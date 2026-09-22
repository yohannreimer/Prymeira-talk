import {
  MAX_LEAD_WHATSAPP_BATCH_SIZE as sharedMaxLeadWhatsappBatchSize,
  leadJobStatusSchema,
  leadSourceSchema,
  leadWhatsappStatusSchema,
  normalizedCnpjSchema,
  type LeadJobStatus,
  type LeadSource,
  type LeadWhatsappStatus,
  type NormalizedCnpj
} from "@prymeira-talk/shared";

export const MAX_LEAD_WHATSAPP_BATCH_SIZE = sharedMaxLeadWhatsappBatchSize;

export const leadJobTransitions: Readonly<Record<LeadJobStatus, readonly LeadJobStatus[]>> = {
  queued: ["running", "failed"],
  running: ["completed", "partial", "failed"],
  completed: [],
  partial: ["queued"],
  failed: ["queued"]
};

export function canTransitionLeadJob(from: LeadJobStatus, to: LeadJobStatus) {
  return from === to || leadJobTransitions[from].includes(to);
}

export function normalizeCnpj(input: string): NormalizedCnpj {
  return normalizedCnpjSchema.parse(input);
}

export {
  leadJobStatusSchema,
  leadSourceSchema,
  leadWhatsappStatusSchema,
  normalizedCnpjSchema,
  type LeadJobStatus,
  type LeadSource,
  type LeadWhatsappStatus,
  type NormalizedCnpj
};
