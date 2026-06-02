import type { Prisma, PrismaClient } from "@prisma/client";
import { createEvolutionClient, type EvolutionClient } from "../evolution/evolution.client.js";
import { createMetaClient, type MetaClient } from "./meta.client.js";

const META_CLOUD_PROVIDER = "meta_cloud";
const DEFAULT_GRAPH_API_BASE_URL = "https://graph.facebook.com/v23.0";

type IntegrationConfigFindUniqueArgs = Parameters<PrismaClient["integrationConfig"]["findUnique"]>[0];

interface IntegrationConfigRecord {
  mode: string;
  status: string;
  settings: Prisma.JsonValue;
}

export interface MetaRuntimeInput {
  workspaceId: string;
  fetch?: typeof fetch;
  graphApiBaseUrl?: string;
}

export type MetaRuntime =
  | {
      active: false;
      connectionMode: "direct";
      client: null;
      wabaId: null;
      phoneNumberId: null;
      webhookVerifyToken: null;
      appSecret: null;
      evolutionClient: null;
      evolutionInstanceName: null;
    }
  | {
      active: true;
      connectionMode: "direct";
      client: MetaClient;
      wabaId: string;
      phoneNumberId: string;
      webhookVerifyToken: string | null;
      appSecret: string | null;
      evolutionClient: null;
      evolutionInstanceName: null;
    }
  | {
      active: true;
      connectionMode: "evolution_official";
      client: null;
      wabaId: null;
      phoneNumberId: null;
      webhookVerifyToken: null;
      appSecret: null;
      evolutionClient: EvolutionClient;
      evolutionInstanceName: string | null;
    };

export interface MetaRuntimePrismaLike {
  integrationConfig: {
    findUnique(args: IntegrationConfigFindUniqueArgs): Promise<IntegrationConfigRecord | null>;
  };
}

function inactiveRuntime(): MetaRuntime {
  return {
    active: false,
    connectionMode: "direct",
    client: null,
    wabaId: null,
    phoneNumberId: null,
    webhookVerifyToken: null,
    appSecret: null,
    evolutionClient: null,
    evolutionInstanceName: null
  };
}

function isSettingsRecord(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringSetting(settings: Prisma.JsonObject, key: string) {
  const value = settings[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveMetaRuntime(
  prisma: MetaRuntimePrismaLike,
  input: MetaRuntimeInput
): Promise<MetaRuntime> {
  const config = await prisma.integrationConfig.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: input.workspaceId,
        provider: META_CLOUD_PROVIDER
      }
    }
  });

  if (!config || config.mode !== "real" || !isSettingsRecord(config.settings)) {
    return inactiveRuntime();
  }

  const enabled = config.settings.enabled === true;
  const connectionMode = config.settings.connectionMode === "evolution_official"
    ? "evolution_official"
    : "direct";

  if (!enabled) {
    return inactiveRuntime();
  }

  if (connectionMode === "evolution_official") {
    const evolutionBaseUrl = getStringSetting(config.settings, "evolutionBaseUrl");
    const evolutionApiKey = getStringSetting(config.settings, "evolutionApiKey");
    const evolutionInstanceName = getStringSetting(config.settings, "evolutionInstanceName");

    if (!evolutionBaseUrl || !evolutionApiKey) {
      return inactiveRuntime();
    }

    return {
      active: true,
      connectionMode,
      client: null,
      wabaId: null,
      phoneNumberId: null,
      webhookVerifyToken: null,
      appSecret: null,
      evolutionClient: createEvolutionClient({
        baseUrl: evolutionBaseUrl,
        apiKey: evolutionApiKey,
        fetch: input.fetch
      }),
      evolutionInstanceName
    };
  }

  const wabaId = getStringSetting(config.settings, "wabaId");
  const phoneNumberId = getStringSetting(config.settings, "phoneNumberId");
  const accessToken = getStringSetting(config.settings, "accessToken");

  if (!wabaId || !phoneNumberId || !accessToken) {
    return inactiveRuntime();
  }

  return {
    active: true,
    connectionMode,
    client: createMetaClient({
      graphApiBaseUrl: input.graphApiBaseUrl ?? DEFAULT_GRAPH_API_BASE_URL,
      accessToken,
      fetch: input.fetch
    }),
    wabaId,
    phoneNumberId,
    webhookVerifyToken: getStringSetting(config.settings, "webhookVerifyToken"),
    appSecret: getStringSetting(config.settings, "appSecret"),
    evolutionClient: null,
    evolutionInstanceName: null
  };
}
