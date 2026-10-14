import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentPackageSchema, type AgentPackage } from "@prymeira-talk/shared";
import {
  createJevReplyPreflight,
  type AgentReplyPreflightInput,
  type AgentReplyPreflightPlan,
  type AgentReplyPreflightResult
} from "../src/modules/agents/jev-reply-preflight.js";
import {
  createJevFollowupDecision,
  type FollowupDecision,
  type FollowupDecisionInput
} from "../src/modules/agents/jev-followup-decision.js";
import { resolveFollowupStepInstruction } from "../src/modules/agents/followup-step-instruction.js";
import { resolveEffectiveFollowupConfig } from "../src/modules/agents/effective-followup-config.js";
import {
  selectRelevantKnowledge,
  type KnowledgeRetrievalSource,
  type SelectedKnowledgeSource
} from "../src/modules/agents/knowledge-retrieval.js";
import { buildAgentDecisionContext } from "../src/modules/agents/agent-decision-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(__dirname, "../../..");
config({ path: resolve(repositoryRoot, ".env") });

const packagePath = resolvePackagePath();
const dryRun = process.argv.includes("--dry-run");

const apiKey = process.env.JEV_API_KEY?.trim();
if (!apiKey && !dryRun) {
  throw new Error("Defina JEV_API_KEY no .env antes de executar este teste.");
}

const rawPackage = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
const agentPackage = agentPackageSchema.parse(rawPackage);
const variables = resolveVariables(agentPackage);
const renderedPrompt = renderTemplate(agentPackage.agent.systemPrompt, variables);
if (/{{\s*[a-zA-Z0-9_]+\s*}}/.test(renderedPrompt)) {
  throw new Error("O prompt do pacote ainda tem variáveis não resolvidas.");
}

const sources = agentPackage.knowledge
  .filter((source) => source.approvalStatus === "confirmed")
  .map((source) => ({
    id: source.key,
    title: source.title,
    content: renderTemplate(source.content, variables),
    metadata: {
      category: source.category,
      aliases: source.aliases
    }
  }));
const sourceById = new Map(agentPackage.knowledge.map((source) => [source.key, source]));
const debugJev = process.env.JEV_TEST_DEBUG === "1";
let activeJevCall = "";

const jevFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init);
  if (debugJev) {
    const wire = activeJevCall.startsWith("audit:") ? await response.clone().json().catch(() => null) : null;
    console.error(JSON.stringify({
      kind: "jev_wire_debug",
      call: activeJevCall,
      status: response.status,
      answers: wire?.answers ?? null
    }));
  }
  if (!response.ok) {
    console.error(JSON.stringify({ kind: "jev_api_error", call: activeJevCall, status: response.status }));
  }
  return response;
};

const jevModel = process.env.JEV_MODEL?.trim() || "jev-latest";
const client = createJevReplyPreflight({ apiKey: apiKey ?? "dry-run", model: jevModel, fetchImpl: jevFetch });
const followupClient = createJevFollowupDecision({ apiKey: apiKey ?? "dry-run", model: jevModel, fetchImpl: jevFetch });

type ConversationEntry = ["cliente" | "atendente" | "nota interna", string];
type PreflightExpectation = {
  outcome: "silence" | "continue";
  conversationStage?: AgentReplyPreflightPlan["conversationStage"];
  commercialPath?: AgentReplyPreflightPlan["commercialPath"];
  nextAction?: AgentReplyPreflightPlan["nextAction"];
  requiredKnowledge: string[];
};
type LiveCase = {
  name: string;
  body: string;
  history: ConversationEntry[];
  expected: PreflightExpectation;
};
type FollowupLiveCase = {
  name: string;
  history: ConversationEntry[];
  input: Omit<FollowupDecisionInput, "conversationMessages" | "selectedKnowledge">;
  expected: FollowupDecision;
};

const history = (entries: ConversationEntry[]): AgentReplyPreflightInput["conversationMessages"] =>
  entries.map(([label, body], index) => ({
    id: `message-${index + 1}`,
    label,
    body,
    type: "text",
    createdAt: `2026-09-21T12:${String(index).padStart(2, "0")}:00.000Z`
  }));

const cases: LiveCase[] = [
  {
    name: "barra chata fora da faixa e material pendente fica sob consulta",
    body: "Preciso de 10 barras chatas laminadas de 1/8 x 3/8 ASTM A36. Tem disponibilidade?",
    history: [["cliente", "Preciso de 10 barras chatas laminadas de 1/8 x 3/8 ASTM A36. Tem disponibilidade?"]],
    expected: {
      outcome: "continue",
      conversationStage: "new_quote",
      commercialPath: "ambiguous",
      nextAction: "handoff",
      requiredKnowledge: ["approved_positive_catalog_v1", "approved_supply_and_registration_20260914"]
    }
  },
  {
    name: "barra chata de linha de estoque sem material ou comprimento pede dado ausente sem confirmar saldo",
    body: "Preciso de 10 barras chatas de 1/4 x 1 polegada. Vocês têm para retirada?",
    history: [["cliente", "Preciso de 10 barras chatas de 1/4 x 1 polegada. Vocês têm para retirada?"]],
    expected: {
      outcome: "continue",
      conversationStage: "new_quote",
      commercialPath: "stock",
      nextAction: "ask_missing_technical",
      requiredKnowledge: ["approved_positive_catalog_v1", "approved_supply_and_registration_20260914"]
    }
  },
  {
    name: "tubo inox recebe caminho de encomenda e mínimo correto",
    body: "Preciso de 50 kg de tubo inox para uma máquina. Vocês conseguem fornecer?",
    history: [["cliente", "Preciso de 50 kg de tubo inox para uma máquina. Vocês conseguem fornecer?"]],
    expected: {
      outcome: "continue",
      conversationStage: "new_quote",
      commercialPath: "made_to_order",
      nextAction: "offer_catalog_or_seller",
      requiredKnowledge: ["approved_positive_catalog_v1", "approved_supply_and_registration_20260914"]
    }
  },
  {
    name: "barra maciça quadrada é recusada como não vendida",
    body: "Vocês vendem barra maciça quadrada de 12 mm?",
    history: [["cliente", "Vocês vendem barra maciça quadrada de 12 mm?"]],
    expected: {
      outcome: "continue",
      conversationStage: "new_quote",
      commercialPath: "not_sold",
      requiredKnowledge: ["approved_positive_catalog_v1"]
    }
  },
  {
    name: "pedido genérico de chapa pede somente dados técnicos",
    body: "Preciso de chapa para um serviço.",
    history: [["cliente", "Preciso de chapa para um serviço."]],
    expected: {
      outcome: "continue",
      conversationStage: "new_quote",
      nextAction: "ask_missing_technical",
      requiredKnowledge: ["approved_positive_catalog_v1"]
    }
  },
  {
    name: "Ricardo — pedido de material oxicortado",
    body: "Material para porcas oxicortado, diâmetro externo 220 mm, interno 125 mm, comprimento 160 mm, 4 peças de aço 1045.",
    history: [
      ["cliente", "Poderia me ajudar com uma cotação?"],
      ["atendente", "Qual produto precisa cotar? Informe material, medidas, especificação e quantidade."],
      ["cliente", "Material para porcas oxicortado, diâmetro externo 220 mm, interno 125 mm, comprimento 160 mm, 4 peças de aço 1045."]
    ],
    expected: {
      outcome: "continue",
      conversationStage: "qualification",
      commercialPath: "not_sold",
      nextAction: "answer_current_request",
      requiredKnowledge: ["approved_positive_catalog_v1"]
    }
  },
  {
    name: "João — barra para viga baldrame em mensagens fragmentadas",
    body: "10mm",
    history: [
      ["cliente", "Quanto está uma barra de 10 mm x 12 m?"],
      ["atendente", "É vergalhão para construção ou barra lisa redonda industrial?"],
      ["cliente", "Barra para viga baldrame"],
      ["cliente", "10mm"]
    ],
    expected: {
      outcome: "continue",
      conversationStage: "qualification",
      commercialPath: "not_sold",
      nextAction: "answer_current_request",
      requiredKnowledge: ["approved_positive_catalog_v1"]
    }
  },
  {
    name: "pedido explícito de vendedor não reinicia qualificação",
    body: "Prefiro falar com um vendedor.",
    history: [
      ["cliente", "Preciso de uma cotação de cantoneira."],
      ["atendente", "Qual medida e quantidade você precisa?"],
      ["cliente", "Prefiro falar com um vendedor."]
    ],
    expected: {
      outcome: "continue",
      conversationStage: "qualification",
      nextAction: "handoff",
      requiredKnowledge: ["approved_operating_scope"]
    }
  },
  {
    name: "agradecimento após assunto encerrado não gera resposta",
    body: "Ok, sem problemas. Obrigado pela atenção.",
    history: [
      ["cliente", "Vocês atendem minha região?"],
      ["atendente", "No momento não atendemos essa região."],
      ["cliente", "Ok, sem problemas. Obrigado pela atenção."]
    ],
    expected: {
      outcome: "silence",
      requiredKnowledge: []
    }
  }
];

if (dryRun) {
  for (const testCase of cases) {
    const input = buildInput(testCase.body, testCase.history);
    const decisionContext = buildAgentDecisionContext({
      messages: input.conversationMessages.map((message) => ({
        ...message,
        direction: message.label === "cliente" ? "inbound" : message.label === "atendente" ? "outbound" : null
      })),
      currentMessageId: input.currentMessage.id,
      effectiveText: testCase.body
    });
    const selection = selectRelevantKnowledge({
      latestMessage: decisionContext.activeCustomerRequest,
      conversationHistory: decisionContext.formattedHistory,
      instruction: null,
      taxonomy: agentPackage.agent.knowledgeTaxonomy,
      sources
    });
    console.log(JSON.stringify({
      kind: "local_context_replay",
      name: testCase.name,
      promptCharacters: renderedPrompt.length,
      recentMessages: decisionContext.messages.length,
      activeCustomerRequest: decisionContext.activeCustomerRequest,
      selectedKnowledgeIds: selection.selected.map((source) => source.id),
      selectedKnowledgeCharacters: selection.selected.reduce((total, source) => total + source.content.length, 0),
      jevCalled: false
    }));
  }
  process.exit(0);
}

const firstFollowupInstruction = agentPackage.agent.followup.steps[0]?.instruction;
if (!firstFollowupInstruction) {
  throw new Error("O pacote não contém a primeira instrução de follow-up.");
}
const qualificationFollowupInstruction = resolveFollowupStepInstruction({
  kind: "qualification",
  configuredInstruction: firstFollowupInstruction
});

const followupCases: FollowupLiveCase[] = [
  {
    name: "qualificação aguardando medida e espessura pode seguir automaticamente",
    history: [
      ["cliente", "Preciso de chapas para fabricar uma peça."],
      ["atendente", "Qual medida e espessura você precisa?"]
    ],
    input: {
      followupKind: "qualification",
      step: 1,
      instruction: qualificationFollowupInstruction,
      aiControlStatus: "agent_allowed",
      hasCompatibleActiveAgentSession: true
    },
    expected: {
      outcome: "follow_up",
      purpose: "missing_qualification",
      route: "automatic_send",
      stage: "qualification",
      risk: "none"
    }
  },
  {
    name: "proposta de vendedor aguardando retorno exige revisão humana",
    history: [
      ["cliente", "Pode preparar uma proposta para o item já qualificado?"],
      ["atendente", "A proposta foi preparada pelo vendedor e enviada para sua avaliação."],
      ["nota interna", "Acompanhamento autorizado caso o cliente não responda."]
    ],
    input: {
      followupKind: "human_commercial",
      step: 1,
      instruction: firstFollowupInstruction,
      aiControlStatus: "human_controlled",
      hasCompatibleActiveAgentSession: false
    },
    expected: {
      outcome: "follow_up",
      purpose: "proposal_checkin",
      route: "human_review",
      stage: "post_proposal",
      risk: "human_owned"
    }
  }
];

let failures = 0;
let conservativeWarnings = 0;
const effectiveFollowupConfig = resolveEffectiveFollowupConfig({
  packageMetadata: agentPackage.metadata,
  followup: agentPackage.agent.followup
});
if (!effectiveFollowupConfig) {
  throw new Error("A configuração efetiva de follow-up não pôde ser resolvida.");
}
console.log(JSON.stringify({
  kind: "package",
  package: agentPackage.metadata.name,
  packageKey: agentPackage.metadata.key,
  knowledgeSources: agentPackage.knowledge.length,
  confirmedKnowledgeSources: agentPackage.knowledge.filter((source) => source.approvalStatus === "confirmed").length,
  behavioralKnowledgeSources: agentPackage.knowledge.filter((source) => source.approvalStatus === "behavioral").length,
  promptCharacters: renderedPrompt.length,
  promptSentToJev: true,
  packageCadence: agentPackage.agent.followup.steps.map((step) => step.afterBusinessMinutes),
  effectiveProductionCadence: effectiveFollowupConfig.steps.map((step) => step.afterBusinessMinutes),
  cadenceDiagnostic:
    JSON.stringify(agentPackage.agent.followup.steps.map((step) => step.afterBusinessMinutes)) ===
      JSON.stringify(effectiveFollowupConfig.steps.map((step) => step.afterBusinessMinutes))
      ? "current"
      : "package_outdated_runtime_uses_production_cadence",
  note: "O JEV de respostas recebe o prompt integral, até 20 mensagens recentes completas e conhecimento aprovado selecionado."
}));

const evaluatedCases = new Map<string, { input: AgentReplyPreflightInput; result: AgentReplyPreflightResult }>();
for (const testCase of cases) {
  const input = buildInput(testCase.body, testCase.history);
  const decisionContext = buildAgentDecisionContext({
    messages: input.conversationMessages.map((message) => ({
      ...message,
      direction: message.label === "cliente" ? "inbound" : message.label === "atendente" ? "outbound" : null
    })),
    currentMessageId: input.currentMessage.id,
    effectiveText: testCase.body
  });
  input.conversationMessages = decisionContext.messages;
  const selection = selectRelevantKnowledge({
    latestMessage: decisionContext.activeCustomerRequest,
    conversationHistory: decisionContext.formattedHistory,
    instruction: null,
    taxonomy: agentPackage.agent.knowledgeTaxonomy,
    sources
  });
  input.selectedKnowledge = selection.selected.map((source) => ({ id: source.id, title: source.title, content: source.content }));

  const selectedKnowledge = selection.selected.map(describeSelectedKnowledge);
  const selectedIds = new Set(selection.selected.map((source) => source.id));
  const missingRequiredKnowledge = testCase.expected.requiredKnowledge.filter((id) => !selectedIds.has(id));
  activeJevCall = `preflight:${testCase.name}`;
  const result = await client.evaluate(input);
  const assertionFailures = assertPreflight(result, testCase.expected);
  if (missingRequiredKnowledge.length > 0) {
    assertionFailures.push(`fontes obrigatórias ausentes: ${missingRequiredKnowledge.join(", ")}`);
  }
  const passed = assertionFailures.length === 0;
  failures += passed ? 0 : 1;
  evaluatedCases.set(testCase.name, { input, result });

  console.log(JSON.stringify({
    kind: "preflight",
    name: testCase.name,
    passed,
    assertionFailures,
    selection: {
      totalSources: selection.total,
      evaluatedChunks: selection.evaluatedChunks,
      selectedKnowledge
    },
    result
  }));
}

for (const testCase of followupCases) {
  const conversationMessages = history(testCase.history);
  const selection = selectRelevantKnowledge({
    latestMessage: conversationMessages.at(-1)?.body,
    conversationHistory: formatHistory(testCase.history),
    instruction: testCase.input.instruction,
    taxonomy: agentPackage.agent.knowledgeTaxonomy,
    sources
  });
  const input: FollowupDecisionInput = {
    ...testCase.input,
    conversationMessages,
    selectedKnowledge: selection.selected.map((source) => ({
      title: source.title,
      content: source.content
    }))
  };
  activeJevCall = `followup:${testCase.name}`;
  const decision = await followupClient.decide(input);
  const assertionFailures = assertFollowupDecision(decision, testCase.expected);
  const passed = assertionFailures.length === 0;
  failures += passed ? 0 : 1;

  console.log(JSON.stringify({
    kind: "followup_decision",
    case: testCase.name,
    expected: testCase.expected,
    decision,
    route: decision.route,
    passed,
    assertionFailures,
    selection: {
      approvedSources: selection.selected.map((source) => source.id),
      selectedCharacters: selection.selected.reduce((total, source) => total + source.content.length, 0)
    }
  }));
}

if (!client.audit) throw new Error("A auditoria JEV não foi configurada.");

const originalBarCase = evaluatedCases.get("barra chata fora da faixa e material pendente fica sob consulta");
const stockBarCase = evaluatedCases.get("barra chata de linha de estoque sem material ou comprimento pede dado ausente sem confirmar saldo");
const inoxCase = evaluatedCases.get("tubo inox recebe caminho de encomenda e mínimo correto");
const squareBarCase = evaluatedCases.get("barra maciça quadrada é recusada como não vendida");
if (!originalBarCase || !stockBarCase || !inoxCase || !squareBarCase) {
  throw new Error("Os casos necessários para a auditoria não foram preparados.");
}

const audits = [
  {
    name: "aceita consulta de disponibilidade sem inventar estoque",
    input: originalBarCase.input,
    plan: planOf(originalBarCase.result, { commercialPath: "ambiguous", nextAction: "handoff" }),
    candidateReply: "Vou encaminhar ao vendedor para verificar a disponibilidade e a especificação dessa barra.",
    expected: "send"
  },
  {
    name: "bloqueia retirada hoje sem evidência de saldo",
    input: stockBarCase.input,
    plan: planOf(stockBarCase.result, { commercialPath: "stock", nextAction: "ask_missing_technical" }),
    candidateReply: "Temos as 10 barras em estoque e você pode retirar hoje.",
    expected: "handoff"
  },
  {
    name: "aceita mínimo e escolha de catálogo ou vendedor para inox novo",
    input: inoxCase.input,
    plan: planOf(inoxCase.result, { commercialPath: "made_to_order", nextAction: "offer_catalog_or_seller" }),
    candidateReply: "Tubos de inox são sob encomenda e o pedido mínimo é de 300 kg. Prefere ver o catálogo com os itens ou falar com um vendedor?",
    expected: "send"
  },
  {
    name: "bloqueia prazo e pagamento inventados para encomenda",
    input: inoxCase.input,
    plan: planOf(inoxCase.result, { commercialPath: "made_to_order", nextAction: "offer_catalog_or_seller" }),
    candidateReply: "Conseguimos entregar amanhã e pode pagar faturado em 30 dias.",
    expected: "handoff"
  },
  {
    name: "aceita recusa objetiva de barra maciça quadrada",
    input: squareBarCase.input,
    plan: planOf(squareBarCase.result, { commercialPath: "not_sold", nextAction: "answer_current_request" }),
    candidateReply: "Não trabalhamos com barra maciça quadrada.",
    expected: "send"
  },
  {
    name: "bloqueia equivalente técnico não aprovado",
    input: squareBarCase.input,
    plan: planOf(squareBarCase.result, { commercialPath: "not_sold", nextAction: "answer_current_request" }),
    candidateReply: "Não trabalhamos com barra quadrada, mas posso fornecer tubo quadrado como equivalente.",
    expected: "handoff"
  }
] as const;

for (const testCase of audits) {
  activeJevCall = `audit:${testCase.name}`;
  const result = await client.audit({
    ...testCase.input,
    plan: testCase.plan,
    candidateReply: testCase.candidateReply
  });
  const exactMatch = result.outcome === testCase.expected;
  const conservativeBlock = testCase.expected === "send" && result.outcome !== "send";
  const dangerousMismatch = testCase.expected === "handoff" && result.outcome !== "handoff";
  failures += dangerousMismatch ? 1 : 0;
  conservativeWarnings += conservativeBlock ? 1 : 0;
  console.log(JSON.stringify({
    kind: "audit",
    name: testCase.name,
    passed: exactMatch,
    acceptable: !dangerousMismatch,
    severity: conservativeBlock ? "quality_warning" : dangerousMismatch ? "safety_failure" : "none",
    expected: testCase.expected,
    result
  }));
}

if (failures > 0) {
  throw new Error(`${failures} cenário(s) não tiveram a decisão esperada. Revise as saídas antes de alterar o agente.`);
}

console.log(JSON.stringify({
  kind: "jev_package_summary",
  safetyFailures: failures,
  conservativeWarnings,
  transportCalls: 0,
  generatorModelCalled: false,
  databaseUsed: false
}));
console.log("JEV Villefer package check aprovado com fail-closed. Nenhuma mensagem foi enviada, nenhum GPT foi chamado e nenhum dado foi gravado.");

function buildInput(body: string, entries: ConversationEntry[]): AgentReplyPreflightInput {
  return {
    agentRules: renderedPrompt,
    currentMessage: { id: `message-${entries.length}`, body, type: "text" },
    conversationMessages: history(entries),
    selectedKnowledge: []
  };
}

function formatHistory(entries: ConversationEntry[]) {
  return entries.map(([label, body]) => `${label}: ${body}`).join("\n");
}

function describeSelectedKnowledge(source: SelectedKnowledgeSource) {
  const packageSource = sourceById.get(source.id);
  return {
    key: source.id,
    title: source.title,
    approvalStatus: packageSource?.approvalStatus ?? "unknown",
    category: source.category,
    score: source.score,
    reasons: source.reasons,
    characters: source.content.length
  };
}

function assertPreflight(result: AgentReplyPreflightResult, expected: PreflightExpectation) {
  const failures: string[] = [];
  if (result.outcome !== expected.outcome) {
    failures.push(`resultado esperado ${expected.outcome}, recebido ${result.outcome}`);
    return failures;
  }
  if (result.outcome === "silence") return failures;

  if (expected.conversationStage && result.plan.conversationStage !== expected.conversationStage) {
    failures.push(`etapa esperada ${expected.conversationStage}, recebida ${result.plan.conversationStage}`);
  }
  if (expected.commercialPath && result.plan.commercialPath !== expected.commercialPath) {
    failures.push(`caminho comercial esperado ${expected.commercialPath}, recebido ${result.plan.commercialPath}`);
  }
  if (expected.nextAction && result.plan.nextAction !== expected.nextAction) {
    failures.push(`próxima ação esperada ${expected.nextAction}, recebida ${result.plan.nextAction}`);
  }
  return failures;
}

function assertFollowupDecision(result: FollowupDecision, expected: FollowupDecision) {
  const failures: string[] = [];
  for (const key of ["outcome", "purpose", "route", "stage", "risk"] as const) {
    if (result[key] !== expected[key]) {
      failures.push(`${key} esperado ${expected[key]}, recebido ${result[key]}`);
    }
  }
  return failures;
}

function planOf(
  result: AgentReplyPreflightResult,
  fallback: Pick<AgentReplyPreflightPlan, "commercialPath" | "nextAction">
): AgentReplyPreflightPlan {
  if (result.outcome === "continue") return result.plan;
  return {
    conversationStage: "new_quote",
    commercialPath: fallback.commercialPath,
    nextAction: fallback.nextAction
  };
}

function resolveVariables(agentPackage: AgentPackage) {
  const values: Record<string, string> = {};
  for (const variable of agentPackage.variables) {
    values[variable.key] = variable.defaultValue ?? (variable.key === "seller_name" ? "Vendedor Villefer" : variable.key);
  }
  return values;
}

function renderTemplate(value: string, values: Record<string, string>) {
  return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) => values[key] ?? `{{${key}}}`);
}

function resolvePackagePath() {
  const cliPath = process.argv.slice(2).find((argument) => argument !== "--" && argument !== "--dry-run")?.trim();
  const configuredPath = cliPath || process.env.VILLEFER_AGENT_PACKAGE_PATH?.trim();
  return resolve(configuredPath || resolve(repositoryRoot, "artifacts/agents/villefer/villefer-v1.agent-package.json"));
}
