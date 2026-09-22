import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJevReplyPreflight,
  type AgentReplyPreflightInput,
  type AgentReplyPreflightPlan
} from "../src/modules/agents/jev-reply-preflight.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../..", ".env") });

const apiKey = process.env.JEV_API_KEY?.trim();
if (!apiKey) {
  throw new Error("Defina JEV_API_KEY no .env antes de executar este teste.");
}

const client = createJevReplyPreflight({
  apiKey,
  model: process.env.JEV_MODEL?.trim() || "jev-latest"
});

type LiveCase = {
  name: string;
  input: AgentReplyPreflightInput;
  expected: (result: Awaited<ReturnType<typeof client.evaluate>>) => boolean;
};

const baseInput = (body: string, history: AgentReplyPreflightInput["conversationMessages"], knowledge: AgentReplyPreflightInput["selectedKnowledge"] = []): AgentReplyPreflightInput => ({
  currentMessage: { id: "current", body, type: "text" },
  conversationMessages: history,
  selectedKnowledge: knowledge
});

const history = (entries: Array<["cliente" | "atendente", string]>) =>
  entries.map(([label, body], index) => ({
    id: `message-${index + 1}`,
    label,
    body,
    type: "text",
    createdAt: `2026-09-21T12:${String(index).padStart(2, "0")}:00.000Z`
  }));

const cases: LiveCase[] = [
  {
    name: "agradecimento sem pendência não gera resposta",
    input: baseInput(
      "Obrigado!",
      history([
        ["cliente", "Qual é o horário de atendimento?"],
        ["atendente", "Atendemos de segunda a sexta, das 8h às 18h."],
        ["cliente", "Obrigado!"]
      ])
    ),
    expected: (result) => result.outcome === "silence"
  },
  {
    name: "dado técnico solicitado mantém o atendimento ativo",
    input: baseInput(
      "2 mm.",
      history([
        ["cliente", "Preciso de uma cotação de chapa."],
        ["atendente", "Claro. Qual espessura você precisa?"],
        ["cliente", "2 mm."]
      ])
    ),
    expected: (result) => result.outcome === "continue" && result.plan.conversationStage === "qualification"
  },
  {
    name: "item aprovado como encomenda não é tratado como estoque",
    input: baseInput(
      "Vocês fazem grade especial para máquina?",
      history([["cliente", "Vocês fazem grade especial para máquina?"]]),
      [{ title: "Grades especiais", content: "Grades especiais são exclusivamente sob encomenda. Não afirmar disponibilidade imediata." }]
    ),
    expected: (result) => result.outcome === "continue" && result.plan.commercialPath === "made_to_order"
  },
  {
    name: "produto sem evidência comercial permanece ambíguo",
    input: baseInput(
      "Tem barra quadrada de 12 mm para retirar hoje?",
      history([["cliente", "Tem barra quadrada de 12 mm para retirar hoje?"]]),
      [{ title: "Catálogo aprovado", content: "Tubos redondos são itens de linha. Este material não traz informações sobre barras quadradas." }]
    ),
    expected: (result) => result.outcome === "continue" && result.plan.commercialPath === "ambiguous"
  }
];

let failures = 0;
for (const testCase of cases) {
  const result = await client.evaluate(testCase.input);
  const passed = testCase.expected(result);
  failures += passed ? 0 : 1;
  console.log(JSON.stringify({ kind: "preflight", name: testCase.name, passed, result }));
}

const ambiguousPlan: AgentReplyPreflightPlan = {
  conversationStage: "new_quote",
  commercialPath: "ambiguous",
  nextAction: "handoff"
};
const auditInput = baseInput(
  "Tem barra quadrada de 12 mm para retirar hoje?",
  history([["cliente", "Tem barra quadrada de 12 mm para retirar hoje?"]]),
  [{ title: "Catálogo aprovado", content: "Tubos redondos são itens de linha. Este material não traz informações sobre barras quadradas." }]
);

const audits = [
  {
    name: "auditoria bloqueia promessa de estoque e prazo sem evidência",
    candidateReply: "Temos em estoque e você consegue retirar hoje.",
    expected: "handoff"
  },
  {
    name: "auditoria aceita encaminhamento diante de incerteza comercial",
    candidateReply: "Vou encaminhar sua solicitação ao vendedor para confirmar disponibilidade e retirada.",
    expected: "send"
  }
] as const;

if (!client.audit) throw new Error("A auditoria JEV não foi configurada.");
for (const testCase of audits) {
  const result = await client.audit({ ...auditInput, plan: ambiguousPlan, candidateReply: testCase.candidateReply });
  const passed = result.outcome === testCase.expected;
  failures += passed ? 0 : 1;
  console.log(JSON.stringify({ kind: "audit", name: testCase.name, passed, result }));
}

if (failures > 0) {
  throw new Error(`${failures} cenário(s) não tiveram a decisão esperada. Revise as saídas antes de alterar o agente.`);
}

console.log("JEV live check aprovado. Nenhuma mensagem foi enviada e nenhum GPT foi chamado.");
