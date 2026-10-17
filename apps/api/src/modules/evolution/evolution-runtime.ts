import { createEvolutionClient, type EvolutionClient } from "./evolution.client.js";

export interface EvolutionRuntimeInput {
  mode: "simulated" | "real";
  /** Another physical provider is configured for real messaging. */
  messagingEnabled?: boolean;
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
  /** Physical Evolution control configuration, independent of routed messaging. */
  providerConfigured?: boolean;
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

  const messagingMode = input.mode === "real" || input.messagingEnabled ? "real" : "simulated";
  return {
    mode: messagingMode,
    providerConfigured: realClient !== null,
    webhookSecret: input.webhookSecret,
    publicWebhookUrl: (workspaceId) => webhookUrl(input.publicTalkUrl, workspaceId),
    localWebhookUrl: (workspaceId) => webhookUrl(input.localTalkUrl, workspaceId),
    client: realClient ?? (messagingMode === "real" ? createUnavailableEvolutionClient() : null)
  };
}

/** Lets a real WAHA router start without pretending that Evolution is simulated.
 * Every method fails before I/O, so an attempted send is provably not dispatched. */
export function createUnavailableEvolutionClient(): EvolutionClient {
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error('Evolution is not configured; this operation requires an available physical provider.'), { code: 'EVOLUTION_UNAVAILABLE', statusCode: 503 });
  };
  return {
    createInstance: unavailable, connectInstance: unavailable, logoutInstance: unavailable,
    getConnectionState: unavailable, getInstanceIdentity: unavailable, setWebhook: unavailable,
    sendText: unavailable, sendMedia: unavailable, sendAudio: unavailable, sendContact: unavailable,
    sendTemplate: unavailable, listTemplates: unavailable, fetchProfilePicture: unavailable,
    fetchMedia: unavailable, getGroupInfo: unavailable, deleteMessageForEveryone: unavailable,
    editMessage: unavailable, checkWhatsappNumbersAvailability: unavailable
  };
}
