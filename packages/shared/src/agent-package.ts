import { z } from "zod";
import { aiAgentAllowedActionSchema } from "./domain.js";

export const agentPackageSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase slug with letters, numbers, and underscores.");

export const agentPackageVariableSchema = z.object({
  key: agentPackageSlugSchema,
  label: z.string().trim().min(1).max(120),
  required: z.boolean(),
  defaultValue: z.string().max(1000).optional()
});

export const agentKnowledgeTaxonomyEntrySchema = z.object({
  key: agentPackageSlugSchema,
  label: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(2).max(120)).max(80),
  requiresSource: z.boolean().default(false)
});

export const agentQualificationFieldSchema = z.object({
  key: agentPackageSlugSchema,
  label: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(500),
  valueType: z.enum(["text", "number", "boolean", "date", "choice", "list"]),
  requiredFor: z.array(agentPackageSlugSchema).max(20),
  acceptedInputs: z
    .array(z.enum(["text", "audio", "image", "document"]))
    .min(1),
  dependsOn: z.array(agentPackageSlugSchema).max(20),
  condition: z.string().trim().max(500).nullable(),
  confirmationRequired: z.boolean()
});

export const agentFollowupConfigSchema = z.object({
  timeZone: z.string().trim().min(1).max(80),
  businessDays: z.array(z.number().int().min(0).max(6)).min(1),
  businessHours: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  }),
  steps: z
    .array(
      z.object({
        afterBusinessMinutes: z.number().int().positive(),
        instruction: z.string().trim().min(1).max(1000)
      })
    )
    .max(10),
  closeAfterBusinessMinutes: z.number().int().min(0)
});

export const agentPackageKnowledgeSourceSchema = z.object({
  key: agentPackageSlugSchema,
  type: z.enum(["faq", "text", "file"]),
  title: z.string().trim().min(1).max(160),
  category: agentPackageSlugSchema,
  content: z.string().trim().min(1).max(500_000),
  approvalStatus: z.enum(["confirmed", "behavioral"]),
  source: z.string().trim().min(1).max(240),
  approvedBy: z.string().trim().min(1).max(160),
  approvedAt: z.string().datetime(),
  validUntil: z.string().datetime().nullable(),
  aliases: z.array(z.string().trim().min(2).max(120)).max(80)
});

export const agentPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("prymeira.agent-package"),
    metadata: z.object({
      key: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[a-z][a-z0-9-]*$/),
      name: z.string().trim().min(1).max(160),
      companyName: z.string().trim().min(1).max(160),
      industry: z.string().trim().min(1).max(120),
      language: z.string().trim().min(2).max(20),
      description: z.string().trim().min(1).max(1000)
    }),
    variables: z.array(agentPackageVariableSchema).max(100),
    agent: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).nullable(),
      systemPrompt: z.string().trim().min(10).max(8000),
      qualification: z.object({
        completionStage: agentPackageSlugSchema,
        fields: z.array(agentQualificationFieldSchema).max(100)
      }),
      knowledgeTaxonomy: z.array(agentKnowledgeTaxonomyEntrySchema).min(1).max(100),
      behavior: z.record(z.string(), z.unknown()),
      handoff: z.record(z.string(), z.unknown()),
      limits: z.record(z.string(), z.unknown()),
      followup: agentFollowupConfigSchema,
      allowedActions: z.array(aiAgentAllowedActionSchema).min(1)
    }),
    knowledge: z.array(agentPackageKnowledgeSourceSchema).max(200)
  })
  .superRefine((value, context) => {
    requireUnique(value.variables.map((item) => item.key), "variable keys", context);
    requireUnique(
      value.agent.qualification.fields.map((item) => item.key),
      "qualification field keys",
      context
    );
    requireUnique(
      value.agent.knowledgeTaxonomy.map((item) => item.key),
      "taxonomy keys",
      context
    );
    requireUnique(value.knowledge.map((item) => item.key), "knowledge keys", context);

    const fieldKeys = new Set(value.agent.qualification.fields.map((item) => item.key));
    for (const field of value.agent.qualification.fields) {
      for (const dependency of field.dependsOn) {
        if (!fieldKeys.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `Unknown qualification dependency: ${dependency}`
          });
        }
      }
    }

    const taxonomyKeys = new Set(value.agent.knowledgeTaxonomy.map((item) => item.key));
    for (const source of value.knowledge) {
      if (!taxonomyKeys.has(source.category)) {
        context.addIssue({
          code: "custom",
          message: `Unknown knowledge category: ${source.category}`
        });
      }
    }
  });

function requireUnique(values: string[], label: string, context: z.RefinementCtx) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `Duplicate ${label}.` });
  }
}

export type AgentPackage = z.infer<typeof agentPackageSchema>;
export type AgentKnowledgeTaxonomyEntry = z.infer<
  typeof agentKnowledgeTaxonomyEntrySchema
>;
export type AgentQualificationField = z.infer<typeof agentQualificationFieldSchema>;
