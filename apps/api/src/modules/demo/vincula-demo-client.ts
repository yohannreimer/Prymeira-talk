import { z } from "zod";

export interface VinculaDemoResetResult {
  ok: true;
  workspaceId: "70000000-0000-4000-8000-000000000001";
  sales: 5;
  companies: 9;
  contacts: 9;
  deals: 6;
  notes: 6;
}

const vinculaDemoResetResultSchema: z.ZodType<VinculaDemoResetResult> = z.object({
  ok: z.literal(true),
  workspaceId: z.literal("70000000-0000-4000-8000-000000000001"),
  sales: z.literal(5),
  companies: z.literal(9),
  contacts: z.literal(9),
  deals: z.literal(6),
  notes: z.literal(6)
}).strict();

export interface VinculaDemoClient {
  reset(): Promise<VinculaDemoResetResult>;
}

interface CreateVinculaDemoClientOptions {
  resetUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export function createVinculaDemoClient(
  options: CreateVinculaDemoClientOptions
): VinculaDemoClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async reset() {
      if (!options.resetUrl || !options.token) {
        throw new Error("Vincula demo reset is not configured.");
      }

      const response = await fetchImpl(options.resetUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(5_000)
      });

      if (!response.ok) {
        throw new Error(`Vincula demo reset failed with status ${response.status}.`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Vincula demo reset returned invalid JSON.");
      }

      const result = vinculaDemoResetResultSchema.safeParse(payload);
      if (!result.success) {
        const details = result.error.issues
          .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
          .join("; ");
        throw new Error(`Vincula demo reset returned an invalid payload: ${details}`);
      }

      return result.data;
    }
  };
}
