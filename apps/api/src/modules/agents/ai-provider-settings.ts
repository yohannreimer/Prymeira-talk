import type { Prisma } from "@prisma/client";

const OPENAI_COMPATIBLE_PROVIDER = "openai_compatible";

interface IntegrationConfigRecord {
  mode: string;
  settings: Prisma.JsonValue;
}

export type OpenAiCompatibleSettings =
  | { active: false; reason: "not_configured" | "simulated" | "incomplete" }
  | { active: true; baseUrl: string; apiKey: string; chatModel: string };

export interface AiProviderSettingsPrismaLike {
  integrationConfig: {
    findUnique(args: unknown): Promise<IntegrationConfigRecord | null>;
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

function stripTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

export async function resolveOpenAiCompatibleSettings(
  prisma: AiProviderSettingsPrismaLike,
  input: { workspaceId: string }
): Promise<OpenAiCompatibleSettings> {
  const config = await prisma.integrationConfig.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: input.workspaceId,
        provider: OPENAI_COMPATIBLE_PROVIDER
      }
    }
  });

  if (!config) {
    return { active: false, reason: "not_configured" };
  }

  if (config.mode !== "real") {
    return { active: false, reason: "simulated" };
  }

  if (!isSettingsRecord(config.settings)) {
    return { active: false, reason: "incomplete" };
  }

  const baseUrl = getStringSetting(config.settings, "baseUrl");
  const apiKey = getStringSetting(config.settings, "apiKey");
  const chatModel = getStringSetting(config.settings, "chatModel");
  const normalizedBaseUrl = baseUrl ? stripTrailingSlashes(baseUrl) : null;

  if (!normalizedBaseUrl || !apiKey || !chatModel) {
    return { active: false, reason: "incomplete" };
  }

  return {
    active: true,
    baseUrl: normalizedBaseUrl,
    apiKey,
    chatModel
  };
}
