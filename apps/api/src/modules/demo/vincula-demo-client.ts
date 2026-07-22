export interface VinculaDemoResetResult {
  ok: boolean;
  workspaceId?: string;
  sales?: number;
  users?: number;
  companies?: number;
  contacts?: number;
  deals?: number;
  notes?: number;
}

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

      return (await response.json()) as VinculaDemoResetResult;
    }
  };
}
