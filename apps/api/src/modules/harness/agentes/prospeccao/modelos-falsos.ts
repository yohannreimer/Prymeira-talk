import { createScriptedModel, toolCall, type ModelClient, type ModelRequest } from "../../core/model.js";

/**
 * Deterministic reader and writer for João, so the process (triage, moves, record, review) runs in CI
 * without a model. They understand only the phrasing of the offline scenarios.
 */
export function createFakeProspeccao(): { leitor: ModelClient; escritor: ModelClient } {
  return { leitor: createScriptedModel("leitor-falso", fakeRead), escritor: createScriptedModel("escritor-falso", fakeWrite) };
}

const text = (request: ModelRequest, role: "system" | "user") => {
  const found = [...request.messages].reverse().find((message) => message.role === role);
  return found && "content" in found && typeof found.content === "string" ? found.content : "";
};

function fakeRead(request: ModelRequest) {
  if (request.messages.some((message) => message.role === "tool")) return { content: null, toolCalls: [] };
  const all = text(request, "user");
  const message = all.slice(all.lastIndexOf("Última mensagem do contato:") + "Última mensagem do contato:".length).trim();
  const lower = message.toLowerCase();
  const calls = [];
  const nome = message.match(/(?:aqui [ée] (?:a|o)|sou (?:a|o)|meu nome [ée]) ([A-ZÁÉÍÓÚ][a-záéíóúãõç]+)/)?.[1] ?? null;
  const naoDecide = /recep[cç][aã]o|n[aã]o [ée] comigo|quem cuida/.test(lower);
  if (nome || naoDecide) calls.push(toolCall("registrar_contato", { nome, papel: naoDecide ? "nao_decisor" : "decisor" }));
  const indicado = message.match(/fal(?:a|e) com (?:o|a) ([A-ZÁÉÍÓÚ][a-záéíóúãõç]+)/)?.[1];
  if (indicado) calls.push(toolCall("registrar_indicado", { nome: indicado, contato: message.match(/\(?\d{2}\)?\s?9?\d{4}-?\d{4}/)?.[0] ?? null }));
  if (/no momento n[aã]o|n[aã]o precisamos|estamos bem/.test(lower)) calls.push(toolCall("registrar_interesse", { nivel: "sem_interesse" }));
  if (/pessoas atendendo|atendendo (a )?loja/.test(lower)) calls.push(toolCall("registrar_dor", { texto: message.slice(0, 200) }));
  if (/pode ser|topo|vamos marcar|amanh[aã] [àa]s/.test(lower)) calls.push(toolCall("registrar_aceite", { detalhe: message.slice(0, 120) }));
  if (message.includes("?")) calls.push(toolCall("registrar_pergunta_do_lead", { texto: message.slice(0, 200) }));
  return { content: null, toolCalls: calls };
}

function fakeWrite(request: ModelRequest) {
  const system = text(request, "system");
  const jogada = system.slice(system.indexOf("# Jogada agora")).toLowerCase();
  const nome = system.match(/Contato: ([A-ZÁÉÍÓÚ][a-záéíóúãõç]+) \(/)?.[1];
  let reply = "Faz sentido uma conversa rápida de 15 minutos essa semana pra eu te mostrar como funciona?";
  if (jogada.includes("agradeça em uma frase")) reply = `Obrigado pela atenção${nome ? `, ${nome}` : ""}! Fico à disposição se precisarem.`;
  else if (jogada.includes("peça com educação o nome")) reply = "Entendi, obrigado! Pode me passar o nome ou o WhatsApp do responsável?";
  else if (jogada.includes("confirme o próximo passo")) reply = "Combinado! Nosso time te chama no horário que você escolheu.";
  else if (jogada.includes("diga que vai falar com")) reply = "Valeu pela indicação! Vou falar com ele.";
  else if (jogada.includes("primeiro responda")) reply = "Somos uma empresa que coloca IA pra responder o WhatsApp na hora. Topa uma call rápida de 15 minutos essa semana?";
  else if (jogada.includes("retome a conversa")) reply = jogada.includes("última retomada") ? "Ainda faz sentido a gente conversar sobre isso?" : "Oi! Conseguiu pensar no atendimento pelo WhatsApp que comentei?";
  return { content: null, toolCalls: [toolCall("responder", { texto: reply })] };
}
