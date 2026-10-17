import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { resolveOpenAiCompatibleSettings } from "../src/modules/agents/ai-provider-settings.js";

// Probes whether the provider accepts native tools together with reasoning on /v1/responses
// (on /v1/chat/completions it refuses, which is why the reader falls back to JSON mode).
// Sends nothing to any contact. Same endpoint settings as harness-simular.ts:
//   HARNESS_WORKSPACE_ID=<id>  or  HARNESS_BASE_URL + HARNESS_API_KEY   [HARNESS_MODEL] [HARNESS_REASONING=low]

config();

const tool = {
  name: "registrar_pergunta",
  description: "Registra uma pergunta de negócio do cliente.",
  parameters: {
    type: "object",
    properties: { pergunta: { type: "string" } },
    required: ["pergunta"],
    additionalProperties: false
  }
};
const instructions = "Você lê a mensagem do cliente e registra cada pergunta de negócio com a ferramenta. Papo social não é pergunta.";
const mensagem = "Dia quente aqui hoje! Vocês entregam em Joinville e aceitam boleto?";

async function main() {
  const { baseUrl, apiKey, model } = await resolveEndpoint();
  const effort = process.env.HARNESS_REASONING ?? "low";
  const base = baseUrl.replace(/\/+$/, "");
  const post = async (path: string, body: unknown) => {
    const started = Date.now();
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, ms: Date.now() - started, json: safeJson(text), text };
  };
  console.log(`Modelo: ${model} · raciocínio: ${effort} · endpoint: ${base}\n`);

  // 1. The known refusal, to confirm the baseline.
  const chat = await post("/chat/completions", {
    model,
    reasoning_effort: effort,
    messages: [{ role: "system", content: instructions }, { role: "user", content: mensagem }],
    tools: [{ type: "function", function: tool }]
  });
  console.log(`1) chat/completions com ferramentas + raciocínio: HTTP ${chat.status} (${chat.ms} ms)`);
  if (chat.status >= 400) console.log(`   ${chat.text.slice(0, 300)}`);

  // 2. Responses API, same request.
  const first = await post("/responses", {
    model,
    reasoning: { effort },
    instructions,
    input: [{ role: "user", content: mensagem }],
    tools: [{ type: "function", ...tool, strict: true }],
    store: false,
    include: ["reasoning.encrypted_content"]
  });
  console.log(`\n2) responses com ferramentas + raciocínio: HTTP ${first.status} (${first.ms} ms)`);
  if (first.status >= 400) {
    console.log(`   ${first.text.slice(0, 500)}`);
    console.log("\nResultado: a Responses API NÃO aceita ferramentas com raciocínio aqui. O leitor continua no modo JSON.");
    return;
  }
  const output: any[] = first.json?.output ?? [];
  const calls = output.filter((item) => item.type === "function_call");
  for (const call of calls) console.log(`   chamou ${call.name}(${call.arguments})`);
  if (!calls.length) console.log(`   não chamou ferramenta. Saída: ${JSON.stringify(output).slice(0, 400)}`);

  // 3. Second round: send the tool results back and see that the loop continues (stateless, store=false).
  if (calls.length) {
    const second = await post("/responses", {
      model,
      reasoning: { effort },
      instructions,
      input: [
        { role: "user", content: mensagem },
        ...output,
        ...calls.map((call) => ({ type: "function_call_output", call_id: call.call_id, output: "Registrada." }))
      ],
      tools: [{ type: "function", ...tool, strict: true }],
      store: false,
      include: ["reasoning.encrypted_content"]
    });
    console.log(`\n3) segunda rodada com o resultado das ferramentas: HTTP ${second.status} (${second.ms} ms)`);
    if (second.status >= 400) console.log(`   ${second.text.slice(0, 500)}`);
    else console.log(`   ${JSON.stringify(second.json?.output ?? []).slice(0, 400)}`);
  }

  const ok = calls.length > 0;
  console.log(`\nResultado: ${ok ? "a Responses API aceita ferramentas com raciocínio. Dá para tirar o leitor do modo JSON." : "respondeu, mas sem chamar ferramenta; repetir algumas vezes antes de concluir."}`);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function resolveEndpoint(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  if (process.env.HARNESS_BASE_URL && process.env.HARNESS_API_KEY) {
    return { baseUrl: process.env.HARNESS_BASE_URL, apiKey: process.env.HARNESS_API_KEY, model: process.env.HARNESS_MODEL ?? "gpt-6-luna" };
  }
  const workspaceId = process.env.HARNESS_WORKSPACE_ID;
  if (!workspaceId) throw new Error("Defina HARNESS_WORKSPACE_ID, ou HARNESS_BASE_URL + HARNESS_API_KEY.");
  const prisma = new PrismaClient();
  try {
    const settings = await resolveOpenAiCompatibleSettings(prisma, { workspaceId });
    if (!settings.active) throw new Error(`O workspace não tem provedor de IA ativo (${settings.reason}).`);
    return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: process.env.HARNESS_MODEL ?? settings.chatModel };
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
