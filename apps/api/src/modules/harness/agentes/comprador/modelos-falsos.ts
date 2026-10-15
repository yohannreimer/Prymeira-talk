import { createScriptedModel, toolCall, type ModelClient, type ModelRequest } from "../../core/model.js";
import { parseBRNumber } from "../../core/dinheiro.js";

/**
 * Deterministic stand-ins for the reader and the writer, so the buyer's process (moves, record, review,
 * simulator) runs in CI without a model or a key. They understand only the phrasing the scripted
 * scenarios use; the real evaluation runs with a real model through `scripts/harness-simular.ts`.
 */
export function createFakeComprador(): { leitor: ModelClient; escritor: ModelClient } {
  return { leitor: createScriptedModel("leitor-falso", fakeRead), escritor: createScriptedModel("escritor-falso", fakeWrite) };
}

function lastUserText(request: ModelRequest) {
  const user = [...request.messages].reverse().find((message) => message.role === "user");
  return user && "content" in user && typeof user.content === "string" ? user.content : "";
}

function price(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match ? parseBRNumber(match[1]) : null;
}

function fakeRead(request: ModelRequest) {
  if (request.messages.some((message) => message.role === "tool")) return { content: null, toolCalls: [] };
  const all = lastUserText(request);
  const message = all.slice(all.lastIndexOf("Última mensagem do contato:") + "Última mensagem do contato:".length).trim();
  const lower = message.toLowerCase();
  const calls = [];

  const itens = [
    ...(price(lower, /cadeira[^\d]{0,40}?(\d[\d.,]*)/) !== null ? [{ itemId: "cadeira", precoUnitario: price(lower, /cadeira[^\d]{0,40}?(\d[\d.,]*)/)! }] : []),
    ...(price(lower, /mesa(?: 1,40)?[^\d]{0,40}?(\d[\d.,]*)/) !== null && !/mesa mant[eé]m/.test(lower) ? [{ itemId: "mesa", precoUnitario: price(lower, /mesa(?: 1,40)?[^\d]{0,40}?(\d[\d.,]*)/)! }] : [])
  ];
  const freteGratis = /frete gr[aá]tis/.test(lower);
  const frete = freteGratis ? 0 : price(lower, /frete[^\d]{0,40}?(\d[\d.,]*)/);
  const prazo = lower.match(/entrega (?:em )?(\d+ dias(?: [úu]teis)?)/)?.[1] ?? null;
  const pagamento = lower.match(/(boleto \d+ ?d(?:ias)?|pix[^,.]*)/)?.[1] ?? null;
  const validade = lower.match(/validade (\d+ dias)/)?.[1] ?? null;
  if (itens.length || frete !== null || prazo || pagamento || validade) {
    calls.push(toolCall("registrar_proposta", {
      ...(itens.length ? { itens } : {}),
      ...(frete !== null ? { frete } : {}),
      ...(prazo ? { prazoEntrega: prazo } : {}),
      ...(pagamento ? { pagamento } : {}),
      ...(validade ? { validade } : {})
    }));
  }
  const nome = message.match(/aqui [ée] (?:a|o) ([A-ZÀ-Ú][a-zà-ú]+)/)?.[1];
  if (nome) calls.push(toolCall("registrar_contato", { nome }));
  if (/quanto voc[eê]s t[eê]m/.test(lower)) calls.push(toolCall("registrar_pergunta", { tipo: "valor_concorrente", pergunta: message }));
  if (/[ée] da .+\?|[ée] deles\?/.test(lower)) calls.push(toolCall("registrar_pergunta", { tipo: "nome_concorrente", pergunta: message }));
  if (/precisa ser com bra[cç]o/.test(lower)) calls.push(toolCall("registrar_pergunta", { tipo: "sobre_pedido", pergunta: "A cadeira precisa ser com braço?" }));
  if (/n[aã]o consigo (baixar|mexer)/.test(lower)) calls.push(toolCall("registrar_sem_desconto", {}));
  return { content: null, toolCalls: calls };
}

function fakeWrite(request: ModelRequest) {
  const system = request.messages[0]?.role === "system" ? request.messages[0].content : "";
  const jogada = system.slice(system.indexOf("# Jogada agora") + "# Jogada agora".length, system.indexOf("Escreva como gente")).trim();
  const parts: string[] = [];
  if (/não passamos dados de outros fornecedores/.test(jogada)) parts.push("Não passamos dados de outros fornecedores, tá?");
  if (/Responda às perguntas do fornecedor/.test(jogada) && /bra[cç]o/i.test(jogada)) parts.push("Sim, com braço regulável e na cor preta.");

  if (/primeira mensagem/.test(jogada)) parts.push("Boa tarde! Aqui é da Construtora Horizonte. Precisamos de 20 cadeiras giratórias com braço e 5 mesas 1,40 carvalho, entrega no CEP 89201-000 até 10/11. Pode me passar preço unitário, frete, prazo e pagamento? Recebemos orçamentos até 20/10.");
  else if (/perguntou explicitamente quanto temos/.test(jogada)) {
    const valor = jogada.match(/fecha em (R\$ [\d.,]+)/)?.[1] ?? "";
    parts.push(`A melhor proposta que temos hoje fecha em ${valor} no total, com frete. Consegue chegar nesse valor?`);
  } else if (/Faça a choradinha/.test(jogada)) {
    parts.push(`Obrigado pela proposta!${/Já temos proposta mais em conta/.test(jogada) ? " Já temos uma proposta mais em conta." : ""} Consegue melhorar um pouco esse valor? A empresa vai fechar com quem fizer a melhor condição.`);
  } else if (/cobrança/.test(jogada)) parts.push("Oi! Conseguiu ver nosso pedido de orçamento?");
  else if (/não vai cotar/.test(jogada)) parts.push("Obrigado pelo retorno!");
  else if (/o que falta:/.test(jogada)) parts.push(`Obrigado! Me passa também ${jogada.match(/o que falta: ([^.]+)/)?.[1] ?? "o restante"}?`);
  else if (/Ainda não temos orçamento/.test(jogada)) parts.push("Me passa o orçamento quando puder?");
  else if (/apresentar a proposta para a empresa|apresentar para a empresa/.test(jogada)) parts.push("Obrigado! Vou apresentar para a empresa e retorno até 20/10.");
  else if (/esperando a resposta sobre melhorar o preço/.test(jogada)) parts.push("Consegue melhorar o valor?");
  else if (/fica no aguardo/.test(jogada)) parts.push("Combinado, fico no aguardo.");
  else if (/já foi para a empresa avaliar/.test(jogada)) parts.push("Obrigado, vai junto para a empresa avaliar.");
  else parts.push("Certo, obrigado!");
  return { content: null, toolCalls: [toolCall("responder", { texto: parts.join(" ") })] };
}
