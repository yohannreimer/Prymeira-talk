import { describe, expect, it } from "vitest";
import {
  evaluateAgentLoopGuard,
  normalizeLoopComparisonText,
  type AgentLoopMessage
} from "./agent-loop-guard.js";

const now = new Date("2026-08-12T17:20:00.000Z");

function inbound(body: string, secondsAgo: number): AgentLoopMessage {
  return { direction: "inbound", type: "text", body, metadata: {}, createdAt: new Date(now.getTime() - secondsAgo * 1_000) };
}

function ai(body: string, secondsAgo: number): AgentLoopMessage {
  return { direction: "outbound", type: "text", body, metadata: { source: "ai_agent" }, createdAt: new Date(now.getTime() - secondsAgo * 1_000) };
}

describe("agent loop guard", () => {
  it.each([
    ['Por favor, digite a opção desejada:\n1 - Vendas\n2 - Suporte\n0 - Finalizar', 'automated_menu'],
    ['Por favor, escolha: 1 - Vendas; 2 - Suporte', 'automated_menu'],
    ['Enquanto você aguarda o atendimento, veja nosso catálogo.', 'waiting_reception'],
    ['Só um minuto que o pessoal já irá atendê-lo, tá bem?', 'waiting_reception'],
    ['Por favor, digite o número da opção desejada para prosseguir com seu atendimento 1 - Vendas 2 - Suporte Técnico 0 - Finalizar', 'automated_menu'],
    ['Opção inválida! Favor digite uma das opções acima.', 'automated_menu'],
    ['Seja bem-vindo ao sistema de atendimento do Grupo JAV.', 'automated_menu'],
    ['Tecville Soluções Industriais agradece seu contato. Como podemos ajudar? Enquanto você aguarda o atendimento, que tal dar uma olhadinha em nossas plataformas digitais?', 'waiting_reception'],
    ['Olá, Sou a Tatiani, em que posso lhe ajudar? As mensagens recebidas pelo whats são respondidas por ordem de recebimento. Por isso, envie sua mensagem e aguarde que responderemos o mais breve possivel! Horário de atendimento das 08:00 às 12:00', 'waiting_reception'],
    ['Agradecemos seu contato. O horário de atendimento é de segunda a sexta-feira das 7:30 às 12:00. Responderemos assim que possível.', 'waiting_reception']
  ])('silently pauses explicit reception only with opt-in: %s', (text, guard) => {
    const messages = [inbound(text, 1)];
    expect(evaluateAgentLoopGuard({ messages, now })).toEqual({ triggered: false });
    expect(evaluateAgentLoopGuard({ messages, now, stopOnAutomatedReception: true })).toMatchObject({ triggered: true, guard });
  });
  it.each(['Boa tarde, como posso ajudar?', 'Podes informar seu CNPJ?', 'Sabrina é a secretária da Carina e do Fabio.'])('does not mistake a human response for reception: %s', text => {
    expect(evaluateAgentLoopGuard({ messages: [inbound(text, 1)], now, stopOnAutomatedReception: true })).toEqual({ triggered: false });
  });
  it('uses a later human reply instead of the older menu', () => {
    expect(evaluateAgentLoopGuard({ messages: [inbound('Digite a opção:\n1 - Vendas\n2 - Suporte', 30), inbound('Sou a Ana, cuido dessa parte. Como funciona?', 1)], now, stopOnAutomatedReception: true })).toEqual({ triggered: false });
  });
  it("normalizes insignificant differences", () => {
    expect(normalizeLoopComparisonText("  NÃO   entendi!!! ")).toBe("não entendi");
  });

  it("detects the observed repeated automated exchange", () => {
    const repeated = "Não entendi, escolha uma das opções acima, por favor.";
    const messages = [
      inbound(repeated, 55), ai("Essa mensagem parece ser de outra instituição.", 45),
      inbound(repeated, 35), ai("A Villefer atende produtos siderúrgicos.", 25),
      inbound(repeated, 15)
    ];
    expect(evaluateAgentLoopGuard({ messages, now })).toEqual({
      triggered: true,
      guard: "repeated_inbound",
      inboundCount: 3,
      aiOutboundCount: 2
    });
  });

  it("detects the latest repeated inbound when Prisma returns newest messages first", () => {
    const repeated = "Não entendi, escolha uma das opções acima, por favor.";
    const messages = [
      inbound(repeated, 15), ai("A Villefer atende produtos siderúrgicos.", 25),
      inbound(repeated, 35), ai("Essa mensagem parece ser de outra instituição.", 45),
      inbound(repeated, 55), inbound("Mensagem anterior diferente", 65)
    ];
    expect(evaluateAgentLoopGuard({ messages, now })).toEqual({
      triggered: true,
      guard: "repeated_inbound",
      inboundCount: 3,
      aiOutboundCount: 2
    });
  });

  it("does not trigger for two duplicates", () => {
    const messages = [inbound("Repita", 40), ai("Como posso ajudar?", 30), inbound("Repita", 20)];
    expect(evaluateAgentLoopGuard({ messages, now })).toEqual({ triggered: false });
  });

  it("ignores duplicates outside the two minute window", () => {
    const messages = [
      inbound("Repita", 150), ai("Um", 140), inbound("Repita", 130),
      ai("Dois", 20), inbound("Repita", 10)
    ];
    expect(evaluateAgentLoopGuard({ messages, now })).toEqual({ triggered: false });
  });

  it("does not trigger for a customer-only burst", () => {
    expect(evaluateAgentLoopGuard({
      messages: Array.from({ length: 12 }, (_, index) => inbound(`Mensagem ${index}`, 60 - index)),
      now
    })).toEqual({ triggered: false });
  });

  it("does not count human outbound messages as AI", () => {
    const human: AgentLoopMessage = {
      direction: "outbound", type: "text", body: "Resposta humana", metadata: {}, createdAt: new Date(now.getTime() - 20_000)
    };
    expect(evaluateAgentLoopGuard({
      messages: [inbound("Repita", 50), human, inbound("Repita", 30), human, inbound("Repita", 10)],
      now
    })).toEqual({ triggered: false });
  });

  it("detects ten rapid alternating messages with five on each side", () => {
    const messages: AgentLoopMessage[] = [];
    for (let index = 0; index < 5; index += 1) {
      messages.push(inbound(`Entrada ${index}`, 50 - index * 10));
      messages.push(ai(`Saída ${index}`, 45 - index * 10));
    }
    expect(evaluateAgentLoopGuard({ messages, now })).toEqual({
      triggered: true,
      guard: "rapid_exchange",
      inboundCount: 5,
      aiOutboundCount: 5
    });
  });

  it("allows an ordinary alternating conversation below the threshold", () => {
    expect(evaluateAgentLoopGuard({
      messages: [inbound("Oi", 50), ai("Olá", 40), inbound("Quero chapa", 30), ai("Qual medida?", 20)],
      now
    })).toEqual({ triggered: false });
  });
});
