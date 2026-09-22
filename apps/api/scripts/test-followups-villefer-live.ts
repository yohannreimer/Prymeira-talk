import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentPackageSchema, type AgentPackage } from "@prymeira-talk/shared";
import {
  createJevFollowupDecision,
  type FollowupDecision,
  type FollowupDecisionInput
} from "../src/modules/agents/jev-followup-decision.js";
import {
  createJevReplyPreflight,
  type AgentReplyPreflightPlan,
  type AgentReplyQualityAuditResult
} from "../src/modules/agents/jev-reply-preflight.js";
import {
  selectRelevantKnowledge,
  type KnowledgeRetrievalSource
} from "../src/modules/agents/knowledge-retrieval.js";
import { villeferV1Package } from "../src/modules/agents/villefer-v1-package.js";
import { addBusinessMinutes } from "../src/modules/followups/business-time.js";
import {
  createConversationFollowupsService,
  MAX_AUTOMATIC_FOLLOWUP_STEPS,
  type ConversationFollowupRecord,
  type ConversationFollowupsPrismaLike
} from "../src/modules/followups/conversation-followups.service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(__dirname, "../../..");
config({ path: resolve(repositoryRoot, ".env") });

type ConversationEntry = ["cliente" | "atendente" | "nota interna" | "sistema", string];
type SimulatedStatus =
  | "scheduled"
  | "automatic_send_eligible"
  | "review"
  | "cancelled"
  | "sent"
  | "expired";

type ScenarioReport = {
  case: string;
  expected: Record<string, unknown>;
  decision: FollowupDecision | null;
  route: FollowupDecision["route"] | "none";
  candidateDraft: string | null;
  audit: AgentReplyQualityAuditResult | null;
  transportCalls: number;
  jevCalls: number;
  finalState: { status: SimulatedStatus; reason: string | null; step: number };
  passed: boolean;
  assertionFailures: string[];
};

class DisabledFakeTransport {
  readonly calls: Array<{ body: string }> = [];

  async deliver(body: string): Promise<never> {
    this.calls.push({ body });
    throw new Error("TRANSPORT_DISABLED_IN_LIVE_HARNESS");
  }
}

async function main() {
  const apiKey = process.env.JEV_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "JEV_API_KEY não configurada. Defina-a no .env e rode: pnpm --filter @prymeira-talk/api test:followups-villefer-live -- /caminho/pacote.json"
    );
  }

  const packagePath = resolvePackagePath();
  const rawPackage = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
  const agentPackage = agentPackageSchema.parse(rawPackage);
  const variables = resolveVariables(agentPackage);
  const sources = approvedSources(agentPackage, variables);
  const transport = new DisabledFakeTransport();
  const jevModel = process.env.JEV_MODEL?.trim() || "jev-latest";
  let jevCalls = 0;
  let activeCall = "";

  const safeFetch: typeof fetch = async (url, init) => {
    jevCalls += 1;
    const response = await fetch(url, init);
    if (process.env.JEV_TEST_DEBUG === "1") {
      console.error(JSON.stringify({
        kind: "jev_wire_debug",
        call: activeCall,
        status: response.status
      }));
    }
    if (!response.ok) {
      console.error(JSON.stringify({ kind: "jev_api_error", call: activeCall, status: response.status }));
    }
    return response;
  };

  const followupDecision = createJevFollowupDecision({ apiKey, model: jevModel, fetchImpl: safeFetch });
  const preflight = createJevReplyPreflight({ apiKey, model: jevModel, fetchImpl: safeFetch });
  if (!preflight.audit) {
    throw new Error("A auditoria JEV não está disponível.");
  }

  const reports: ScenarioReport[] = [];
  const firstInstruction = agentPackage.agent.followup.steps[0]?.instruction;
  if (!firstInstruction) {
    throw new Error("O pacote Villefer não contém a primeira instrução de follow-up.");
  }
  const qualificationInstruction =
    "Retome somente a qualificação técnica explicitamente pendente, pedindo os dados faltantes sem inferir medida, espessura, disponibilidade ou condição comercial.";
  const packageCadence = agentPackage.agent.followup.steps.map((step) => step.afterBusinessMinutes);
  const productionCadence = villeferV1Package.agent.followup.steps.map((step) => step.afterBusinessMinutes);
  console.log(JSON.stringify({
    kind: "followup_package_diagnostic",
    packageCadence,
    productionCadence,
    effectiveCadence: productionCadence,
    packageCadenceMatchesProduction: JSON.stringify(packageCadence) === JSON.stringify(productionCadence)
  }));

  {
    const startedCalls = jevCalls;
    const entries: ConversationEntry[] = [
      ["cliente", "Preciso de chapas para fabricar uma peça."],
      ["atendente", "Qual medida e espessura você precisa?"]
    ];
    const selectedKnowledge = selectApprovedKnowledge(agentPackage, sources, entries, qualificationInstruction);
    activeCall = "followup:qualification_missing_dimensions";
    const decision = await followupDecision.decide(decisionInput({
      entries,
      selectedKnowledge,
      instruction: qualificationInstruction,
      kind: "qualification",
      aiControlStatus: "agent_allowed",
      hasCompatibleActiveAgentSession: true
    }));
    const candidateDraft = "Posso continuar quando você informar a medida e a espessura necessárias.";
    activeCall = "audit:qualification_missing_dimensions";
    const audit = await preflight.audit({
      currentMessage: currentMessage(entries),
      conversationMessages: toMessages(entries),
      selectedKnowledge,
      candidateReply: candidateDraft,
      plan: qualificationPlan
    });
    const assertionFailures: string[] = [];
    assertEqual(decision.route, "automatic_send", "rota", assertionFailures);
    assertEqual(decision.outcome, "follow_up", "decisão", assertionFailures);
    assertEqual(decision.purpose, "missing_qualification", "finalidade", assertionFailures);
    assertEqual(audit.outcome, "send", "auditoria", assertionFailures);

    const state = decision.route === "automatic_send" && audit.outcome === "send"
      ? finalState("automatic_send_eligible", "delivery_disabled_by_harness")
      : finalState("review", "automatic_guardrail_not_satisfied");

    reports.push(report({
      caseName: "qualificação parada por medida/espessura",
      expected: { route: "automatic_send", audit: "send", finalStatus: "automatic_send_eligible" },
      decision,
      candidateDraft,
      audit,
      transport,
      jevCalls: jevCalls - startedCalls,
      state,
      assertionFailures
    }));
  }

  {
    const startedCalls = jevCalls;
    const entries: ConversationEntry[] = [
      ["cliente", "Pode preparar uma proposta para o item já qualificado?"],
      ["atendente", "A proposta foi preparada pelo vendedor e enviada para sua avaliação."],
      ["nota interna", "Acompanhamento autorizado caso o cliente não responda."]
    ];
    const selectedKnowledge = selectApprovedKnowledge(agentPackage, sources, entries, firstInstruction);
    activeCall = "followup:human_proposal_waiting";
    const decision = await followupDecision.decide(decisionInput({
      entries,
      selectedKnowledge,
      instruction: firstInstruction,
      kind: "human_commercial",
      aiControlStatus: "human_controlled",
      hasCompatibleActiveAgentSession: false
    }));
    const candidateDraft = "Você conseguiu avaliar a proposta? Se houver alguma dúvida, posso pedir ao vendedor que verifique.";
    activeCall = "audit:human_proposal_waiting";
    const audit = await preflight.audit({
      currentMessage: currentMessage(entries),
      conversationMessages: toMessages(entries),
      selectedKnowledge,
      candidateReply: candidateDraft,
      plan: proposalPlan
    });
    const assertionFailures: string[] = [];
    assertEqual(decision.route, "human_review", "rota", assertionFailures);
    assertEqual(decision.outcome, "follow_up", "decisão", assertionFailures);
    const state = decision.route === "human_review"
      ? finalState("review", "jev_human_review")
      : finalState("cancelled", "jev_cancel");
    assertEqual(state.status, "review", "estado final", assertionFailures);

    reports.push(report({
      caseName: "proposta humana aguardando resposta",
      expected: { route: "human_review", finalStatus: "review" },
      decision,
      candidateDraft,
      audit,
      transport,
      jevCalls: jevCalls - startedCalls,
      state,
      assertionFailures
    }));
  }

  {
    const startedCalls = jevCalls;
    const calendar = agentPackage.agent.followup;
    const anchor = new Date("2026-09-21T12:00:00.000Z");
    const sixBusinessHoursAt = addBusinessMinutes({
      from: anchor,
      minutes: villeferV1Package.agent.followup.steps[0]!.afterBusinessMinutes,
      timeZone: calendar.timeZone,
      businessDays: calendar.businessDays,
      businessHours: calendar.businessHours
    });
    const customerReplyAt = new Date(sixBusinessHoursAt.getTime() - 60_000);
    const assertionFailures: string[] = [];
    if (customerReplyAt >= sixBusinessHoursAt) {
      assertionFailures.push("a resposta sintética não ocorreu antes do vencimento de seis horas úteis");
    }
    const lifecycle = createLifecycleHarness({
      newerInboundAt: customerReplyAt,
      scheduledAt: sixBusinessHoursAt
    });
    const revalidated = await lifecycle.service.revalidateActiveFollowup({
      workspaceId: lifecycle.workspaceId,
      followupId: lifecycle.followup.id,
      now: sixBusinessHoursAt
    });
    assertEqual(revalidated.status, "cancelled", "revalidação", assertionFailures);
    if (revalidated.status === "cancelled") {
      assertEqual(revalidated.reason, "customer_replied", "motivo da revalidação", assertionFailures);
    }
    assertEqual(lifecycle.followup.status, "cancelled", "estado persistido", assertionFailures);
    assertEqual(lifecycle.followup.reason, "customer_replied", "motivo persistido", assertionFailures);
    assertEqual(jevCalls - startedCalls, 0, "chamadas JEV", assertionFailures);

    reports.push(report({
      caseName: "cliente respondeu antes de 6h úteis",
      expected: { route: "none", finalStatus: "cancelled", reason: "customer_replied", jevCalls: 0 },
      decision: null,
      candidateDraft: null,
      audit: null,
      transport,
      jevCalls: jevCalls - startedCalls,
      state: stateFromFollowup(lifecycle.followup),
      assertionFailures
    }));
  }

  {
    const startedCalls = jevCalls;
    const lifecycle = createLifecycleHarness({
      kind: "human_commercial",
      initialStatus: "review",
      aiControlStatus: "human_controlled",
      sessionStatus: "paused_by_human",
      newerOutboundAt: new Date("2026-09-21T13:00:00.000Z")
    });
    const assertionFailures: string[] = [];
    const revalidated = await lifecycle.service.revalidateActiveFollowup({
      workspaceId: lifecycle.workspaceId,
      followupId: lifecycle.followup.id
    });
    assertEqual(revalidated.status, "cancelled", "revalidação", assertionFailures);
    if (revalidated.status === "cancelled") {
      assertEqual(revalidated.reason, "outbound_replaced", "motivo da revalidação", assertionFailures);
    }
    assertEqual(jevCalls - startedCalls, 0, "chamadas JEV", assertionFailures);
    assertEqual(lifecycle.followup.reason, "outbound_replaced", "motivo persistido", assertionFailures);

    reports.push(report({
      caseName: "vendedor respondeu depois da sugestão",
      expected: { route: "none", finalStatus: "cancelled", reason: "outbound_replaced", jevCalls: 0 },
      decision: null,
      candidateDraft: null,
      audit: null,
      transport,
      jevCalls: jevCalls - startedCalls,
      state: stateFromFollowup(lifecycle.followup),
      assertionFailures
    }));
  }

  {
    const startedCalls = jevCalls;
    const entries: ConversationEntry[] = [
      ["cliente", "Preciso completar os dados do pedido."],
      ["atendente", "Qual medida e espessura você precisa?"],
      ["sistema", "Um vendedor assumiu a conversa durante a espera."]
    ];
    const selectedKnowledge = selectApprovedKnowledge(agentPackage, sources, entries, firstInstruction);
    activeCall = "followup:handoff_during_wait";
    const decision = await followupDecision.decide(decisionInput({
      entries,
      selectedKnowledge,
      instruction: qualificationInstruction,
      kind: "qualification",
      aiControlStatus: "human_controlled",
      hasCompatibleActiveAgentSession: false
    }));
    const assertionFailures: string[] = [];
    if (decision.route === "automatic_send") {
      assertionFailures.push("handoff jamais pode manter rota automatic_send");
    }
    const lifecycle = createLifecycleHarness({
      aiControlStatus: "human_controlled",
      sessionStatus: "paused_by_human"
    });
    const revalidated = await lifecycle.service.revalidateActiveFollowup({
      workspaceId: lifecycle.workspaceId,
      followupId: lifecycle.followup.id
    });
    assertEqual(revalidated.status, "cancelled", "revalidação", assertionFailures);
    if (revalidated.status === "cancelled") {
      assertEqual(revalidated.reason, "human_controlled", "motivo da revalidação", assertionFailures);
    }

    reports.push(report({
      caseName: "handoff durante espera",
      expected: { route: "never automatic_send", finalStatus: "review|cancelled" },
      decision,
      candidateDraft: null,
      audit: null,
      transport,
      jevCalls: jevCalls - startedCalls,
      state: stateFromFollowup(lifecycle.followup),
      assertionFailures
    }));
  }

  {
    const startedCalls = jevCalls;
    const entries: ConversationEntry[] = [
      ["cliente", "Quero saber se existe uma alternativa para o item solicitado."],
      ["atendente", "Vou verificar somente com informações confirmadas."]
    ];
    const candidateDraft =
      "O preço está confirmado, há estoque disponível, a entrega será no prazo, o frete está incluído e este item é equivalente ao solicitado.";
    const selectedKnowledge = selectApprovedKnowledge(agentPackage, sources, entries, candidateDraft);
    activeCall = "audit:unsupported_commercial_claims";
    const audit = await preflight.audit({
      currentMessage: currentMessage(entries),
      conversationMessages: toMessages(entries),
      selectedKnowledge,
      candidateReply: candidateDraft,
      plan: commercialRiskPlan
    });
    const assertionFailures: string[] = [];
    assertEqual(audit.outcome, "handoff", "auditoria", assertionFailures);
    const state = finalState(
      audit.outcome === "handoff" ? "review" : "cancelled",
      "audit_commercial_policy_risk"
    );

    reports.push(report({
      caseName: "fato comercial sem fonte",
      expected: { route: "human_review", audit: "handoff", finalStatus: "review" },
      decision: null,
      route: "human_review",
      candidateDraft,
      audit,
      transport,
      jevCalls: jevCalls - startedCalls,
      state,
      assertionFailures
    }));
  }

  {
    const startedCalls = jevCalls;
    const assertionFailures: string[] = [];
    const configuredFourthStep = agentPackage.agent.followup.steps[MAX_AUTOMATIC_FOLLOWUP_STEPS];
    if (configuredFourthStep) {
      assertionFailures.push("o pacote contém uma quarta etapa que o modelo produtivo não deve criar");
    }
    const lifecycle = createLifecycleHarness({
      initialStatus: "processing",
      stepIndex: MAX_AUTOMATIC_FOLLOWUP_STEPS,
      lockedAt: new Date("2026-09-21T13:00:00.000Z")
    });
    const completed = await lifecycle.service.completeAutomaticFollowup({
      workspaceId: lifecycle.workspaceId,
      followupId: lifecycle.followup.id,
      followup: lifecycle.followup,
      claim: { lockedAt: lifecycle.followup.lockedAt as Date },
      agentBehaviorConfig: { followup: villeferV1Package.agent.followup },
      finalBody: "Última confirmação técnica sintética.",
      decision: { route: "automatic_send", purpose: "missing_qualification" },
      now: new Date("2026-09-21T13:01:00.000Z")
    });
    assertEqual(completed.status, "sent", "conclusão", assertionFailures);
    assertEqual(lifecycle.createdFollowups.length, 0, "quarta etapa criada", assertionFailures);
    assertEqual(lifecycle.followup.stepIndex, MAX_AUTOMATIC_FOLLOWUP_STEPS, "etapa final", assertionFailures);
    assertEqual(jevCalls - startedCalls, 0, "chamadas JEV", assertionFailures);

    reports.push(report({
      caseName: "terceiro envio encerra a cadência",
      expected: {
        route: "none",
        finalStatus: "sent",
        finalStep: MAX_AUTOMATIC_FOLLOWUP_STEPS,
        fourthStepCreated: false
      },
      decision: null,
      candidateDraft: null,
      audit: null,
      transport,
      jevCalls: jevCalls - startedCalls,
      state: stateFromFollowup(lifecycle.followup, "maximum_followup_steps_reached"),
      assertionFailures
    }));
  }

  for (const scenario of reports) {
    console.log(JSON.stringify({ kind: "followup_simulation", ...scenario }));
  }

  const failures = reports.filter((scenario) => !scenario.passed);
  console.log(JSON.stringify({
    kind: "followup_simulation_summary",
    cases: reports.length,
    passed: reports.length - failures.length,
    failed: failures.length,
    transportCalls: transport.calls.length,
    externalMessagingEnabled: false,
    generatorModelCalled: false,
    databaseUsed: false,
    jevCalls
  }));

  if (transport.calls.length !== 0) {
    throw new Error(`Invariante violada: transportCalls=${transport.calls.length}.`);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} cenário(s) divergiram; consulte as linhas followup_simulation.`);
  }
}

const qualificationPlan: AgentReplyPreflightPlan = {
  conversationStage: "qualification",
  commercialPath: "ambiguous",
  nextAction: "ask_missing_technical"
};

const proposalPlan: AgentReplyPreflightPlan = {
  conversationStage: "post_proposal",
  commercialPath: "not_applicable",
  nextAction: "handoff"
};

const commercialRiskPlan: AgentReplyPreflightPlan = {
  conversationStage: "qualification",
  commercialPath: "ambiguous",
  nextAction: "handoff"
};

const lifecycleIds = {
  workspaceId: "synthetic-workspace",
  conversationId: "00000000-0000-4000-8000-000000000401",
  agentId: "00000000-0000-4000-8000-000000000101",
  sessionId: "00000000-0000-4000-8000-000000000301",
  anchorMessageId: "00000000-0000-4000-8000-000000000601",
  followupId: "00000000-0000-4000-8000-000000000701"
};

function createLifecycleHarness(input: {
  kind?: ConversationFollowupRecord["kind"];
  initialStatus?: string;
  stepIndex?: number;
  aiControlStatus?: string;
  sessionStatus?: string;
  scheduledAt?: Date;
  newerInboundAt?: Date;
  newerOutboundAt?: Date;
  lockedAt?: Date;
} = {}) {
  const anchorAt = new Date("2026-09-21T12:00:00.000Z");
  const anchorIngestedAt = new Date("2026-09-21T12:00:00.100Z");
  const followup: ConversationFollowupRecord = {
    id: lifecycleIds.followupId,
    workspaceId: lifecycleIds.workspaceId,
    conversationId: lifecycleIds.conversationId,
    agentId: lifecycleIds.agentId,
    sessionId: lifecycleIds.sessionId,
    kind: input.kind ?? "qualification",
    status: input.initialStatus ?? "scheduled",
    activeKey: "active",
    stepIndex: input.stepIndex ?? 1,
    anchorMessageId: lifecycleIds.anchorMessageId,
    anchorMessageAt: anchorAt,
    anchorIngestedAt,
    scheduledAt: input.scheduledAt ?? new Date("2026-09-21T18:00:00.000Z"),
    lockedAt: input.lockedAt ?? null,
    decision: {},
    reason: null
  };
  const agent = {
    id: lifecycleIds.agentId,
    workspaceId: lifecycleIds.workspaceId,
    status: "active",
    behaviorConfig: { followup: villeferV1Package.agent.followup }
  };
  const session = {
    id: lifecycleIds.sessionId,
    workspaceId: lifecycleIds.workspaceId,
    conversationId: lifecycleIds.conversationId,
    agentId: lifecycleIds.agentId,
    status: input.sessionStatus ?? "active",
    updatedAt: anchorAt,
    agent
  };
  const conversation = {
    id: lifecycleIds.conversationId,
    workspaceId: lifecycleIds.workspaceId,
    status: "open",
    aiControlStatus: input.aiControlStatus ?? "agent_allowed",
    activeAgentSessionId: lifecycleIds.sessionId,
    activeAgentSession: session
  };
  const createdFollowups: ConversationFollowupRecord[] = [];

  const conversationFollowup = {
    async findFirst() {
      return followup;
    },
    async findMany() {
      return [];
    },
    async updateMany(args: unknown) {
      const data = asRecord(asRecord(args)?.data);
      if (!data || followup.activeKey !== "active") return { count: 0 };
      Object.assign(followup, data);
      return { count: 1 };
    },
    async create(args: unknown) {
      const data = asRecord(asRecord(args)?.data) as ConversationFollowupRecord | null;
      if (!data) throw new Error("Follow-up sintético sem dados de criação.");
      const created = { ...data, id: `synthetic-created-${createdFollowups.length + 1}` };
      createdFollowups.push(created);
      return created;
    }
  };
  const prismaCore = {
    conversation: {
      async findUnique() {
        return conversation;
      }
    },
    message: {
      async findFirst(args: unknown) {
        const where = asRecord(asRecord(args)?.where);
        if (where?.direction === "inbound" && input.newerInboundAt) {
          return syntheticMessage("synthetic-customer-reply", "inbound", input.newerInboundAt);
        }
        if (where?.direction === "outbound" && input.newerOutboundAt) {
          return syntheticMessage("synthetic-seller-reply", "outbound", input.newerOutboundAt);
        }
        return null;
      }
    },
    aiAgentSession: {
      async findFirst() {
        return session;
      }
    },
    conversationFollowup
  };
  const prisma = {
    ...prismaCore,
    async $transaction<T>(callback: (tx: typeof prismaCore) => Promise<T>) {
      return callback(prismaCore);
    }
  } as ConversationFollowupsPrismaLike;

  return {
    workspaceId: lifecycleIds.workspaceId,
    followup,
    createdFollowups,
    service: createConversationFollowupsService(prisma)
  };
}

function syntheticMessage(id: string, direction: "inbound" | "outbound", at: Date) {
  return {
    id,
    workspaceId: lifecycleIds.workspaceId,
    conversationId: lifecycleIds.conversationId,
    direction,
    createdAt: at,
    ingestedAt: at
  };
}

function finalState(
  status: SimulatedStatus,
  reason: string | null,
  step = 1
): ScenarioReport["finalState"] {
  return { status, reason, step };
}

function stateFromFollowup(
  followup: ConversationFollowupRecord,
  reasonOverride?: string
): ScenarioReport["finalState"] {
  return finalState(
    followup.status as SimulatedStatus,
    reasonOverride ?? followup.reason ?? null,
    followup.stepIndex
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function report(input: {
  caseName: string;
  expected: Record<string, unknown>;
  decision: FollowupDecision | null;
  route?: ScenarioReport["route"];
  candidateDraft: string | null;
  audit: AgentReplyQualityAuditResult | null;
  transport: DisabledFakeTransport;
  jevCalls: number;
  state: ScenarioReport["finalState"];
  assertionFailures: string[];
}): ScenarioReport {
  if (input.transport.calls.length !== 0) {
    input.assertionFailures.push(`transportCalls esperado 0, recebido ${input.transport.calls.length}`);
  }
  return {
    case: input.caseName,
    expected: input.expected,
    decision: input.decision,
    route: input.route ?? input.decision?.route ?? "none",
    candidateDraft: input.candidateDraft,
    audit: input.audit,
    transportCalls: input.transport.calls.length,
    jevCalls: input.jevCalls,
    finalState: input.state,
    passed: input.assertionFailures.length === 0,
    assertionFailures: input.assertionFailures
  };
}

function decisionInput(input: {
  entries: ConversationEntry[];
  selectedKnowledge: FollowupDecisionInput["selectedKnowledge"];
  instruction: string;
  kind: FollowupDecisionInput["followupKind"];
  aiControlStatus: FollowupDecisionInput["aiControlStatus"];
  hasCompatibleActiveAgentSession: boolean;
}): FollowupDecisionInput {
  return {
    conversationMessages: toMessages(input.entries),
    selectedKnowledge: input.selectedKnowledge,
    followupKind: input.kind,
    step: 1,
    instruction: input.instruction,
    aiControlStatus: input.aiControlStatus,
    hasCompatibleActiveAgentSession: input.hasCompatibleActiveAgentSession
  };
}

function toMessages(entries: ConversationEntry[]): FollowupDecisionInput["conversationMessages"] {
  return entries.map(([label, body], index) => ({
    id: `synthetic-message-${index + 1}`,
    label,
    body,
    type: "text",
    createdAt: `2026-09-21T12:${String(index).padStart(2, "0")}:00.000Z`
  }));
}

function currentMessage(entries: ConversationEntry[]) {
  const messages = toMessages(entries);
  const latest = messages.at(-1);
  if (!latest?.body) {
    throw new Error("O cenário sintético precisa ter uma mensagem atual.");
  }
  return { id: latest.id, body: latest.body, type: latest.type };
}

function selectApprovedKnowledge(
  agentPackage: AgentPackage,
  sources: KnowledgeRetrievalSource[],
  entries: ConversationEntry[],
  instruction: string
) {
  return selectRelevantKnowledge({
    latestMessage: entries.at(-1)?.[1],
    conversationHistory: entries.map(([label, body]) => `${label}: ${body}`).join("\n"),
    instruction,
    taxonomy: agentPackage.agent.knowledgeTaxonomy,
    sources
  }).selected.map((source) => ({ title: source.title, content: source.content }));
}

function approvedSources(agentPackage: AgentPackage, variables: Record<string, string>): KnowledgeRetrievalSource[] {
  return agentPackage.knowledge
    .filter((source) => source.approvalStatus === "confirmed")
    .map((source) => ({
      id: source.key,
      title: source.title,
      content: renderTemplate(source.content, variables),
      metadata: { category: source.category, aliases: source.aliases }
    }));
}

function resolveVariables(agentPackage: AgentPackage) {
  const values: Record<string, string> = {};
  for (const variable of agentPackage.variables) {
    values[variable.key] = variable.defaultValue ?? (variable.key === "seller_name" ? "Vendedor sintético" : variable.key);
  }
  return values;
}

function renderTemplate(value: string, values: Record<string, string>) {
  return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) => values[key] ?? `{{${key}}}`);
}

function resolvePackagePath() {
  const cliPath = process.argv.slice(2).find((argument) => argument !== "--")?.trim();
  const configuredPath = cliPath || process.env.VILLEFER_AGENT_PACKAGE_PATH?.trim();
  return resolve(configuredPath || resolve(repositoryRoot, "artifacts/agents/villefer/villefer-v1.agent-package.json"));
}

function assertEqual(actual: unknown, expected: unknown, label: string, failures: string[]) {
  if (actual !== expected) {
    failures.push(`${label} esperado ${String(expected)}, recebido ${String(actual)}`);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Falha desconhecida no ensaio de follow-ups."}\n`);
  process.exitCode = 1;
});
