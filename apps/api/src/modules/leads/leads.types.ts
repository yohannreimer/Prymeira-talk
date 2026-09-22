import {
  MAX_LEAD_WHATSAPP_BATCH_SIZE as sharedMaxLeadWhatsappBatchSize,
  MAX_LEAD_WHATSAPP_SELECTION_SIZE as sharedMaxLeadWhatsappSelectionSize,
  MAX_LEAD_WHATSAPP_UNIQUE_NUMBERS as sharedMaxLeadWhatsappUniqueNumbers,
  leadJobIdempotencyScopeSchema,
  leadJobStatusSchema,
  leadSourceSchema,
  leadWhatsappStatusSchema,
  normalizedCnpjSchema,
  type LeadJobStatus,
  type LeadJobIdempotencyScope,
  type LeadSource,
  type LeadWhatsappStatus,
  type NormalizedCnpj
} from "@prymeira-talk/shared";

export const MAX_LEAD_WHATSAPP_BATCH_SIZE = sharedMaxLeadWhatsappBatchSize;
export const MAX_LEAD_WHATSAPP_SELECTION_SIZE = sharedMaxLeadWhatsappSelectionSize;
export const MAX_LEAD_WHATSAPP_UNIQUE_NUMBERS = sharedMaxLeadWhatsappUniqueNumbers;

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

export function hasLeadJobIdempotencyConflict(
  first: LeadJobIdempotencyScope,
  second: LeadJobIdempotencyScope
) {
  return (
    first.workspaceId === second.workspaceId &&
    first.operation === second.operation &&
    first.idempotencyKey === second.idempotencyKey
  );
}

export function normalizeCnpj(input: string): NormalizedCnpj {
  return normalizedCnpjSchema.parse(input);
}

export {
  leadJobIdempotencyScopeSchema,
  leadJobStatusSchema,
  leadSourceSchema,
  leadWhatsappStatusSchema,
  normalizedCnpjSchema,
  type LeadJobStatus,
  type LeadJobIdempotencyScope,
  type LeadSource,
  type LeadWhatsappStatus,
  type NormalizedCnpj
};
