import type { Prisma, PrismaClient } from "@prisma/client";
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
      client: null;
      wabaId: null;
      phoneNumberId: null;
      webhookVerifyToken: null;
    }
  | {
      active: true;
      client: MetaClient;
      wabaId: string;
      phoneNumberId: string;
      webhookVerifyToken: string | null;
    };

export interface MetaRuntimePrismaLike {
  integrationConfig: {
    findUnique(args: IntegrationConfigFindUniqueArgs): Promise<IntegrationConfigRecord | null>;
  };
}

function inactiveRuntime(): MetaRuntime {
  return {
    active: false,
    client: null,
    wabaId: null,
    phoneNumberId: null,
    webhookVerifyToken: null
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
  const wabaId = getStringSetting(config.settings, "wabaId");
  const phoneNumberId = getStringSetting(config.settings, "phoneNumberId");
  const accessToken = getStringSetting(config.settings, "accessToken");

  if (!enabled || !wabaId || !phoneNumberId || !accessToken) {
    return inactiveRuntime();
  }

  return {
    active: true,
    client: createMetaClient({
      graphApiBaseUrl: input.graphApiBaseUrl ?? DEFAULT_GRAPH_API_BASE_URL,
      accessToken,
      fetch: input.fetch
    }),
    wabaId,
    phoneNumberId,
    webhookVerifyToken: getStringSetting(config.settings, "webhookVerifyToken")
  };
}
