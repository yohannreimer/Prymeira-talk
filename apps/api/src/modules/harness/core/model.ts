import { usesOpenAiReasoningParameters } from "../../agents/openai-reasoning-model.js";

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ModelRequest = {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** "required" asks the model to call at least one tool. */
  toolChoice?: "auto" | "required";
};

export type ModelResponse = { content: string | null; toolCalls: ToolCall[] };

/** The only thing the harness needs from a model. Any provider fits behind it. */
export type ModelClient = {
  id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * "tools": native function calling. "json": the tools are described in the prompt and the model answers
   * with a JSON object, for providers without function calling. "responses": native function calling on
   * /v1/responses, the only route where gpt-6-luna takes tools and a reasoning effort together (verified
   * against the provider on 16/10/2026). All three produce the same ModelResponse.
   */
  mode?: "tools" | "json" | "responses";
  /** Reasoning models (gpt-6-luna and similar) take this instead of a temperature; they default to "none". */
  reasoningEffort?: "none" | "low" | "medium" | "high";
  temperature?: number;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createOpenAiCompatibleModel(options: OpenAiCompatibleOptions): ModelClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const mode = options.mode ?? "tools";
  // Reasoning models (gpt-6-luna) reject a temperature; they get an effort instead, "none" unless asked.
  const reasoningEffort = options.reasoningEffort ?? (usesOpenAiReasoningParameters(options.model) ? "none" : undefined);

  if (mode === "responses") return createResponsesModel(options, fetchImpl, baseUrl, reasoningEffort);

  return {
    id: `${options.model}${mode === "json" ? " (json)" : ""}`,
    async complete(request) {
      const useTools = mode === "tools" && request.tools && request.tools.length > 0;
      const messages = useTools ? request.messages.map(toWireMessage) : toJsonModeMessages(request);
      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        ...(useTools
          ? {
              tools: request.tools!.map((tool) => ({ type: "function", function: tool })),
              tool_choice: request.toolChoice ?? "auto"
            }
          : mode === "json" && request.tools?.length ? { response_format: { type: "json_object" } } : {}),
        ...(reasoningEffort
          ? { reasoning_effort: reasoningEffort, max_completion_tokens: options.maxCompletionTokens ?? 4096 }
          : { temperature: options.temperature ?? 0.3, ...(options.maxCompletionTokens ? { max_tokens: options.maxCompletionTokens } : {}) })
      };
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`MODEL_HTTP_${response.status}: ${detail.slice(0, 300)}`);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      };
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error("MODEL_EMPTY_RESPONSE");
      if (useTools) {
        return {
          content: message.content ?? null,
          toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }))
        };
      }
      return request.tools?.length ? parseJsonModeResponse(message.content ?? "") : { content: message.content ?? null, toolCalls: [] };
    }
  };
}

/** Stateless calls (store: false): the whole conversation goes in `input` each time, as on chat/completions. */
function createResponsesModel(options: OpenAiCompatibleOptions, fetchImpl: typeof fetch, baseUrl: string, reasoningEffort: OpenAiCompatibleOptions["reasoningEffort"]): ModelClient {
  return {
    id: `${options.model} (responses)`,
    async complete(request) {
      const tools = request.tools ?? [];
      const body: Record<string, unknown> = {
        model: options.model,
        input: request.messages.flatMap(toResponsesItems),
        store: false,
        ...(tools.length
          ? { tools: tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })), tool_choice: request.toolChoice ?? "auto" }
          : {}),
        ...(reasoningEffort
          ? { reasoning: { effort: reasoningEffort }, max_output_tokens: options.maxCompletionTokens ?? 4096 }
          : { temperature: options.temperature ?? 0.3, ...(options.maxCompletionTokens ? { max_output_tokens: options.maxCompletionTokens } : {}) })
      };
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`MODEL_HTTP_${response.status}: ${detail.slice(0, 300)}`);
      }
      const payload = (await response.json()) as {
        output?: Array<
          | { type: "message"; content?: Array<{ type: string; text?: string }> }
          | { type: "function_call"; call_id: string; name: string; arguments: string }
          | { type: string }
        >;
      };
      if (!Array.isArray(payload.output)) throw new Error("MODEL_EMPTY_RESPONSE");
      const texts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const item of payload.output) {
        if (item.type === "message" && "content" in item) {
          for (const part of item.content ?? []) if (part.type === "output_text" && part.text) texts.push(part.text);
        } else if (item.type === "function_call" && "call_id" in item) {
          toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
        }
      }
      return { content: texts.length ? texts.join("") : null, toolCalls };
    }
  };
}

function toResponsesItems(message: ChatMessage): Array<Record<string, unknown>> {
  if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  if (message.role === "assistant") {
    return [
      ...(message.content ? [{ role: "assistant", content: message.content }] : []),
      ...(message.toolCalls ?? []).map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments }))
    ];
  }
  return [{ role: message.role, content: message.content }];
}

function toWireMessage(message: ChatMessage) {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls?.length
        ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
        : {})
    };
  }
  return message;
}

/** Without native tools the conversation is flattened: calls and results become plain text the model can read. */
function toJsonModeMessages(request: ModelRequest) {
  const tools = request.tools ?? [];
  const messages = request.messages.map((message) => {
    if (message.role === "tool") return { role: "user", content: `Resultado de ${message.name}: ${message.content}` };
    if (message.role === "assistant") {
      const calls = message.toolCalls?.map((call) => `${call.name}(${call.arguments})`).join("; ");
      return { role: "assistant", content: calls ? `Chamei: ${calls}` : message.content ?? "" };
    }
    return { role: message.role, content: message.content };
  });
  if (tools.length === 0) return messages;
  const toolText = [
    "Você responde SOMENTE com um objeto JSON no formato {\"chamadas\": [{\"ferramenta\": \"nome\", \"argumentos\": {...}}]}.",
    request.toolChoice === "required" ? "Faça pelo menos uma chamada." : "A lista pode ser vazia se não houver nada a fazer.",
    "Ferramentas disponíveis:",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description} Argumentos (JSON Schema): ${JSON.stringify(tool.parameters)}`)
  ].join("\n");
  return [...messages, { role: "system", content: toolText }];
}

export function parseJsonModeResponse(content: string): ModelResponse {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return { content, toolCalls: [] };
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { chamadas?: Array<{ ferramenta?: unknown; argumentos?: unknown }> };
    const calls = Array.isArray(parsed.chamadas) ? parsed.chamadas : [];
    return {
      content: null,
      toolCalls: calls.flatMap((call, index) =>
        typeof call.ferramenta === "string"
          ? [{ id: `json_${index}`, name: call.ferramenta, arguments: JSON.stringify(call.argumentos ?? {}) }]
          : [])
    };
  } catch {
    return { content, toolCalls: [] };
  }
}

/** A model whose answers are written by a function: used by tests and by scripted simulator personas. */
export function createScriptedModel(id: string, answer: (request: ModelRequest, callIndex: number) => ModelResponse | Promise<ModelResponse>): ModelClient {
  let calls = 0;
  return { id, complete: async (request) => answer(request, calls++) };
}

export function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}
