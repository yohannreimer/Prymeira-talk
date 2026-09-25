import { describe, expect, it, vi } from "vitest";
import { createOpenAiAgentImprovementRuleWriter } from "./openai-agent-improvement.js";

const improvement = {
  workspaceId: "workspace-1",
  kind: "not_sold" as const,
  customerMessage: "Quanto tá uma barra de 10mm 12m? Barra pra viga baldrame. 10mm.",
  humanReply: "Construção civil não trabalhamos.",
  proposedContent: "Quando uma consulta futura corresponder ao mesmo item, informe que não trabalhamos.",
  clarificationAnswers: { scope: "exato", exceptions: "nenhuma" },
  clarificationQuestions: {
    scope: "A decisão vale para todas as medidas, espessuras, acabamentos e furações do item solicitado?",
    exceptions: "Quais produtos parecidos vocês ainda comercializam?"
  }
};

describe("createOpenAiAgentImprovementRuleWriter", () => {
  it("drafts a reviewable rule with the workspace's configured OpenAI provider", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          settings: { baseUrl: "https://api.openai.com/v1", apiKey: "test-only", chatModel: "gpt-5.6" }
        })
      }
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        title: "Barras para viga baldrame não comercializadas",
        content: "Não comercializamos barras para viga baldrame nas medidas, espessuras, acabamentos e furações confirmadas. Para outros itens de construção civil, encaminhe ao comercial. Não informe preço nem disponibilidade."
      }) } }]
    })));
    const writer = createOpenAiAgentImprovementRuleWriter({ prisma, fetchImpl });

    await expect(writer.write(improvement)).resolves.toEqual({
      title: "Barras para viga baldrame não comercializadas",
      content: "Não comercializamos barras para viga baldrame nas medidas, espessuras, acabamentos e furações confirmadas. Para outros itens de construção civil, encaminhe ao comercial. Não informe preço nem disponibilidade."
    });
    const [url, request] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe("gpt-5.6");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toContain("exato");
    expect(body.messages[1].content).toContain("A decisão vale para todas as medidas");
    expect(body.messages[0].content).toContain("não amplie");
  });

  it("uses GPT-6 reasoning parameters when drafting an improvement", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          settings: { baseUrl: "https://api.openai.com/v1", apiKey: "test-only", chatModel: "gpt-6-luna" }
        })
      }
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        title: "Barras para viga baldrame não comercializadas",
        content: "Não comercializamos barras para viga baldrame nas medidas confirmadas pelo time. Informe a recusa ao cliente sem prometer preço, estoque ou alternativa. Encaminhe outros itens ao comercial."
      }) } }]
    })));
    await createOpenAiAgentImprovementRuleWriter({ prisma, fetchImpl }).write(improvement);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none", max_completion_tokens: 2_048 });
    expect(body).not.toHaveProperty("temperature");
  });

  it("leaves the existing review flow available when OpenAI is not configured", async () => {
    const prisma = { integrationConfig: { findUnique: vi.fn().mockResolvedValue(null) } };
    const fetchImpl = vi.fn<typeof fetch>();
    const writer = createOpenAiAgentImprovementRuleWriter({ prisma, fetchImpl });

    await expect(writer.write(improvement)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an empty or incomplete draft", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          settings: { baseUrl: "https://api.openai.com/v1", apiKey: "test-only", chatModel: "gpt-test" }
        })
      }
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{}" } }]
    })));
    const writer = createOpenAiAgentImprovementRuleWriter({ prisma, fetchImpl });

    await expect(writer.write(improvement)).rejects.toThrow("OPENAI_AGENT_IMPROVEMENT_DRAFT_INVALID");
  });
});
