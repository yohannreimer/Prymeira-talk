import { createEvolutionClient, type EvolutionClient } from "./evolution.client.js";

export interface EvolutionRuntimeInput {
  mode: "simulated" | "real";
  publicTalkUrl: string;
  localTalkUrl: string;
  apiBaseUrl?: string;
  apiKey?: string;
  webhookSecret: string;
  fetch?: typeof fetch;
}

export interface EvolutionRuntime {
  mode: "simulated" | "real";
  webhookSecret: string;
  publicWebhookUrl(workspaceId: string): string;
  localWebhookUrl(workspaceId: string): string;
  client: EvolutionClient | null;
}

function webhookUrl(baseUrl: string, workspaceId: string) {
  return `${baseUrl.replace(/\/$/, "")}/webhooks/evolution/${encodeURIComponent(workspaceId)}`;
}

export function createEvolutionRuntime(input: EvolutionRuntimeInput): EvolutionRuntime {
  const realClient =
    input.mode === "real" && input.apiBaseUrl && input.apiKey
      ? createEvolutionClient({
          baseUrl: input.apiBaseUrl,
          apiKey: input.apiKey,
          fetch: input.fetch
        })
      : null;

  return {
    mode: realClient ? "real" : "simulated",
    webhookSecret: input.webhookSecret,
    publicWebhookUrl: (workspaceId) => webhookUrl(input.publicTalkUrl, workspaceId),
    localWebhookUrl: (workspaceId) => webhookUrl(input.localTalkUrl, workspaceId),
    client: realClient
  };
}
