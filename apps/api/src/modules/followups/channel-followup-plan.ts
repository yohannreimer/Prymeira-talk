import { channelFollowupConfigSchema, type ChannelFollowupConfig } from "@prymeira-talk/shared";
import { resolveEffectiveFollowupConfig } from "../agents/effective-followup-config.js";
import { addBusinessMinutes, nextBusinessStart } from "./business-time.js";

export const DEFAULT_CHANNEL_FOLLOWUP_CONFIG: ChannelFollowupConfig = {
  enabled: true,
  timeZone: "America/Sao_Paulo",
  businessDays: [1, 2, 3, 4, 5],
  businessHours: { start: "08:00", end: "18:00" },
  steps: [20, 40, 60, 360, 1440, 4320].map((afterMinutes) => ({ afterMinutes })),
  humanCommercialDelivery: "review"
};

const FALLBACK_INSTRUCTION =
  "Releia a conversa e só retome uma pendência real, com uma mensagem breve e diferente das tentativas anteriores. Se houve recusa, resolução ou encerramento, não acompanhe.";

export function resolveFollowupPlan(agentBehavior: unknown, channelConfig: unknown) {
  const agent = resolveEffectiveFollowupConfig(agentBehavior);
  const channel = channelFollowupConfigSchema.safeParse(channelConfig);
  if (channel.success) {
    if (!channel.data.enabled) return null;
    return {
      ...channel.data,
      mode: "elapsed_between_steps" as const,
      steps: channel.data.steps.map((step, index) => ({
        afterMinutes: step.afterMinutes,
        instruction: agent?.steps[index]?.instruction ?? FALLBACK_INSTRUCTION
      }))
    };
  }
  if (!agent) return null;
  return {
    timeZone: agent.timeZone,
    businessDays: agent.businessDays,
    businessHours: agent.businessHours,
    humanCommercialDelivery: "review" as const,
    mode: "business_cumulative" as const,
    steps: agent.steps.map((step) => ({
      afterMinutes: step.afterBusinessMinutes,
      instruction: step.instruction
    }))
  };
}

export function calculateFollowupDueAt(
  from: Date,
  minutes: number,
  plan: NonNullable<ReturnType<typeof resolveFollowupPlan>>
) {
  if (plan.mode === "elapsed_between_steps") {
    const elapsedAt = new Date(from.getTime() + minutes * 60_000);
    return nextBusinessStart({
      from: elapsedAt,
      timeZone: plan.timeZone,
      businessDays: plan.businessDays,
      businessHours: plan.businessHours
    });
  }
  return addBusinessMinutes({
    from,
    minutes,
    timeZone: plan.timeZone,
    businessDays: plan.businessDays,
    businessHours: plan.businessHours
  });
}
