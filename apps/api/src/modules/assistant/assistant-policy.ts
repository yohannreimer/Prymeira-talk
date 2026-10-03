import {assistantChannelSettingsSchema,type AssistantChannelSettings,type AssistantMode} from '@prymeira-talk/shared';

export function readAssistantSettings(config:unknown):AssistantChannelSettings{
  const value=typeof config==='object'&&config!==null&&!Array.isArray(config)?(config as Record<string,unknown>).assistant:undefined;
  const parsed=assistantChannelSettingsSchema.safeParse(value??{});
  return parsed.success?parsed.data:{mode:'disabled',agentId:null};
}
export function blocksAutonomousAgent(config:unknown):boolean{
  const assistant=typeof config==='object'&&config!==null?(config as Record<string,unknown>).assistant:null;
  const mode=typeof assistant==='object'&&assistant!==null?(assistant as Record<string,unknown>).mode:undefined;
  // An enabled but incomplete setting must never fall back to autonomous sending.
  if (mode === undefined || mode === 'disabled') return false;
  if (mode === 'automatic_with_agent') return !assistantChannelSettingsSchema.safeParse(assistant).success;
  return true;
}
export function resolveConversationAssistant(input:{
  aiControlStatus:string;
  channel:{encryptedConfig:unknown};
  activeAgentSession?:{agentId:string;handoffReason?:string|null;handoffActionCompletedAt?:Date|null}|null;
}){
  const configured=readAssistantSettings(input.channel.encryptedConfig);
  const session=input.activeAgentSession;
  const handoffPending=Boolean(session?.handoffReason&&!session.handoffActionCompletedAt);
  const humanSupport=input.aiControlStatus==='human_controlled'&&!handoffPending&&Boolean(configured.mode!=='disabled'||session?.agentId);
  const settings=humanSupport&&configured.mode==='disabled'&&session?.agentId
    ? {mode:'automatic' as const,agentId:session.agentId}
    : configured;
  return {settings,humanSupport};
}
export function canGenerateSuggestion(input:{mode:AssistantMode;control:string;trigger:'inbound'|'manual'|'continuation';humanSupport?:boolean}):boolean{
  const allowedControl=input.control==='agent_allowed'||(input.control==='human_controlled'&&input.humanSupport===true);
  return allowedControl&&input.mode!=='disabled'&&(input.mode==='automatic'||input.mode==='automatic_with_agent'||input.trigger==='manual');
}
/** Waits until the customer stops writing: 20 s after their last message, with no ceiling. A burst of
 * messages is answered once, after the last one, instead of a suggestion per message that is then discarded. */
export const SUGGESTION_QUIET_MS = 20_000;
export function nextSuggestionAt(_firstPendingMs:number,lastInboundMs:number):number{
  return lastInboundMs+SUGGESTION_QUIET_MS;
}
