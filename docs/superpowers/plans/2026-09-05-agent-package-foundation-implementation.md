# Configurable Agent Package Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portable, validated agent-package format that can configure different businesses, import safely into a workspace, export for reuse, and drive custom knowledge taxonomies without hard-coded industry rules.

**Architecture:** Keep `AiAgent` as the current workspace-local runtime record and store the imported package configuration inside its existing JSON configuration fields during this foundation slice. Define the portable contract in the shared package, isolate import/export behavior in a new backend service, and make retrieval consume a package-defined taxonomy with the existing categories as a backward-compatible default. Versioned draft/publish storage, historical Villefer compilation, multimodal processing, negotiation memory, proposal follow-up, and batch evaluation remain separate implementation plans built on this contract.

**Tech Stack:** TypeScript, Zod, Fastify, Prisma, React, Vitest, pnpm.

---

## Scope boundaries and follow-on plans

This plan delivers one complete subsystem: a generic package can be validated, imported as an inactive agent, tested with the existing test chat, exported again, and use arbitrary business categories during knowledge retrieval.

Follow-on plans must remain separate:

1. Compile the anonymized Villefer histories into a reviewed Villefer V1 package and evaluation corpus.
2. Add immutable draft/published versions, approval metadata, comparison, publication, and rollback.
3. Add reusable audio, image, PDF, and document extraction plus structured qualification memory.
4. Add hybrid proposal detection, business-time scheduling, and contextual follow-up.
5. Add batch evaluation, shadow mode, supervised pilot controls, and rollout reporting.

## File map

**Create**

- `packages/shared/src/agent-package.ts` — portable package schemas and TypeScript types.
- `packages/shared/src/agent-package.test.ts` — contract, uniqueness, and invalid-package tests.
- `apps/api/src/modules/agents/knowledge-taxonomy.ts` — default taxonomy and safe parser for package-defined categories.
- `apps/api/src/modules/agents/knowledge-taxonomy.test.ts` — taxonomy normalization and fallback tests.
- `apps/api/src/modules/agents/agent-package.service.ts` — workspace-scoped import/export and variable rendering.
- `apps/api/src/modules/agents/agent-package.service.test.ts` — atomic import, export, isolation, and validation tests.
- `apps/api/src/modules/agents/agent-package.routes.ts` — validate, import, and export HTTP endpoints.
- `apps/api/src/modules/agents/agent-package.routes.test.ts` — permissions and request-validation tests.
- `apps/web/src/features/assistant/AgentPackagePanel.tsx` — JSON package import/export UI.
- `apps/web/src/features/assistant/AgentPackagePanel.test.tsx` — static rendering and file-validation tests.
- `docs/agent-packages.md` — user-facing package contract and operational rules.

**Modify**

- `packages/shared/src/index.ts` — export the package contract.
- `apps/api/src/modules/agents/knowledge-ingestion.ts` — accept validated custom category slugs.
- `apps/api/src/modules/agents/knowledge-ingestion.test.ts` — cover custom categories.
- `apps/api/src/modules/agents/knowledge-retrieval.ts` — score against the active taxonomy.
- `apps/api/src/modules/agents/knowledge-retrieval.test.ts` — cover non-default industries and required-source categories.
- `apps/api/src/modules/agents/agent-runtime.ts` — pass agent taxonomy into retrieval and document-dependency checks.
- `apps/api/src/modules/agents/agent-runtime.test.ts` — prove runtime uses custom taxonomy.
- `apps/api/src/app.ts` — register package routes.
- `apps/web/src/app/api.ts` — add package API DTO parsing and calls.
- `apps/web/src/features/assistant/AgentsPage.tsx` — mount package panel and accept custom category slugs.
- `apps/web/src/features/assistant/AgentsPage.test.tsx` — verify the new panel and category field.
- `README.md` — link the package documentation and verification command.

### Task 1: Define the portable agent-package contract

**Files:**

- Create: `packages/shared/src/agent-package.ts`
- Create: `packages/shared/src/agent-package.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing contract tests**

Create `packages/shared/src/agent-package.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentPackageSchema } from "./agent-package.js";

const validPackage = {
  schemaVersion: 1,
  kind: "prymeira.agent-package",
  metadata: {
    key: "example-sales-qualifier",
    name: "Example Sales Qualifier",
    companyName: "Example Company",
    industry: "b2b-sales",
    language: "pt-BR",
    description: "Qualifies inbound sales requests."
  },
  variables: [
    { key: "seller_name", label: "Nome do vendedor", required: true }
  ],
  agent: {
    name: "Agente comercial",
    description: "Qualifica e encaminha oportunidades.",
    systemPrompt: "Qualifique o contato e encaminhe para {{seller_name}}.",
    qualification: {
      completionStage: "proposal_handoff",
      fields: [
        {
          key: "city",
          label: "Cidade",
          question: "Qual é a cidade de atendimento?",
          valueType: "text",
          requiredFor: ["proposal_handoff"],
          acceptedInputs: ["text", "audio"],
          dependsOn: [],
          condition: null,
          confirmationRequired: true
        }
      ]
    },
    knowledgeTaxonomy: [
      {
        key: "service_area",
        label: "Área de atendimento",
        aliases: ["cidade", "região", "atende"],
        requiresSource: true
      }
    ],
    behavior: { tone: "consultivo", maxQuestionsPerMessage: 1 },
    handoff: { confidenceThreshold: 0.6, requiredFields: ["city"] },
    limits: { maxMessagesPerSession: 12 },
    followup: {
      timeZone: "America/Sao_Paulo",
      businessDays: [1, 2, 3, 4, 5],
      businessHours: { start: "08:00", end: "18:00" },
      steps: [],
      closeAfterBusinessMinutes: 0
    },
    allowedActions: ["send_message", "create_internal_note", "request_handoff"]
  },
  knowledge: [
    {
      key: "service_area",
      type: "faq",
      title: "Área de atendimento",
      category: "service_area",
      content: "Atendimento definido pela equipe comercial.",
      approvalStatus: "confirmed",
      source: "Manual comercial",
      approvedBy: "Responsável comercial",
      approvedAt: "2026-09-05T12:00:00.000Z",
      validUntil: null,
      aliases: ["região atendida"]
    }
  ]
} as const;

describe("agentPackageSchema", () => {
  it("accepts a portable package with custom fields and taxonomy", () => {
    const parsed = agentPackageSchema.parse(validPackage);
    expect(parsed.agent.qualification.fields[0]?.key).toBe("city");
    expect(parsed.agent.knowledgeTaxonomy[0]?.key).toBe("service_area");
  });

  it("rejects duplicate qualification keys", () => {
    expect(() =>
      agentPackageSchema.parse({
        ...validPackage,
        agent: {
          ...validPackage.agent,
          qualification: {
            ...validPackage.agent.qualification,
            fields: [
              validPackage.agent.qualification.fields[0],
              validPackage.agent.qualification.fields[0]
            ]
          }
        }
      })
    ).toThrow(/qualification field keys/i);
  });

  it("rejects knowledge categories absent from the package taxonomy", () => {
    expect(() =>
      agentPackageSchema.parse({
        ...validPackage,
        knowledge: [{ ...validPackage.knowledge[0], category: "unknown_category" }]
      })
    ).toThrow(/knowledge category/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run:

```bash
pnpm --filter @prymeira-talk/shared test -- agent-package.test.ts
```

Expected: FAIL because `agent-package.ts` does not exist.

- [ ] **Step 3: Implement the shared schemas**

Create `packages/shared/src/agent-package.ts` with the public schemas below. Keep the `superRefine` checks in this file so API and future offline compilers share the same validation.

```ts
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
  acceptedInputs: z.array(z.enum(["text", "audio", "image", "document"])).min(1),
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
  steps: z.array(
    z.object({
      afterBusinessMinutes: z.number().int().positive(),
      instruction: z.string().trim().min(1).max(1000)
    })
  ).max(10),
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
      key: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9-]*$/),
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
    requireUnique(value.agent.qualification.fields.map((item) => item.key), "qualification field keys", context);
    requireUnique(value.agent.knowledgeTaxonomy.map((item) => item.key), "taxonomy keys", context);
    requireUnique(value.knowledge.map((item) => item.key), "knowledge keys", context);

    const fieldKeys = new Set(value.agent.qualification.fields.map((item) => item.key));
    for (const field of value.agent.qualification.fields) {
      for (const dependency of field.dependsOn) {
        if (!fieldKeys.has(dependency)) {
          context.addIssue({ code: "custom", message: `Unknown qualification dependency: ${dependency}` });
        }
      }
    }

    const taxonomyKeys = new Set(value.agent.knowledgeTaxonomy.map((item) => item.key));
    for (const source of value.knowledge) {
      if (!taxonomyKeys.has(source.category)) {
        context.addIssue({ code: "custom", message: `Unknown knowledge category: ${source.category}` });
      }
    }
  });

function requireUnique(values: string[], label: string, context: z.RefinementCtx) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `Duplicate ${label}.` });
  }
}

export type AgentPackage = z.infer<typeof agentPackageSchema>;
export type AgentKnowledgeTaxonomyEntry = z.infer<typeof agentKnowledgeTaxonomyEntrySchema>;
export type AgentQualificationField = z.infer<typeof agentQualificationFieldSchema>;
```

Append this line to `packages/shared/src/index.ts`:

```ts
export * from "./agent-package.js";
```

- [ ] **Step 4: Run shared tests and typecheck**

Run:

```bash
pnpm --filter @prymeira-talk/shared test -- agent-package.test.ts
pnpm --filter @prymeira-talk/shared typecheck
```

Expected: PASS for the new tests and exit code 0 for typecheck.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/shared/src/agent-package.ts packages/shared/src/agent-package.test.ts packages/shared/src/index.ts
git commit -m "feat: define portable agent package contract"
```

### Task 2: Replace fixed categories with a configurable taxonomy

**Files:**

- Create: `apps/api/src/modules/agents/knowledge-taxonomy.ts`
- Create: `apps/api/src/modules/agents/knowledge-taxonomy.test.ts`
- Modify: `apps/api/src/modules/agents/knowledge-ingestion.ts`
- Modify: `apps/api/src/modules/agents/knowledge-ingestion.test.ts`
- Modify: `apps/api/src/modules/agents/knowledge-retrieval.ts`
- Modify: `apps/api/src/modules/agents/knowledge-retrieval.test.ts`

- [ ] **Step 1: Write failing taxonomy tests**

Create `apps/api/src/modules/agents/knowledge-taxonomy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readKnowledgeTaxonomy } from "./knowledge-taxonomy.js";

describe("readKnowledgeTaxonomy", () => {
  it("reads custom categories from agent behavior config", () => {
    const taxonomy = readKnowledgeTaxonomy({
      knowledgeTaxonomy: [
        { key: "materials", label: "Materiais", aliases: ["chapa", "aço"], requiresSource: true }
      ]
    });

    expect(taxonomy).toEqual([
      { key: "materials", label: "Materiais", aliases: ["chapa", "aço"], requiresSource: true }
    ]);
  });

  it("falls back to the legacy taxonomy for existing agents", () => {
    expect(readKnowledgeTaxonomy({}).map((item) => item.key)).toContain("precos");
  });
});
```

Add a failing retrieval test to `knowledge-retrieval.test.ts`:

```ts
it("selects a custom material source using package aliases", () => {
  const result = selectRelevantKnowledge({
    latestMessage: "Preciso de chapa galvanizada",
    conversationHistory: "",
    instruction: "",
    taxonomy: [
      { key: "materials", label: "Materiais", aliases: ["chapa", "galvanizada"], requiresSource: true }
    ],
    sources: [
      {
        id: "source-materials",
        title: "Materiais disponíveis",
        content: "Chapas galvanizadas sob consulta.",
        metadata: { category: "materials", keywords: ["chapa", "galvanizada"] }
      }
    ]
  });

  expect(result.selected[0]).toEqual(expect.objectContaining({ id: "source-materials", category: "materials" }));
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
pnpm --filter @prymeira-talk/api test -- knowledge-taxonomy.test.ts knowledge-retrieval.test.ts
```

Expected: FAIL because `knowledge-taxonomy.ts` and the `taxonomy` input do not exist.

- [ ] **Step 3: Implement taxonomy parsing with backward compatibility**

Create `knowledge-taxonomy.ts`:

```ts
import { agentKnowledgeTaxonomyEntrySchema, type AgentKnowledgeTaxonomyEntry } from "@prymeira-talk/shared";

export const DEFAULT_KNOWLEDGE_TAXONOMY: AgentKnowledgeTaxonomyEntry[] = [
  { key: "precos", label: "Preços", aliases: ["preço", "valor", "orçamento", "pagamento"], requiresSource: true },
  { key: "politicas", label: "Políticas", aliases: ["contrato", "cancelamento", "garantia", "prazo"], requiresSource: true },
  { key: "produto", label: "Produto", aliases: ["produto", "serviço", "funcionalidade", "integração"], requiresSource: false },
  { key: "onboarding", label: "Onboarding", aliases: ["começar", "configurar", "implantação", "treinamento"], requiresSource: false },
  { key: "faq", label: "FAQ", aliases: ["dúvida", "pergunta"], requiresSource: false },
  { key: "comercial", label: "Comercial", aliases: ["proposta", "vendedor", "condição"], requiresSource: false },
  { key: "suporte", label: "Suporte", aliases: ["erro", "problema", "ajuda"], requiresSource: false },
  { key: "outro", label: "Outro", aliases: ["informação"], requiresSource: false }
];

export function readKnowledgeTaxonomy(value: unknown): AgentKnowledgeTaxonomyEntry[] {
  if (!isRecord(value) || !Array.isArray(value.knowledgeTaxonomy)) {
    return DEFAULT_KNOWLEDGE_TAXONOMY;
  }

  const parsed = agentKnowledgeTaxonomyEntrySchema.array().safeParse(value.knowledgeTaxonomy);
  return parsed.success && parsed.data.length > 0 ? parsed.data : DEFAULT_KNOWLEDGE_TAXONOMY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Thread taxonomy through retrieval**

In `knowledge-retrieval.ts`:

```ts
import type { AgentKnowledgeTaxonomyEntry } from "@prymeira-talk/shared";
import { DEFAULT_KNOWLEDGE_TAXONOMY } from "./knowledge-taxonomy.js";

export function selectRelevantKnowledge(input: {
  latestMessage: string | null | undefined;
  conversationHistory: string | null | undefined;
  instruction: string | null | undefined;
  taxonomy?: AgentKnowledgeTaxonomyEntry[];
  sources: KnowledgeRetrievalSource[];
}): KnowledgeRetrievalResult {
  const taxonomy = input.taxonomy ?? DEFAULT_KNOWLEDGE_TAXONOMY;
  const primaryQuery = normalize([input.instruction, input.latestMessage].filter(Boolean).join("\n"));
  const historyQuery = normalize(input.conversationHistory ?? "");
  const primaryCategories = detectCategories(primaryQuery, taxonomy);
  const historyCategories = detectCategories(historyQuery, taxonomy);
  const retrievalQuery: RetrievalQuery = {
    primary: primaryQuery,
    history: historyQuery,
    primaryTokens: toTokenSet(primaryQuery),
    historyTokens: toTokenSet(historyQuery),
    primaryCategories,
    activeCategories: primaryCategories.size > 0 ? primaryCategories : historyCategories,
    taxonomy
  };

  const rankedSources = input.sources
    .map((source, index) => scoreSource(source, index, retrievalQuery))
    .filter((source): source is ScoredKnowledgeSource => source !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_SELECTED_SOURCES)
    .map(({ index: _index, ...source }) => source);

  return { selected: rankedSources, total: input.sources.length };
}

export function isDocumentDependentQuestion(
  value: string | null | undefined,
  taxonomy: AgentKnowledgeTaxonomyEntry[] = DEFAULT_KNOWLEDGE_TAXONOMY
) {
  const detected = detectCategories(normalize(value ?? ""), taxonomy);
  return taxonomy.some((entry) => entry.requiresSource && detected.has(entry.key));
}
```

Move category detection to accept `taxonomy` explicitly:

```ts
function detectCategories(query: string, taxonomy: AgentKnowledgeTaxonomyEntry[]) {
  const categories = new Set<string>();
  for (const entry of taxonomy) {
    if (entry.aliases.map(normalize).some((alias) => query.includes(alias))) {
      categories.add(entry.key);
    }
  }
  return categories;
}
```

Add `taxonomy: AgentKnowledgeTaxonomyEntry[]` to `RetrievalQuery`. In `scoreSource`, resolve the source entry once and use its aliases:

```ts
const taxonomyEntry = category
  ? query.taxonomy.find((entry) => entry.key === category)
  : undefined;

if (category && query.activeCategories.has(category)) {
  score += 50;
  reasons.add("category_match");
  for (const alias of taxonomyEntry?.aliases ?? []) {
    evidenceTerms.add(normalize(alias));
  }
}
```

Replace `hasTitleMatch` and `normalizeCategory` with:

```ts
function hasTitleMatch(
  title: string,
  queryTokens: Set<string>,
  detectedCategories: Set<string>,
  taxonomy: AgentKnowledgeTaxonomyEntry[]
) {
  const titleTokens = toTokenSet(title);
  const hasTokenMatch = Array.from(titleTokens).some((token) => queryTokens.has(token));
  const hasCategoryTitleMatch = taxonomy
    .filter((entry) => detectedCategories.has(entry.key))
    .some((entry) => entry.aliases.map(normalize).some((alias) => title.includes(alias)));
  return hasTokenMatch || hasCategoryTitleMatch;
}

function normalizeCategory(value: string | null, taxonomy: AgentKnowledgeTaxonomyEntry[]) {
  const normalized = normalize(value ?? "").replace(/[^a-z0-9]+/g, "_");
  const direct = taxonomy.find((entry) => entry.key === normalized);
  if (direct) return direct.key;

  const byAlias = taxonomy.find((entry) => entry.aliases.map(normalize).includes(normalize(value ?? "")));
  return byAlias?.key ?? (normalized || null);
}
```

Call `hasTitleMatch(title, query.primaryTokens, query.activeCategories, query.taxonomy)` and `normalizeCategory(metadata.category, query.taxonomy)` from `scoreSource`.

Update `scoreSource`, `hasTitleMatch`, and `normalizeCategory` to receive the same taxonomy map instead of reading the removed `CATEGORY_ALIASES` constant. Preserve the current score weights and source limit.

- [ ] **Step 5: Generalize uploaded category metadata**

In `knowledge-ingestion.ts`, replace the closed union with a validated string type:

```ts
export type KnowledgeCategory = string;

export function normalizeKnowledgeCategory(value: string) {
  const category = value.trim().toLocaleLowerCase("pt-BR");
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(category)) {
    throw new Error("A categoria de conhecimento é inválida.");
  }
  return category;
}
```

Set `metadata.category` to `normalizeKnowledgeCategory(input.category)`. Task 5 adds the exact error string to the route's known ingestion-error list when it opens the category endpoint.

- [ ] **Step 6: Run focused API tests**

```bash
pnpm --filter @prymeira-talk/api test -- knowledge-taxonomy.test.ts knowledge-retrieval.test.ts knowledge-ingestion.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit configurable taxonomy support**

```bash
git add apps/api/src/modules/agents/knowledge-taxonomy.ts apps/api/src/modules/agents/knowledge-taxonomy.test.ts apps/api/src/modules/agents/knowledge-ingestion.ts apps/api/src/modules/agents/knowledge-ingestion.test.ts apps/api/src/modules/agents/knowledge-retrieval.ts apps/api/src/modules/agents/knowledge-retrieval.test.ts
git commit -m "feat: support configurable agent knowledge taxonomy"
```

### Task 3: Make the runtime consume the package taxonomy

**Files:**

- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`
- Modify: `apps/api/src/modules/agents/agent-test-chat.ts`
- Modify: `apps/api/src/modules/agents/agent-test-chat.test.ts`

- [ ] **Step 1: Add failing runtime and test-chat assertions**

Add this test inside the existing `describe("createAgentRuntime")` block, reusing the file's `buildPrisma`, `buildProvider`, `baseAgent`, and `ids` fixtures:

```ts
behaviorConfig: {
  knowledgeTaxonomy: [
    { key: "materials", label: "Materiais", aliases: ["chapa"], requiresSource: true }
  ]
}
```

```ts
it("uses a custom package taxonomy in live retrieval", async () => {
  const provider = buildProvider({
    confidence: 0.9,
    reply: "Vou confirmar o material.",
    actions: [],
    handoff: { required: false, reason: null }
  });
  const prisma = buildPrisma({
    aiAgent: {
      findFirst: vi.fn().mockResolvedValue({
        ...baseAgent,
        behaviorConfig: {
          knowledgeTaxonomy: [
            { key: "materials", label: "Materiais", aliases: ["chapa"], requiresSource: true }
          ]
        }
      })
    },
    message: {
      findFirst: vi.fn().mockResolvedValue({ ...baseMessage, body: "Preciso de chapa" }),
      findMany: vi.fn().mockResolvedValue([{ ...baseMessage, body: "Preciso de chapa" }]),
      create: vi.fn().mockResolvedValue({ ...baseMessage, id: "outbound_custom", direction: "outbound" })
    },
    aiKnowledgeSource: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "materials_source",
          title: "Materiais",
          content: "Chapas disponíveis sob consulta.",
          metadata: { category: "materials", keywords: ["chapa"] },
          status: "ready"
        }
      ])
    }
  });

  const runtime = createAgentRuntime({ prisma, provider });
  await runtime.runForMessage({
    workspaceId: ids.workspace,
    agentId: ids.agent,
    conversationId: ids.conversation,
    messageId: ids.message,
    trigger: "automation"
  });

  expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
    context: expect.objectContaining({
      knowledge: [{ title: "Materiais", content: "Chapas disponíveis sob consulta." }]
    })
  }));
});
```

In `agent-test-chat.test.ts`, add the same `behaviorConfig.knowledgeTaxonomy` to a custom `aiAgent.findFirst` mock, return a `materials` source from `aiKnowledgeSource.findMany`, send `Preciso de chapa`, and assert `result.knowledgeMatches[0].category === "materials"`.

- [ ] **Step 2: Run focused tests and confirm the custom source is not selected**

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts agent-test-chat.test.ts
```

Expected: FAIL on the new custom taxonomy assertions.

- [ ] **Step 3: Pass taxonomy to both retrieval paths**

In both `agent-runtime.ts` and `agent-test-chat.ts`:

```ts
import { readKnowledgeTaxonomy } from "./knowledge-taxonomy.js";

const taxonomy = readKnowledgeTaxonomy(agent.behaviorConfig);
const knowledgeSelection = selectRelevantKnowledge({
  latestMessage: message.body,
  conversationHistory: conversationContext.formattedHistory,
  instruction: runInput.instruction,
  taxonomy,
  sources: knowledge.map(toRetrievalSource)
});
```

Use the same taxonomy for the document-dependent guard:

```ts
if (
  isDocumentDependentQuestion(
    `${message.body ?? ""}\n${conversationContext.formattedHistory}`,
    taxonomy
  ) && knowledgeSelection.selected.length === 0
) {
  providerOutput = createDocumentRequiredHandoffOutput();
}
```

Include `taxonomyKeys` in test debug output and `AiAgentRun.contextSummary` so selection remains auditable.

- [ ] **Step 4: Run the runtime tests**

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts agent-test-chat.test.ts knowledge-retrieval.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit runtime integration**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts apps/api/src/modules/agents/agent-test-chat.ts apps/api/src/modules/agents/agent-test-chat.test.ts
git commit -m "feat: apply agent taxonomy in runtime retrieval"
```

### Task 4: Implement atomic package import and workspace-scoped export

**Files:**

- Create: `apps/api/src/modules/agents/agent-package.service.ts`
- Create: `apps/api/src/modules/agents/agent-package.service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create a local `validPackage` by parsing the complete contract object used in Task 1 with `agentPackageSchema`, build a Prisma mock whose `$transaction` invokes the callback with mocked `aiAgent` and `aiKnowledgeSource` delegates, and add these exact behaviors:

```ts
it("imports a valid package as an inactive workspace agent", async () => {
  const created = await service.importPackage({
    workspaceId: "workspace_a",
    package: validPackage,
    variableValues: { seller_name: "Henry" }
  });

  expect(created.agent.status).toBe("inactive");
  expect(created.agent.systemPrompt).toContain("Henry");
  expect(created.knowledgeCount).toBe(1);
});

it("rejects missing required deployment variables before writing", async () => {
  await expect(service.importPackage({
    workspaceId: "workspace_a",
    package: validPackage,
    variableValues: {}
  })).rejects.toMatchObject({ code: "PACKAGE_VARIABLE_MISSING" });
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("exports only an agent from the requested workspace", async () => {
  await expect(service.exportPackage({
    workspaceId: "workspace_b",
    agentId
  })).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
});
```

Also assert that imported `behaviorConfig` contains `packageMetadata`, `qualification`, `knowledgeTaxonomy`, `followup`, and `deploymentVariables`, and that knowledge metadata contains approval and package provenance.

- [ ] **Step 2: Run service tests and confirm missing implementation**

```bash
pnpm --filter @prymeira-talk/api test -- agent-package.service.test.ts
```

Expected: FAIL because the service file does not exist.

- [ ] **Step 3: Implement variable resolution and errors**

Use these public shapes in `agent-package.service.ts`:

```ts
import { agentPackageSchema, type AgentPackage } from "@prymeira-talk/shared";

export class AgentPackageServiceError extends Error {
  constructor(
    public readonly code: "PACKAGE_INVALID" | "PACKAGE_VARIABLE_MISSING" | "AGENT_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "AgentPackageServiceError";
  }
}

function resolveVariables(agentPackage: AgentPackage, values: Record<string, string>) {
  const resolved: Record<string, string> = {};
  for (const variable of agentPackage.variables) {
    const value = values[variable.key]?.trim() || variable.defaultValue?.trim() || "";
    if (variable.required && !value) {
      throw new AgentPackageServiceError(
        "PACKAGE_VARIABLE_MISSING",
        `Missing required package variable: ${variable.key}`
      );
    }
    resolved[variable.key] = value;
  }
  return resolved;
}

function renderTemplate(value: string, variables: Record<string, string>) {
  return value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_match, key: string) => variables[key] ?? "");
}
```

- [ ] **Step 4: Implement the atomic import**

Expose `createAgentPackageService(prisma)` with `validatePackage`, `importPackage`, and `exportPackage`. Parse with `agentPackageSchema` before opening a transaction. The transaction must create:

```ts
const agent = await tx.aiAgent.create({
  data: {
    workspaceId,
    name: renderTemplate(agentPackage.agent.name, variables),
    description: agentPackage.agent.description,
    status: "inactive",
    providerMode: "prymeira_managed",
    provider: "simulated",
    model: "prymeira-simulated",
    systemPrompt: renderTemplate(agentPackage.agent.systemPrompt, variables),
    behaviorConfig: {
      ...agentPackage.agent.behavior,
      packageMetadata: agentPackage.metadata,
      packageVariables: agentPackage.variables,
      packageAgentNameTemplate: agentPackage.agent.name,
      packagePromptTemplate: agentPackage.agent.systemPrompt,
      qualification: agentPackage.agent.qualification,
      knowledgeTaxonomy: agentPackage.agent.knowledgeTaxonomy,
      followup: agentPackage.agent.followup,
      deploymentVariables: variables
    },
    handoffConfig: agentPackage.agent.handoff,
    limitsConfig: agentPackage.agent.limits,
    allowedActions: agentPackage.agent.allowedActions
  }
});
```

Create each knowledge source in the same transaction with rendered content and metadata:

```ts
metadata: {
  category: source.category,
  aliases: source.aliases,
  approvalStatus: source.approvalStatus,
  source: source.source,
  approvedBy: source.approvedBy,
  approvedAt: source.approvedAt,
  validUntil: source.validUntil,
  packageKey: agentPackage.metadata.key,
  packageSchemaVersion: agentPackage.schemaVersion,
  packageContentTemplate: source.content
}
```

Do not import allowed-tag IDs because IDs are workspace-local. The imported agent remains inactive until a manager maps tags and tests it.

- [ ] **Step 5: Implement export without personal data**

`exportPackage` must query `{ workspaceId, id: agentId }`, load only the agent and its knowledge sources, and reconstruct the package from stored config. It must not query conversations, contacts, runs, notes, sessions, messages, or assignments. Reconstruct `variables`, agent name, system prompt, and knowledge content from `packageVariables`, `packageAgentNameTemplate`, `packagePromptTemplate`, and `packageContentTemplate`; never export `deploymentVariables` values. For an agent created manually rather than imported, export `variables: []` and use its current name, prompt, and source content.

- [ ] **Step 6: Run package service tests**

```bash
pnpm --filter @prymeira-talk/api test -- agent-package.service.test.ts
```

Expected: PASS, including the transaction and workspace-isolation assertions.

- [ ] **Step 7: Commit package service**

```bash
git add apps/api/src/modules/agents/agent-package.service.ts apps/api/src/modules/agents/agent-package.service.test.ts
git commit -m "feat: import and export agent packages"
```

### Task 5: Add package validation, import, and export routes

**Files:**

- Create: `apps/api/src/modules/agents/agent-package.routes.ts`
- Create: `apps/api/src/modules/agents/agent-package.routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/agents/agents.routes.ts`

- [ ] **Step 1: Write failing route tests**

Create a Fastify test app that decorates `prisma`, assigns `request.talk = { workspaceId, role }` in a hook, and registers `agentPackageRoutes`. Test:

```ts
expect((await ownerApp.inject({
  method: "POST",
  url: "/agent-packages/validate",
  payload: { package: validPackage }
})).statusCode).toBe(200);

expect((await agentRoleApp.inject({
  method: "POST",
  url: "/agent-packages/import",
  payload: { package: validPackage, variableValues: { seller_name: "Henry" } }
})).statusCode).toBe(403);

expect((await ownerApp.inject({
  method: "POST",
  url: "/agent-packages/import",
  payload: { package: { schemaVersion: 99 }, variableValues: {} }
})).statusCode).toBe(400);
```

- [ ] **Step 2: Run the route tests and confirm missing route failure**

```bash
pnpm --filter @prymeira-talk/api test -- agent-package.routes.test.ts
```

Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Implement route schemas and handlers**

Create routes:

```ts
POST /agent-packages/validate
POST /agent-packages/import
GET  /agents/:agentId/package
```

Use `z.record(z.string(), z.string().max(1000)).default({})` for `variableValues`, `agentPackageSchema` for the package body, and the same `automation.manage` permission used by agent editing. Map:

- `PACKAGE_INVALID` and `PACKAGE_VARIABLE_MISSING` to 400;
- `AGENT_NOT_FOUND` to 404;
- unauthorized management to 403.

Return `{ valid: true, metadata, requiredVariables }` from validation, `{ agent, knowledgeCount }` with status 201 from import, and a package JSON object from export.

- [ ] **Step 4: Register routes and extend upload error handling**

In `app.ts`:

```ts
import { agentPackageRoutes } from "./modules/agents/agent-package.routes.js";
// ...
await app.register(agentPackageRoutes);
```

In `agents.routes.ts`, add `"A categoria de conhecimento é inválida."` to `isKnowledgeUploadError` and change the closed category enum to:

```ts
const knowledgeCategorySchema = z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/);
```

- [ ] **Step 5: Run route and existing agent tests**

```bash
pnpm --filter @prymeira-talk/api test -- agent-package.routes.test.ts agents.service.test.ts knowledge-ingestion.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit HTTP endpoints**

```bash
git add apps/api/src/modules/agents/agent-package.routes.ts apps/api/src/modules/agents/agent-package.routes.test.ts apps/api/src/modules/agents/agents.routes.ts apps/api/src/app.ts
git commit -m "feat: expose agent package management API"
```

### Task 6: Add package controls and custom categories to the Agents UI

**Files:**

- Create: `apps/web/src/features/assistant/AgentPackagePanel.tsx`
- Create: `apps/web/src/features/assistant/AgentPackagePanel.test.tsx`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/assistant/AgentsPage.tsx`
- Modify: `apps/web/src/features/assistant/AgentsPage.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing UI tests**

Export two pure helpers from `AgentPackagePanel.tsx` and test their behavior before testing the rendered controls:

```ts
export function parseAgentPackageText(value: string) {
  return agentPackageSchema.parse(JSON.parse(value));
}

export function hasRequiredPackageVariables(
  variables: AgentPackage["variables"],
  values: Record<string, string>
) {
  return variables.every((variable) =>
    !variable.required || Boolean(values[variable.key]?.trim() || variable.defaultValue?.trim())
  );
}
```

Create `AgentPackagePanel.test.tsx` with:

```ts
import { describe, expect, it } from "vitest";
import { hasRequiredPackageVariables, parseAgentPackageText } from "./AgentPackagePanel";

describe("AgentPackagePanel helpers", () => {
  it("rejects malformed package JSON", () => {
    expect(() => parseAgentPackageText("{not-json")).toThrow();
  });

  it("requires deployment values without defaults", () => {
    const variables = [
      { key: "seller_name", label: "Vendedor", required: true }
    ];
    expect(hasRequiredPackageVariables(variables, {})).toBe(false);
    expect(hasRequiredPackageVariables(variables, { seller_name: "Henry" })).toBe(true);
  });
});
```

Add a static-render test asserting the panel contains `Importar pacote`, `Exportar pacote`, and a file input with `accept="application/json,.json"`. Add an `AgentsPage` assertion that the category field is an input with a datalist and accepts `materials`, not only the legacy suggestions.

Add an `AgentsPage` assertion that the knowledge category control accepts `materials`, not only the legacy list.

- [ ] **Step 2: Run focused web tests and confirm failure**

```bash
pnpm --filter @prymeira-talk/web test -- AgentPackagePanel.test.tsx AgentsPage.test.tsx
```

Expected: FAIL because the panel and custom category control do not exist.

- [ ] **Step 3: Add typed web API functions**

In `apps/web/src/app/api.ts`, import `agentPackageSchema` and `AgentPackage`, then add:

```ts
export async function apiValidateAgentPackage(
  getToken: () => Promise<string | null>,
  agentPackage: AgentPackage
) {
  return fetchJson(
    getToken,
    "/agent-packages/validate",
    { method: "POST", body: JSON.stringify({ package: agentPackage }) },
    (data) => data as { valid: true; metadata: AgentPackage["metadata"]; requiredVariables: AgentPackage["variables"] },
    "Failed to validate agent package"
  );
}

export async function apiImportAgentPackage(
  getToken: () => Promise<string | null>,
  agentPackage: AgentPackage,
  variableValues: Record<string, string>
) {
  return fetchJson(
    getToken,
    "/agent-packages/import",
    { method: "POST", body: JSON.stringify({ package: agentPackage, variableValues }) },
    (data) => data as { agent: AiAgentDto; knowledgeCount: number },
    "Failed to import agent package"
  );
}

export async function apiExportAgentPackage(
  getToken: () => Promise<string | null>,
  agentId: string
): Promise<AgentPackage> {
  return fetchJson(
    getToken,
    `/agents/${agentId}/package`,
    {},
    (data) => agentPackageSchema.parse(data),
    "Failed to export agent package"
  );
}
```

- [ ] **Step 4: Build the isolated package panel**

`AgentPackagePanel.tsx` receives:

```ts
type AgentPackagePanelProps = {
  selectedAgentId: string | null;
  getToken: () => Promise<string | null>;
  onImported: (agent: AiAgentDto) => void;
};
```

The panel must:

1. read a `.json` file as text;
2. parse locally with `agentPackageSchema`;
3. call validation and show package name/company;
4. render one input per required variable;
5. import only after all required values exist;
6. call `onImported` with the inactive agent;
7. export the selected agent using a Blob named `<package-key>.json`;
8. never log package content to the browser console.

- [ ] **Step 5: Mount the panel and generalize the category field**

Mount `<AgentPackagePanel>` below the agent list and above the editor. Replace the fixed category `<select>` with an `<input list="knowledge-category-suggestions">` plus a datalist containing the existing suggestions. Normalize the value on submit:

```ts
const category = knowledgeUploadForm.category
  .trim()
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toLocaleLowerCase("pt-BR")
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");
```

Reject an empty result in the UI before uploading.

- [ ] **Step 6: Add styles without changing unrelated panels**

Add scoped classes `.agent-package-panel`, `.agent-package-summary`, `.agent-package-variable-grid`, and `.agent-package-error`. Reuse the existing `.module-panel`, `.form-field`, `.primary-button`, and `.secondary-button` tokens.

- [ ] **Step 7: Run web tests and typecheck**

```bash
pnpm --filter @prymeira-talk/web test -- AgentPackagePanel.test.tsx AgentsPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
```

Expected: PASS and exit code 0.

- [ ] **Step 8: Commit the UI**

```bash
git add apps/web/src/app/api.ts apps/web/src/features/assistant/AgentPackagePanel.tsx apps/web/src/features/assistant/AgentPackagePanel.test.tsx apps/web/src/features/assistant/AgentsPage.tsx apps/web/src/features/assistant/AgentsPage.test.tsx apps/web/src/styles.css
git commit -m "feat: manage portable agent packages in UI"
```

### Task 7: Document and verify the foundation end to end

**Files:**

- Create: `docs/agent-packages.md`
- Modify: `README.md`

- [ ] **Step 1: Write the package documentation**

Document:

- package sections and schema versioning;
- the difference between prompt, knowledge, qualification, and deployment variables;
- accepted category slug format;
- why imports always create inactive agents;
- why tag IDs and personal customer data are excluded;
- how to validate, import, test, map tags, activate, and export;
- the exact requirement that only `confirmed` and `behavioral` sources are accepted;
- the later migration path to immutable published versions.

Add to `README.md`:

```markdown
## Agent packages

Portable agent configuration, validation, import, and export are documented in [`docs/agent-packages.md`](docs/agent-packages.md). Imported agents are always inactive until their workspace-specific tags and test behavior are reviewed.
```

- [ ] **Step 2: Run the complete verification suite**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all package, API, and web tests pass; typecheck and build exit with code 0.

- [ ] **Step 3: Run a manual smoke test**

```bash
pnpm demo:reset
pnpm demo:prymeira
```

Open `http://localhost:5176`, then verify:

1. Agentes accepts a valid package JSON.
2. Required deployment variables appear.
3. Import creates an inactive agent.
4. The imported custom taxonomy is visible in exported JSON.
5. A custom knowledge category can be uploaded.
6. Test chat retrieves the custom-category source.
7. Exported JSON parses again with `agentPackageSchema`.
8. Another workspace cannot export the imported agent.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/agent-packages.md README.md
git commit -m "docs: explain configurable agent packages"
```

## Completion checklist

- [ ] A package for an arbitrary industry validates through one shared contract.
- [ ] Duplicate fields, categories, and knowledge keys fail before writes.
- [ ] Import is atomic and always creates an inactive agent.
- [ ] Import and export remain scoped to the authenticated workspace.
- [ ] Export contains no conversations, contacts, phone numbers, runs, or notes.
- [ ] Custom taxonomy drives both live runtime and test-chat retrieval.
- [ ] Existing agents retain the default taxonomy without migration.
- [ ] The UI accepts package JSON and custom category slugs.
- [ ] Full tests, typecheck, build, and manual smoke verification pass.
