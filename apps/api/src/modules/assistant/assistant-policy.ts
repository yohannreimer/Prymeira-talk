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
  return mode!==undefined&&mode!=='disabled';
}
export function canGenerateSuggestion(input:{mode:AssistantMode;control:string;trigger:'inbound'|'manual'}):boolean{
  return input.control==='agent_allowed'&&input.mode!=='disabled'&&(input.mode==='automatic'||input.trigger==='manual');
}
export function nextSuggestionAt(firstPendingMs:number,lastInboundMs:number):number{
  return Math.min(lastInboundMs+2000,firstPendingMs+10000);
}
