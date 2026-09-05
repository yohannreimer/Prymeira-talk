import { createHash } from "node:crypto";
import { agentPackageSchema, type AgentPackage } from "@prymeira-talk/shared";
import { z } from "zod";

const historyMessageSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  participant: z.string().nullable().optional(),
  fromMe: z.boolean(),
  timestamp: z.string().datetime(),
  timestampMs: z.number().finite(),
  messageType: z.string().min(1),
  text: z.string().nullable(),
  pushName: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  hasMedia: z.boolean(),
  raw: z.record(z.string(), z.unknown()).optional()
});

const historySchema = z.object({
  instance: z.string().trim().min(1),
  window: z.object({
    start: z.string().datetime(),
    endExclusive: z.string().datetime()
  }),
  messages: z.array(historyMessageSchema)
});

const baselineConversationSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  contactName: z.string().nullable().optional(),
  maskedContact: z.string().nullable().optional(),
  viewerId: z.string().nullable().optional(),
  classification: z.string().min(1)
});

const baselineSchema = z.object({
  instance: z.string().trim().min(1),
  sourceMessages: z.number().int().nonnegative(),
  individualChats: z.number().int().nonnegative(),
  conversationSegments: z.number().int().nonnegative(),
  classificationCounts: z.record(z.string(), z.number().int().nonnegative()),
  questionCategories: z.record(z.string(), z.number().int().nonnegative()),
  conversations: z.array(baselineConversationSchema)
});

export const historicalEvaluationCaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().trim().min(1).max(180),
  category: z.string().trim().min(1).max(80),
  conversation: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "seller", "system_event"]),
        content: z.string().trim().min(1).max(4000),
        inputType: z.enum(["text", "audio", "image", "document", "event"]).default("text")
      })
    )
    .min(1)
    .max(30),
  expected: z.object({
    stage: z.string().trim().min(1).max(80),
    capturedFields: z.array(z.string().trim().min(1).max(80)).max(40),
    missingFields: z.array(z.string().trim().min(1).max(80)).max(40),
    nextAction: z.enum([
      "ask_next_field",
      "confirm_request",
      "handoff",
      "answer_from_approved_source",
      "wait_for_seller",
      "followup",
      "stop"
    ]),
    handoffExpected: z.boolean(),
    responseGuidance: z.string().trim().min(1).max(2000),
    forbiddenClaims: z.array(z.string().trim().min(1).max(500)).min(1).max(30)
  }),
  evidence: z.object({
    basis: z.enum(["historical_pattern", "approved_rule", "safety_rule"]),
    relatedSignals: z.array(z.string().trim().min(1).max(80)).min(1).max(20)
  })
});

export const historicalEvaluationSuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    packageKey: z.string().trim().min(1).max(120),
    generatedAt: z.string().datetime(),
    methodology: z.string().trim().min(1).max(2000),
    cases: z.array(historicalEvaluationCaseSchema).max(200)
  })
  .superRefine((suite, context) => {
    const ids = suite.cases.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Duplicate evaluation case ids." });
    }
  });

export type HistoricalEvaluationSuite = z.infer<typeof historicalEvaluationSuiteSchema>;

export type HistoricalTrainingDefinition = {
  compilerVersion: string;
  generatedAt: string;
  minimumInstances: number;
  package: AgentPackage;
  evaluationSuite: HistoricalEvaluationSuite;
  approvedDecisions: string[];
  needsValidation: string[];
  behavioralFindings: string[];
};

export type HistoricalTrainingInput = {
  history: unknown;
  baseline: unknown;
};

type InstanceEvidence = {
  instance: string;
  window: { start: string; endExclusive: string };
  sourceMessages: number;
  individualChats: number;
  conversationSegments: number;
  commercialJourneys: number;
  commercialContacts: number;
  inboundMessages: number;
  outboundMessages: number;
  media: Record<string, number>;
  demandSignals: Record<string, number>;
};

export type HistoricalTrainingEvidence = {
  schemaVersion: 1;
  compilerVersion: string;
  generatedAt: string;
  inputFingerprint: string;
  methodology: {
    rawConversationContentExported: false;
    customerIdentifiersExported: false;
    historicalFactsPromotedToConfirmed: false;
    evaluationContent: "anonymized_paraphrases";
  };
  perInstance: InstanceEvidence[];
  overall: Omit<InstanceEvidence, "instance" | "window"> & {
    instances: number;
    window: { start: string; endExclusive: string };
  };
};

export type HistoricalTrainingArtifacts = {
  package: AgentPackage;
  evaluationSuite: HistoricalEvaluationSuite;
  evidence: HistoricalTrainingEvidence;
  reviewMarkdown: string;
};

const directIdentifierPatterns = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu,
  /https?:\/\/\S+/iu,
  /\b\d{11,14}\b/u,
  /@(?:s\.whatsapp\.net|lid|g\.us)\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu
];

export function assertPrivacySafeArtifact(
  value: unknown,
  options: { denyValues?: string[]; allowValues?: string[] } = {}
) {
  const allowed = new Set(
    (options.allowValues ?? []).map(normalizeComparable).filter((item) => item.length >= 3)
  );
  const denied = Array.from(
    new Set(
      (options.denyValues ?? [])
        .map(normalizeComparable)
        .filter((item) => item.length >= 4 && !allowed.has(item))
    )
  );

  visitStrings(value, (text) => {
    if (directIdentifierPatterns.some((pattern) => pattern.test(text))) {
      throw new Error("Generated artifact contains a private identifier.");
    }

    const normalized = normalizeComparable(text);
    if (denied.some((item) => normalized.includes(item))) {
      throw new Error("Generated artifact contains a private identifier from source data.");
    }
  });
}

export function compileHistoricalTraining(input: {
  inputs: HistoricalTrainingInput[];
  definition: HistoricalTrainingDefinition;
}): HistoricalTrainingArtifacts {
  const definition = parseDefinition(input.definition);
  if (input.inputs.length < definition.minimumInstances) {
    throw new Error(
      `Historical compilation requires four source instances (minimum ${definition.minimumInstances}).`
    );
  }

  const parsedInputs = input.inputs.map((item) => {
    const history = historySchema.parse(item.history);
    const baseline = baselineSchema.parse(item.baseline);
    if (history.instance !== baseline.instance) {
      throw new Error(`History and baseline instance mismatch for ${history.instance}.`);
    }
    if (history.messages.length !== baseline.sourceMessages) {
      throw new Error(`Source message count mismatch for ${history.instance}.`);
    }
    return { history, baseline };
  });

  const perInstance = parsedInputs
    .map(({ history, baseline }) => buildInstanceEvidence(history, baseline))
    .sort((left, right) => left.instance.localeCompare(right.instance, "pt-BR"));
  const evidence: HistoricalTrainingEvidence = {
    schemaVersion: 1,
    compilerVersion: definition.compilerVersion,
    generatedAt: definition.generatedAt,
    inputFingerprint: fingerprintInputs(input.inputs),
    methodology: {
      rawConversationContentExported: false,
      customerIdentifiersExported: false,
      historicalFactsPromotedToConfirmed: false,
      evaluationContent: "anonymized_paraphrases"
    },
    perInstance,
    overall: buildOverallEvidence(perInstance)
  };
  const artifacts: HistoricalTrainingArtifacts = {
    package: definition.package,
    evaluationSuite: definition.evaluationSuite,
    evidence,
    reviewMarkdown: buildReviewMarkdown(definition, evidence)
  };

  const sourcePrivateValues = collectSourcePrivateValues(parsedInputs);
  assertPrivacySafeArtifact(artifacts, {
    denyValues: sourcePrivateValues,
    allowValues: [
      definition.package.metadata.companyName,
      ...perInstance.map((item) => item.instance)
    ]
  });
  return artifacts;
}

function parseDefinition(value: HistoricalTrainingDefinition) {
  const parsedPackage = agentPackageSchema.parse(value.package);
  const evaluationSuite = historicalEvaluationSuiteSchema.parse(value.evaluationSuite);
  if (evaluationSuite.packageKey !== parsedPackage.metadata.key) {
    throw new Error("Evaluation suite package key does not match the agent package.");
  }
  assertKnownVariables(parsedPackage);

  return {
    ...value,
    compilerVersion: z.string().trim().min(1).parse(value.compilerVersion),
    generatedAt: z.string().datetime().parse(value.generatedAt),
    minimumInstances: z.number().int().positive().parse(value.minimumInstances),
    package: parsedPackage,
    evaluationSuite,
    approvedDecisions: z.array(z.string().trim().min(1)).parse(value.approvedDecisions),
    needsValidation: z.array(z.string().trim().min(1)).parse(value.needsValidation),
    behavioralFindings: z.array(z.string().trim().min(1)).parse(value.behavioralFindings)
  };
}

function assertKnownVariables(agentPackage: AgentPackage) {
  const known = new Set(agentPackage.variables.map((item) => item.key));
  const templatedValues = [
    agentPackage.agent.name,
    agentPackage.agent.systemPrompt,
    ...agentPackage.knowledge.map((item) => item.content)
  ];
  for (const value of templatedValues) {
    for (const match of value.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) {
      const key = match[1];
      if (key && !known.has(key)) {
        throw new Error(`Unknown package variable: ${key}`);
      }
    }
  }
}

function buildInstanceEvidence(
  history: z.infer<typeof historySchema>,
  baseline: z.infer<typeof baselineSchema>
): InstanceEvidence {
  const salesConversations = baseline.conversations.filter(
    (item) => item.classification === "sales"
  );
  const commercialChatIds = new Set(salesConversations.map((item) => item.chatId));
  const commercialMessages = history.messages.filter((item) =>
    commercialChatIds.has(item.chatId)
  );

  return {
    instance: history.instance,
    window: history.window,
    sourceMessages: baseline.sourceMessages,
    individualChats: baseline.individualChats,
    conversationSegments: baseline.conversationSegments,
    commercialJourneys: salesConversations.length,
    commercialContacts: commercialChatIds.size,
    inboundMessages: commercialMessages.filter((item) => !item.fromMe).length,
    outboundMessages: commercialMessages.filter((item) => item.fromMe).length,
    media: countBy(
      commercialMessages.filter((item) => item.hasMedia),
      (item) => item.messageType
    ),
    demandSignals: sortRecord(baseline.questionCategories)
  };
}

function buildOverallEvidence(perInstance: InstanceEvidence[]) {
  const starts = perInstance.map((item) => item.window.start).sort();
  const ends = perInstance.map((item) => item.window.endExclusive).sort();

  return {
    instances: perInstance.length,
    window: {
      start: starts[0] ?? "",
      endExclusive: ends.at(-1) ?? ""
    },
    sourceMessages: sum(perInstance, "sourceMessages"),
    individualChats: sum(perInstance, "individualChats"),
    conversationSegments: sum(perInstance, "conversationSegments"),
    commercialJourneys: sum(perInstance, "commercialJourneys"),
    commercialContacts: sum(perInstance, "commercialContacts"),
    inboundMessages: sum(perInstance, "inboundMessages"),
    outboundMessages: sum(perInstance, "outboundMessages"),
    media: mergeCounts(perInstance.map((item) => item.media)),
    demandSignals: mergeCounts(perInstance.map((item) => item.demandSignals))
  };
}

function buildReviewMarkdown(
  definition: ReturnType<typeof parseDefinition>,
  evidence: HistoricalTrainingEvidence
) {
  const demandRows = Object.entries(evidence.overall.demandSignals)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `| ${key} | ${value} |`)
    .join("\n");
  const decisions = definition.approvedDecisions.map((item) => `- ${item}`).join("\n");
  const findings = definition.behavioralFindings.map((item) => `- ${item}`).join("\n");
  const questions = definition.needsValidation.map((item) => `- [ ] ${item}`).join("\n");

  return `# Revisão do ${definition.package.metadata.name}\n\n` +
    `Gerado em ${definition.generatedAt}. Este documento contém somente agregados e paráfrases anonimizadas.\n\n` +
    `## Base analisada\n\n` +
    `- ${evidence.overall.instances} instâncias.\n` +
    `- ${evidence.overall.sourceMessages.toLocaleString("pt-BR")} mensagens no recorte.\n` +
    `- ${evidence.overall.commercialJourneys.toLocaleString("pt-BR")} jornadas classificadas como comerciais.\n` +
    `- ${evidence.overall.commercialContacts.toLocaleString("pt-BR")} contatos comerciais por instância.\n\n` +
    `## Sinais de demanda\n\n| Tema | Jornadas com sinal |\n| --- | ---: |\n${demandRows}\n\n` +
    `## Decisões já aprovadas\n\n${decisions}\n\n` +
    `## Padrões comportamentais usados na V1\n\n${findings}\n\n` +
    `## Informações que o responsável da empresa precisa validar\n\n${questions}\n\n` +
    `## Regra de publicação\n\nO pacote permanece em laboratório até que as informações factuais sejam aprovadas e os casos eliminatórios da suíte de avaliação sejam aprovados sem falhas.\n`;
}

function collectSourcePrivateValues(
  inputs: Array<{
    history: z.infer<typeof historySchema>;
    baseline: z.infer<typeof baselineSchema>;
  }>
) {
  const values = new Set<string>();
  for (const { history, baseline } of inputs) {
    for (const message of history.messages) {
      addPrivate(values, message.id);
      addPrivate(values, message.chatId);
      addPrivate(values, message.participant);
      addPrivate(values, message.pushName);
    }
    for (const conversation of baseline.conversations) {
      addPrivate(values, conversation.id);
      addPrivate(values, conversation.chatId);
      addPrivate(values, conversation.contactName);
      addPrivate(values, conversation.maskedContact);
      addPrivate(values, conversation.viewerId);
    }
  }
  return [...values];
}

function addPrivate(values: Set<string>, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed && !["você", "voce", "cliente"].includes(normalizeComparable(trimmed))) {
    values.add(trimmed);
  }
}

function fingerprintInputs(inputs: HistoricalTrainingInput[]) {
  const hash = createHash("sha256");
  for (const input of inputs) {
    hash.update(JSON.stringify(input.history));
    hash.update("\u0000");
    hash.update(JSON.stringify(input.baseline));
    hash.update("\u0000");
  }
  return `sha256:${hash.digest("hex")}`;
}

function countBy<T>(items: T[], keyFor: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return sortRecord(counts);
}

function mergeCounts(records: Array<Record<string, number>>) {
  const merged: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return sortRecord(merged);
}

function sortRecord(record: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}

function sum(items: InstanceEvidence[], key: keyof InstanceEvidence) {
  return items.reduce((total, item) => total + Number(item[key]), 0);
}

function normalizeComparable(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function visitStrings(value: unknown, visitor: (value: string) => void) {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => visitStrings(item, visitor));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => visitStrings(item, visitor));
  }
}
