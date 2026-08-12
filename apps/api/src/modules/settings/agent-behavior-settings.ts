export const DEFAULT_AGENT_REPLY_WAIT_SECONDS = 40;
export const MAX_AGENT_REPLY_WAIT_SECONDS = 300;

export interface AgentBehaviorSettings {
  agentReplyWaitSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidReplyWaitSeconds(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_AGENT_REPLY_WAIT_SECONDS;
}

export function readAgentBehaviorSettings(limits: unknown): AgentBehaviorSettings {
  const root = isRecord(limits) ? limits : {};
  const agentBehavior = isRecord(root.agentBehavior) ? root.agentBehavior : {};
  const replyWaitSeconds = agentBehavior.replyWaitSeconds;

  return {
    agentReplyWaitSeconds: isValidReplyWaitSeconds(replyWaitSeconds)
      ? replyWaitSeconds
      : DEFAULT_AGENT_REPLY_WAIT_SECONDS
  };
}

export function writeAgentBehaviorSettings(
  limits: unknown,
  behavior: AgentBehaviorSettings
): Record<string, unknown> {
  const root = isRecord(limits) ? limits : {};
  const agentBehavior = isRecord(root.agentBehavior) ? root.agentBehavior : {};

  return {
    ...root,
    agentBehavior: {
      ...agentBehavior,
      replyWaitSeconds: behavior.agentReplyWaitSeconds
    }
  };
}
