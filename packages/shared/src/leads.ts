import { z } from "zod";

const cnpjSeparatorPattern = /[.\-/\s]/g;
const normalizedCnpjPattern = /^[0-9A-Z]{12}[0-9]{2}$/;

export const uuidSchema = z.string().uuid();

export const leadSourceSchema = z.enum(["google_maps", "receita_federal"]);
export type LeadSource = z.infer<typeof leadSourceSchema>;

export const leadJobStatusSchema = z.enum(["queued", "running", "completed", "partial", "failed"]);
export type LeadJobStatus = z.infer<typeof leadJobStatusSchema>;

export const leadWhatsappStatusSchema = z.enum([
  "unverified",
  "checking",
  "available",
  "unavailable",
  "failed"
]);
export type LeadWhatsappStatus = z.infer<typeof leadWhatsappStatusSchema>;

/**
 * CNPJ values are identifiers, never numbers. The Receita Federal allows
 * alphanumeric values in the base and order positions, while the two final
 * check-digit positions remain numeric.
 */
export const normalizedCnpjSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(cnpjSeparatorPattern, "").toUpperCase())
  .refine((value) => normalizedCnpjPattern.test(value), {
    message: "CNPJ must contain 12 alphanumeric characters followed by two digits."
  });
export type NormalizedCnpj = z.infer<typeof normalizedCnpjSchema>;

export const leadSearchFiltersSchema = z
  .object({
    source: leadSourceSchema.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    cnpj: normalizedCnpjSchema.optional(),
    city: z.string().trim().min(1).max(120).optional(),
    state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
    activity: z.string().trim().min(1).max(200).optional(),
    cnae: z.string().trim().min(1).max(20).optional(),
    companySize: z.string().trim().min(1).max(80).optional(),
    active: z.boolean().optional(),
    openedFrom: z.string().date().optional(),
    openedTo: z.string().date().optional(),
    capitalMin: z.coerce.number().nonnegative().optional(),
    capitalMax: z.coerce.number().nonnegative().optional(),
    hasPhone: z.boolean().optional(),
    hasEmail: z.boolean().optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(25)
  })
  .superRefine((filters, context) => {
    if (filters.openedFrom && filters.openedTo && filters.openedFrom > filters.openedTo) {
      context.addIssue({
        code: "custom",
        path: ["openedTo"],
        message: "openedTo must be on or after openedFrom."
      });
    }

    if (
      filters.capitalMin !== undefined &&
      filters.capitalMax !== undefined &&
      filters.capitalMin > filters.capitalMax
    ) {
      context.addIssue({
        code: "custom",
        path: ["capitalMax"],
        message: "capitalMax must be greater than or equal to capitalMin."
      });
    }
  });
export type LeadSearchFilters = z.infer<typeof leadSearchFiltersSchema>;

export const leadGoogleSearchRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  niche: z.string().trim().min(1).max(160),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  idempotencyKey: z.string().trim().min(1).max(200),
  maxTimeSeconds: z.coerce.number().int().min(180).max(900).default(600)
});
export type LeadGoogleSearchRequest = z.infer<typeof leadGoogleSearchRequestSchema>;

export const leadReceitaSearchRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  filters: leadSearchFiltersSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  maxResults: z.number().int().positive().max(5000).default(5000)
});

export const leadReceitaLookupQuerySchema = z.object({
  cnpj: normalizedCnpjSchema.optional(),
  companyName: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
}).refine((value) => Boolean(value.cnpj) !== Boolean(value.companyName), {
  message: "Provide either cnpj or companyName."
});

export const leadReceitaLookupResponseSchema = z.object({
  items: z.array(z.object({
    cnpj: normalizedCnpjSchema,
    companyName: z.string().nullable(),
    tradeName: z.string().nullable()
  }).passthrough()),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative()
});

export const leadCsvUploadRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  fileName: z.string().trim().min(1).max(180),
  csvBase64: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).max(200)
});

export const leadSimilarQuerySchema = z.object({
  seedCnpj: normalizedCnpjSchema.optional(),
  listId: uuidSchema.optional(),
  leadId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
}).refine((value) => Boolean(value.seedCnpj) !== Boolean(value.listId && value.leadId) &&
  Boolean(value.listId) === Boolean(value.leadId), { message: "Provide either seedCnpj or listId and leadId." });

export const leadSimilarSaveRequestSchema = z.object({
  seedCnpj: normalizedCnpjSchema.optional(),
  listId: uuidSchema.optional(),
  leadId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(160),
  selectedCnpjs: z.array(normalizedCnpjSchema).min(1).max(100)
    .refine((values) => new Set(values).size === values.length, "selectedCnpjs must be unique."),
  idempotencyKey: z.string().trim().min(1).max(200)
}).refine((value) => Boolean(value.seedCnpj) !== Boolean(value.listId && value.leadId) &&
  Boolean(value.listId) === Boolean(value.leadId), { message: "Provide either seedCnpj or listId and leadId." });

export const leadListSchema = z.object({
  id: uuidSchema,
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  source: leadSourceSchema,
  criteria: z.unknown(),
  totalCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type LeadListDto = z.infer<typeof leadListSchema>;

export const leadResultSchema = z.object({
  id: uuidSchema,
  workspaceId: z.string().min(1),
  listId: uuidSchema,
  source: leadSourceSchema,
  companyName: z.string().nullable(),
  tradeName: z.string().nullable(),
  cnpj: normalizedCnpjSchema.nullable(),
  cnaePrimary: z.string().nullable(),
  cnaeSecondary: z.array(z.string()),
  category: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  phones: z.array(z.string()),
  normalizedPhone: z.string().nullable(),
  email: z.string().email().nullable(),
  website: z.string().url().nullable(),
  rating: z.number().finite().nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
  sourceUrl: z.string().url().nullable(),
  whatsappStatus: leadWhatsappStatusSchema,
  whatsappVerifications: z.array(z.object({
    normalizedPhone: z.string().min(1),
    status: leadWhatsappStatusSchema,
    checkedAt: z.string().datetime().nullable(),
    errorMessage: z.string().nullable()
  })),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type LeadResultDto = z.infer<typeof leadResultSchema>;

export const leadPaginatedResultSchema = z.object({
  items: z.array(leadResultSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative()
});
export type LeadPaginatedResultDto = z.infer<typeof leadPaginatedResultSchema>;

export const leadJobSchema = z.object({
  id: uuidSchema,
  workspaceId: z.string().min(1),
  listId: uuidSchema,
  operation: z.string().min(1),
  status: leadJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  leaseUntil: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type LeadJobDto = z.infer<typeof leadJobSchema>;

export const leadGoogleSearchResponseSchema = z.object({
  list: leadListSchema,
  job: leadJobSchema,
  replayed: z.boolean()
});
export type LeadGoogleSearchResponse = z.infer<typeof leadGoogleSearchResponseSchema>;

export const leadGoogleRetryResponseSchema = z.object({
  list: leadListSchema,
  job: leadJobSchema
});
export type LeadGoogleRetryResponse = z.infer<typeof leadGoogleRetryResponseSchema>;

export const leadJobIdempotencyScopeSchema = z.object({
  workspaceId: z.string().min(1),
  operation: z.string().min(1),
  idempotencyKey: z.string().min(1)
});
export type LeadJobIdempotencyScope = z.infer<typeof leadJobIdempotencyScopeSchema>;

export const leadCsvImportResponseSchema = z.object({
  listId: uuidSchema,
  jobId: uuidSchema,
  acceptedRows: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  invalidRows: z.number().int().nonnegative(),
  errorCsvUrl: z.string().url().nullable()
});
export type LeadCsvImportResponseDto = z.infer<typeof leadCsvImportResponseSchema>;

export const similarCompanyReasonKeySchema = z.enum([
  "activity_primary_cnae_exact",
  "activity_reciprocal_primary_secondary",
  "activity_cnae_group",
  "location_same_city",
  "location_same_state",
  "location_distance_25km",
  "location_distance_100km",
  "location_distance_250km",
  "profile_same_size",
  "profile_same_legal_nature",
  "profile_same_simples",
  "profile_comparable_capital",
  "profile_comparable_age",
  "commercial_active",
  "commercial_usable_address",
  "commercial_phone",
  "commercial_email"
]);
export type SimilarCompanyReasonKey = z.infer<typeof similarCompanyReasonKeySchema>;

export const similarCompanyScoreReasonSchema = z.object({
  key: similarCompanyReasonKeySchema,
  label: z.string().min(1),
  points: z.number().int().positive()
});
export type SimilarCompanyScoreReason = z.infer<typeof similarCompanyScoreReasonSchema>;

export const similarCompanyScoreComponentSchema = z.object({
  key: z.enum(["activity", "location", "profile", "commercial_readiness"]),
  weight: z.number().int().positive(),
  score: z.number().min(0).max(100),
  reasons: z.array(similarCompanyScoreReasonSchema)
});
export type SimilarCompanyScoreComponent = z.infer<typeof similarCompanyScoreComponentSchema>;

export const similarCompanyScoreExplanationSchema = z.object({
  score: z.number().min(0).max(100),
  components: z.array(similarCompanyScoreComponentSchema),
  reasons: z.array(similarCompanyScoreReasonSchema)
});
export type SimilarCompanyScoreExplanation = z.infer<typeof similarCompanyScoreExplanationSchema>;

export const similarCompanyResultSchema = z.object({
  cnpj: normalizedCnpjSchema,
  companyName: z.string().nullable(),
  tradeName: z.string().nullable(),
  cnaePrimary: z.string().nullable(),
  cnaeSecondary: z.array(z.string()),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  ...similarCompanyScoreExplanationSchema.shape
});
export type SimilarCompanyResult = z.infer<typeof similarCompanyResultSchema>;

export const similarCompanySearchResultSchema = z.object({
  scoringVersion: z.literal("cnpj-similarity-v1"),
  seed: z.object({
    cnpj: normalizedCnpjSchema,
    companyName: z.string().nullable(),
    tradeName: z.string().nullable()
  }),
  items: z.array(similarCompanyResultSchema)
});
export type SimilarCompanySearchResult = z.infer<typeof similarCompanySearchResultSchema>;

export const MAX_LEAD_WHATSAPP_BATCH_SIZE = 25;
export const MAX_LEAD_WHATSAPP_SELECTION_SIZE = 250;
export const MAX_LEAD_WHATSAPP_UNIQUE_NUMBERS = 250;

export const leadWhatsappVerificationRequestSchema = z.object({
  listId: uuidSchema,
  leadIds: z
    .array(uuidSchema)
    .min(1)
    .max(MAX_LEAD_WHATSAPP_SELECTION_SIZE)
    .refine(
      (leadIds) =>
        new Set(leadIds.map((leadId) => leadId.toLowerCase())).size === leadIds.length,
      { message: "leadIds must not contain duplicates." }
    ),
  idempotencyKey: z.string().trim().min(1).max(200)
});
export type LeadWhatsappVerificationRequest = z.infer<typeof leadWhatsappVerificationRequestSchema>;

export const leadWhatsappVerificationResultSchema = z.object({
  leadId: uuidSchema,
  normalizedPhone: z.string().min(1),
  status: leadWhatsappStatusSchema,
  checkedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable()
});
export type LeadWhatsappVerificationResult = z.infer<typeof leadWhatsappVerificationResultSchema>;

export const leadWhatsappVerificationResponseSchema = z.object({
  requestId: uuidSchema,
  jobs: z.array(leadJobSchema).min(1),
  requestedCount: z.number().int().positive(),
  verifications: z.array(leadWhatsappVerificationResultSchema)
});
export type LeadWhatsappVerificationResponse = z.infer<typeof leadWhatsappVerificationResponseSchema>;

export const leadWhatsappRetryResponseSchema = z.object({
  job: leadJobSchema,
  verifications: z.array(leadWhatsappVerificationResultSchema)
});
export type LeadWhatsappRetryResponse = z.infer<typeof leadWhatsappRetryResponseSchema>;

export const leadContactSourceTagSummarySchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1)
});
export type LeadContactSourceTagSummary = z.infer<typeof leadContactSourceTagSummarySchema>;

export const leadContactProvenanceSummarySchema = z.object({
  id: uuidSchema,
  source: leadSourceSchema,
  listId: uuidSchema,
  importedAt: z.string().datetime(),
  whatsappStatus: leadWhatsappStatusSchema,
  suggestedMessage: z.string().nullable()
});
export type LeadContactProvenanceSummary = z.infer<typeof leadContactProvenanceSummarySchema>;

export const leadContactImportItemSchema = z.object({
  leadId: uuidSchema,
  contactId: uuidSchema.nullable(),
  provenanceId: uuidSchema.nullable(),
  phone: z.string().min(1).nullable(),
  status: z.enum(["created", "reconciled", "skipped"]),
  reason: z.enum(["missing_valid_phone"]).nullable(),
  sourceTag: leadContactSourceTagSummarySchema.nullable(),
  provenance: leadContactProvenanceSummarySchema.nullable()
});
export type LeadContactImportItem = z.infer<typeof leadContactImportItemSchema>;

export const leadContactImportRequestSchema = z.object({
  selectedLeadIds: z
    .array(uuidSchema)
    .min(1)
    .max(5000)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: "selectedLeadIds must not contain duplicates."
    })
});
export type LeadContactImportRequest = z.infer<typeof leadContactImportRequestSchema>;

export const leadContactImportResultSchema = z.object({
  requestedCount: z.number().int().positive(),
  importedCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  reconciledCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  contacts: z.array(leadContactImportItemSchema)
});
export type LeadContactImportResult = z.infer<typeof leadContactImportResultSchema>;

export const leadComposerDraftSchema = z.object({
  body: z.string().min(1),
  provenanceId: uuidSchema
});
export type LeadComposerDraft = z.infer<typeof leadComposerDraftSchema>;

export const leadCampaignDraftRequestSchema = z
  .object({
    selectedLeadIds: z
      .array(uuidSchema)
      .min(1)
      .max(5000)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
        message: "selectedLeadIds must not contain duplicates."
      }),
    originalSelectedLeadIds: z.array(uuidSchema).min(1).max(5000).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    messageBody: z.string().trim().min(1).max(2000).optional(),
    quickReplyId: uuidSchema.optional()
  })
  .refine((value) => !(value.messageBody && value.quickReplyId), {
    message: "Choose either messageBody or quickReplyId, not both."
  });
export type LeadCampaignDraftRequest = z.infer<typeof leadCampaignDraftRequestSchema>;

export const leadCampaignDraftResultSchema = z.object({
  campaignId: uuidSchema,
  status: z.literal("draft"),
  contactCount: z.number().int().positive()
});
export type LeadCampaignDraftResult = z.infer<typeof leadCampaignDraftResultSchema>;
