import { agentFollowupConfigSchema } from "@prymeira-talk/shared";
import { villeferV1Package } from "./villefer-v1-package.js";

export const VILLEFER_V1_PACKAGE_KEY = "villefer-commercial-qualifier-v1";

export function resolveEffectiveFollowupConfig(behaviorConfig: unknown) {
  const behavior = asRecord(behaviorConfig);
  const packageKey = readString(asRecord(behavior?.packageMetadata)?.key);
  const parsed = agentFollowupConfigSchema.safeParse(behavior?.followup);

  if (packageKey !== VILLEFER_V1_PACKAGE_KEY) {
    return parsed.success ? parsed.data : null;
  }

  const approved = villeferV1Package.agent.followup;
  const configured = parsed.success ? parsed.data : approved;
  return agentFollowupConfigSchema.parse({
    ...configured,
    timeZone: approved.timeZone,
    businessDays: approved.businessDays,
    businessHours: approved.businessHours,
    closeAfterBusinessMinutes: approved.closeAfterBusinessMinutes,
    steps: approved.steps.map((approvedStep, index) => ({
      ...approvedStep,
      instruction: configured.steps[index]?.instruction ?? approvedStep.instruction
    }))
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
