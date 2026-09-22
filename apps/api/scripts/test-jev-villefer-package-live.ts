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
  selectRelevantKnowledge,
  type KnowledgeRetrievalSource,
  type SelectedKnowledgeSource
} from "../src/modules/agents/knowledge-retrieval.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(__dirname, "../../..");
config({ path: resolve(repositoryRoot, ".env") });

const packagePath = process.argv.slice(2).find((argument) => argument !== "--")?.trim();
if (!packagePath) {
  throw new Error("Informe o caminho do pacote: pnpm test:jev-villefer-package-live -- /caminho/agente.json");
}

const apiKey = process.env.JEV_API_KEY?.trim();
if (!apiKey) {
  throw new Error("Defina JEV_API_KEY no .env antes de executar este teste.");
}

const rawPackage = JSON.parse(await readFile(resolve(packagePath), "utf8")) as unknown;
const agentPackage = agentPackageSchema.parse(rawPackage);
const variables = resolveVariables(agentPackage);
const renderedPrompt = renderTemplate(agentPackage.agent.systemPrompt, variables);
if (/{{\s*[a-zA-Z0-9_]+\s*}}/.test(renderedPrompt)) {
  throw new Error("O prompt do pacote ainda tem variáveis não resolvidas.");
}

const sources = agentPackage.knowledge.map((source) => ({
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

const client = createJevReplyPreflight({
  apiKey,
  model: process.env.JEV_MODEL?.trim() || "jev-latest",
  fetchImpl: async (url, init) => {
    const response = await fetch(url, init);
    if (debugJev) {
      const request = JSON.parse(String(init?.body)) as {
        state?: {
          currentMessage?: { body?: string };
          approvedKnowledge?: Array<{ title?: string; content?: string }>;
          candidateReply?: string;
        };
      };
      const responseBody = await response.clone().json().catch(() => null);
      console.error(JSON.stringify({
        kind: "jev_wire_debug",
        call: activeJevCall,
        request: {
          currentMessage: request.state?.currentMessage?.body,
          candidateReply: request.state?.candidateReply,
          approvedKnowledge: request.state?.approvedKnowledge?.map((source) => ({
            title: source.title,
            characters: source.content?.length ?? 0
          }))
        },
        response: responseBody
      }));
    }
    if (!response.ok) {
      console.error(JSON.stringify({
        kind: "jev_api_error",
        status: response.status,
        body: (await response.clone().text()).slice(0, 4_000)
      }));
    }
    return response;
  }
});

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
    name: "barra chata de linha de estoque não confirma saldo",
    body: "Preciso de 10 barras chatas de 1/4 x 1 polegada. Vocês têm para retirada?",
    history: [["cliente", "Preciso de 10 barras chatas de 1/4 x 1 polegada. Vocês têm para retirada?"]],
    expected: {
      outcome: "continue",
      conversationStage: "new_quote",
      commercialPath: "stock",
      nextAction: "answer_current_request",
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

let failures = 0;
console.log(JSON.stringify({
  kind: "package",
  package: agentPackage.metadata.name,
  packageKey: agentPackage.metadata.key,
  knowledgeSources: agentPackage.knowledge.length,
  confirmedKnowledgeSources: agentPackage.knowledge.filter((source) => source.approvalStatus === "confirmed").length,
  behavioralKnowledgeSources: agentPackage.knowledge.filter((source) => source.approvalStatus === "behavioral").length,
  promptCharacters: renderedPrompt.length,
  promptSentToJev: false,
  note: "O prompt é usado pelo GPT no runtime; o JEV recebe somente histórico e conhecimento selecionado."
}));

const evaluatedCases = new Map<string, { input: AgentReplyPreflightInput; result: AgentReplyPreflightResult }>();
for (const testCase of cases) {
  const input = buildInput(testCase.body, testCase.history);
  const selection = selectRelevantKnowledge({
    latestMessage: testCase.body,
    conversationHistory: formatHistory(testCase.history),
    instruction: null,
    taxonomy: agentPackage.agent.knowledgeTaxonomy,
    sources
  });
  input.selectedKnowledge = selection.selected.map((source) => ({ title: source.title, content: source.content }));

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

if (!client.audit) throw new Error("A auditoria JEV não foi configurada.");

const originalBarCase = evaluatedCases.get("barra chata fora da faixa e material pendente fica sob consulta");
const stockBarCase = evaluatedCases.get("barra chata de linha de estoque não confirma saldo");
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
    name: "aceita condição de encomenda respaldada para inox",
    input: inoxCase.input,
    plan: planOf(inoxCase.result, { commercialPath: "made_to_order", nextAction: "state_made_to_order_conditions" }),
    candidateReply: "Tubos de inox são sob encomenda e o pedido mínimo é de 300 kg. Essas condições atendem sua necessidade?",
    expected: "send"
  },
  {
    name: "bloqueia prazo e pagamento inventados para encomenda",
    input: inoxCase.input,
    plan: planOf(inoxCase.result, { commercialPath: "made_to_order", nextAction: "state_made_to_order_conditions" }),
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
  const passed = result.outcome === testCase.expected;
  failures += passed ? 0 : 1;
  console.log(JSON.stringify({ kind: "audit", name: testCase.name, passed, expected: testCase.expected, result }));
}

if (failures > 0) {
  throw new Error(`${failures} cenário(s) não tiveram a decisão esperada. Revise as saídas antes de alterar o agente.`);
}

console.log("JEV Villefer package check aprovado. Nenhuma mensagem foi enviada, nenhum GPT foi chamado e nenhum dado foi gravado.");

function buildInput(body: string, entries: ConversationEntry[]): AgentReplyPreflightInput {
  return {
    currentMessage: { id: "current", body, type: "text" },
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
