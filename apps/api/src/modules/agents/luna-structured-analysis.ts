import { z } from "zod";
import { resolveOpenAiCompatibleSettings, type AiProviderSettingsPrismaLike } from "./ai-provider-settings.js";

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string() })
  })).min(1)
});

export function createLunaStructuredAnalysis(input: {
  prisma: AiProviderSettingsPrismaLike;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  return async function analyze<T>(request: {
    workspaceId: string;
    systemPrompt: string;
    data: unknown;
    schema: z.ZodType<T>;
  }): Promise<T> {
    const provider = await resolveOpenAiCompatibleSettings(input.prisma, {
      workspaceId: request.workspaceId
    });
    if (!provider.active) throw new Error(`LUNA_ANALYSIS_UNAVAILABLE_${provider.reason}`);
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        response_format: { type: "json_object" },
        reasoning_effort: "low",
        max_completion_tokens: 2_048,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: JSON.stringify(request.data) }
        ]
      })
    });
    if (!response.ok) throw new Error(`LUNA_ANALYSIS_HTTP_${response.status}`);
    const completion = completionSchema.safeParse(await response.json());
    if (!completion.success ||
      (completion.data.choices[0].finish_reason && completion.data.choices[0].finish_reason !== "stop")) {
      throw new Error("LUNA_ANALYSIS_RESPONSE_INVALID");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.data.choices[0].message.content);
    } catch {
      throw new Error("LUNA_ANALYSIS_RESPONSE_INVALID");
    }
    const validated = request.schema.safeParse(parsed);
    if (!validated.success) throw new Error("LUNA_ANALYSIS_RESPONSE_INVALID");
    return validated.data;
  };
}
