import { z } from "zod";

/**
 * JEV (typesafe.ai "systemone") answers questions about a state: "noul" questions return a probability
 * that the answer is yes, "choice" questions return one of the given options. It never writes text,
 * which makes it the right tool for triage and review, not for replies.
 */
export type JevQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type JevAnswer = { type: "noul"; noul: number } | { type: "choice"; choice: string };

export type JevClient = {
  ask(state: Record<string, unknown>, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>>;
};

const answerSchema = z.union([
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal("choice"), choice: z.string() })
]);
const responseSchema = z.object({ answers: z.record(z.string(), answerSchema) });

export function createJevClient(options: { apiKey: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): JevClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async ask(state, questions) {
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: options.model ?? "jev-latest", questions })
      });
      if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`);
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("JEV_RESPONSE_INVALID");
      for (const name of Object.keys(questions)) {
        if (!parsed.data.answers[name]) throw new Error(`JEV_MISSING_ANSWER_${name}`);
      }
      return parsed.data.answers;
    }
  };
}

export function noul(answer: JevAnswer | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}

export function choice(answer: JevAnswer | undefined): string | null {
  return answer?.type === "choice" ? answer.choice : null;
}
