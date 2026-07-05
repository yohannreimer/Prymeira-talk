import { describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleAgentProvider,
  createSimulatedAgentProvider,
  parseAgentOutput
} from "./provider-gateway.js";

describe("parseAgentOutput", () => {
  it("parses valid structured agent output", () => {
    const output = parseAgentOutput({
      confidence: 0.82,
      reply: "Posso ajudar com isso.",
      actions: [{ type: "add_tag", tagName: "onboarding" }],
      handoff: { required: false, reason: null }
    });

    expect(output).toEqual({
      confidence: 0.82,
      reply: "Posso ajudar com isso.",
      actions: [{ type: "add_tag", tagName: "onboarding" }],
      handoff: { required: false, reason: null }
    });
  });

  it("allows nullable or omitted replies and defaults actions", () => {
    expect(
      parseAgentOutput({
        confidence: 0.7,
        reply: null,
        handoff: { required: false, reason: null }
      })
    ).toEqual({
      confidence: 0.7,
      reply: null,
      actions: [],
      handoff: { required: false, reason: null }
    });

    expect(
      parseAgentOutput({
        confidence: 0.7,
        handoff: { required: false, reason: null }
      })
    ).toEqual({
      confidence: 0.7,
      actions: [],
      handoff: { required: false, reason: null }
    });

    expect(
      parseAgentOutput({
        reply: "Sou a Maria, secretária comercial da Prymeira."
      })
    ).toEqual({
      confidence: 0.72,
      reply: "Sou a Maria, secretária comercial da Prymeira.",
      actions: [],
      handoff: { required: false, reason: null }
    });
  });

  it("throws a stable error for malformed output", () => {
    expect(() =>
      parseAgentOutput({
        reply: "",
        confidence: 2,
        handoff: { required: "no", reason: null },
        actions: ["change_priority"]
      })
    ).toThrow("Invalid agent output.");
  });

  it("throws a stable error when an action is missing a type", () => {
    expect(() =>
      parseAgentOutput({
        confidence: 0.7,
        handoff: { required: false, reason: null },
        actions: [{ tagName: "Lead" }]
      })
    ).toThrow("Invalid agent output.");
  });

  it("normalizes reply actions into a sendable reply", () => {
    const output = parseAgentOutput({
      confidence: 0.82,
      actions: [{ type: "reply", message: "Olá, tudo certo?" }],
      handoff: { required: false, reason: null }
    });

    expect(output).toEqual({
      confidence: 0.82,
      reply: "Olá, tudo certo?",
      actions: [{ type: "send_message", message: "Olá, tudo certo?" }],
      handoff: { required: false, reason: null }
    });
  });

  it("normalizes common model action aliases", () => {
    const output = parseAgentOutput({
      confidence: 0.82,
      reply: "Posso te mostrar os planos.",
      actions: [
        { type: "respond_message", message: "Posso te mostrar os planos." },
        { type: "offer_handoff_to_sales", message: "Quer falar com o comercial?" },
        { type: "add_contact_tag", tag: "Lead quente" },
        { type: "create_note", note: "Cliente perguntou sobre planos." }
      ],
      handoff: { required: false, reason: null }
    });

    expect(output.actions).toEqual([
      { type: "send_message", message: "Posso te mostrar os planos." },
      { type: "send_message", message: "Quer falar com o comercial?" },
      { type: "add_tag", tag: "Lead quente" },
      { type: "create_internal_note", note: "Cliente perguntou sobre planos." }
    ]);
  });
});

describe("createSimulatedAgentProvider", () => {
  it.each(["nao sei", "não sei", "irritado"])(
    "returns low confidence and handoff for %s input",
    async (text) => {
      const provider = createSimulatedAgentProvider();

      const output = await provider.generate({
        model: "simulated",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: text,
        context: {}
      });

      expect(output.confidence).toBeLessThan(0.55);
      expect(output.handoff.required).toBe(true);
      expect(output.actions).toContainEqual(
        expect.objectContaining({ type: "request_handoff" })
      );
    }
  );

  it("checks relevant message body context when simulating low confidence", async () => {
    const provider = createSimulatedAgentProvider();

    const output = await provider.generate({
      model: "simulated",
      systemPrompt: "Atenda clientes da Prymeira Talk.",
      userPrompt: "Pode analisar a conversa?",
      context: { messageBody: "O cliente esta irritado com o atraso." }
    });

    expect(output.handoff.required).toBe(true);
  });

  it("returns a normal reply and add_tag action for answerable text", async () => {
    const provider = createSimulatedAgentProvider();

    const output = await provider.generate({
      model: "simulated",
      systemPrompt: "Atenda clientes da Prymeira Talk.",
      userPrompt: "Qual o horário de atendimento?",
      context: {}
    });

    expect(output).toEqual(
      expect.objectContaining({
        confidence: 0.84,
        handoff: { required: false, reason: null }
      })
    );
    expect(output.reply).toContain("Prymeira Talk");
    expect(output.actions).toEqual([{ type: "add_tag", tagName: "Atendido pela IA" }]);
  });
});

describe("createOpenAiCompatibleAgentProvider", () => {
  it("posts to the chat completions endpoint with authorization and JSON headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 0.91,
                  reply: "Claro, posso ajudar.",
                  actions: [],
                  handoff: { required: false, reason: null }
                })
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example/v1///",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await provider.generate({
      model: "runtime-model",
      systemPrompt: "Atenda clientes da Prymeira Talk.",
      userPrompt: "Olá",
      context: { conversationHistory: ["mensagem anterior"] }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://provider.example/v1/chat/completions");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer secret-api-key",
          "Content-Type": "application/json"
        }
      })
    );
  });

  it("sends the configured chat model, JSON response format, and prompt payload", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 0.87,
                  reply: "Resposta estruturada.",
                  actions: [],
                  handoff: { required: false, reason: null }
                })
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await provider.generate({
      model: "runtime-model",
      systemPrompt: "Você e o agente oficial.",
      userPrompt: "Qual o prazo?",
      context: { selectedDocuments: [{ title: "Política", body: "Sem prazo definido." }] }
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual(
      expect.objectContaining({
        model: "configured-chat-model",
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    );
    expect(body.model).not.toBe("runtime-model");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Você e o agente oficial.")
      })
    );
    expect(body.messages[0].content).toContain("respond only valid JSON");
    expect(body.messages[0].content).toContain("sources");
    expect(body.messages[1]).toEqual({
      role: "user",
      content: JSON.stringify({
        userPrompt: "Qual o prazo?",
        context: { selectedDocuments: [{ title: "Política", body: "Sem prazo definido." }] }
      })
    });
  });

  it("parses choices[0].message.content as JSON and validates agent output", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 0.74,
                  reply: "Vou verificar com uma pessoa do time.",
                  handoff: { required: true, reason: "Informação insuficiente." },
                  sources: [
                    {
                      id: "doc_1",
                      title: "Documento interno",
                      category: "policy"
                    }
                  ]
                })
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    const output = await provider.generate({
      model: "runtime-model",
      systemPrompt: "Atenda clientes da Prymeira Talk.",
      userPrompt: "Pode garantir esse preço?",
      context: {}
    });

    expect(output).toEqual({
      confidence: 0.74,
      reply: "Vou verificar com uma pessoa do time.",
      actions: [],
      handoff: { required: true, reason: "Informação insuficiente." },
      sources: [
        {
          id: "doc_1",
          title: "Documento interno",
          category: "policy"
        }
      ]
    });
  });

  it("accepts fenced JSON content from the provider", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n{"confidence":0.88,"reply":"Sou a Maria, da Prymeira.","actions":[]}\n```'
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Quem é você?",
        context: {}
      })
    ).resolves.toEqual({
      confidence: 0.88,
      reply: "Sou a Maria, da Prymeira.",
      actions: [],
      handoff: { required: false, reason: null }
    });
  });

  it("falls back to plain text when compatible providers ignore JSON mode", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Sou a Maria, secretária comercial da Prymeira."
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Quem é você?",
        context: {}
      })
    ).resolves.toEqual({
      confidence: 0.62,
      reply: "Sou a Maria, secretária comercial da Prymeira.",
      actions: [],
      handoff: { required: false, reason: null }
    });
  });

  it("normalizes common provider JSON variants into agent output", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 92,
                  answer: "A Prymeira Talk ajuda o atendimento pelo WhatsApp.",
                  actions: ["add_tag"],
                  handoff: false,
                  sources: ["Base Prymeira"]
                })
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Me fale dos produtos da Prymeira.",
        context: {}
      })
    ).resolves.toEqual({
      confidence: 0.92,
      reply: "A Prymeira Talk ajuda o atendimento pelo WhatsApp.",
      actions: [{ type: "add_tag" }],
      handoff: { required: false, reason: null },
      sources: [{ title: "Base Prymeira" }]
    });
  });

  it("unwraps nested provider answer objects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  response: {
                    message: "Sou a Maria, secretária comercial da Prymeira.",
                    confidence: "0.81"
                  },
                  handoff: {
                    required: "false"
                  }
                })
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Quem é você?",
        context: {}
      })
    ).resolves.toEqual({
      confidence: 0.81,
      reply: "Sou a Maria, secretária comercial da Prymeira.",
      actions: [],
      handoff: { required: false, reason: null }
    });
  });

  it("throws a sanitized error when the provider response body is invalid JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error("raw parser detail"))
    } as unknown as Response);
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Olá",
        context: {}
      })
    ).rejects.toThrow("OpenAI-compatible provider returned invalid JSON response.");
  });

  it("throws a sanitized error when the provider response shape is invalid", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }))
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Olá",
        context: {}
      })
    ).rejects.toThrow("OpenAI-compatible provider returned invalid JSON response.");
  });

  it("throws a sanitized error when the provider request fails before a response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("provider-specific network detail"));
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Olá",
        context: {}
      })
    ).rejects.toThrow("OpenAI-compatible provider request failed.");
  });

  it("throws when provider content is not valid structured JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 1.5,
                  reply: "",
                  actions: [{ tagName: "Lead" }],
                  handoff: { required: "no", reason: null }
                })
              }
            }
          ]
        })
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Olá",
        context: {}
      })
    ).rejects.toThrow("Invalid agent output.");
  });

  it.each(["", "  \n\t  "])(
    "throws a clear error when provider content is empty or whitespace",
    async (content) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content
                }
              }
            ]
          })
        )
      );
      const provider = createOpenAiCompatibleAgentProvider({
        baseUrl: "https://provider.example",
        apiKey: "secret-api-key",
        chatModel: "configured-chat-model",
        fetchImpl: fetchMock
      });

      await expect(
        provider.generate({
          model: "runtime-model",
          systemPrompt: "Atenda clientes da Prymeira Talk.",
          userPrompt: "Olá",
          context: {}
        })
      ).rejects.toThrow("OpenAI-compatible provider returned empty content.");
    }
  );

  it("throws on non-OK provider responses with the status in the message", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "quota exceeded" }), { status: 429 })
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "configured-chat-model",
      fetchImpl: fetchMock
    });

    await expect(
      provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Olá",
        context: {}
      })
    ).rejects.toThrow("OpenAI-compatible provider request failed with status 429.");
  });
});
