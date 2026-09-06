import { z } from 'zod';

export const assistantModeSchema=z.enum(['disabled','automatic','on_demand']);
export type AssistantMode=z.infer<typeof assistantModeSchema>;
export const assistantChannelSettingsSchema=z.object({
  mode:assistantModeSchema.default('disabled'),
  agentId:z.string().uuid().nullable().default(null)
}).strict().refine(s=>s.mode==='disabled'||Boolean(s.agentId),{message:'Escolha um agente para habilitar o modo assistido.',path:['agentId']});
export type AssistantChannelSettings=z.infer<typeof assistantChannelSettingsSchema>;
export const assistantSendSchema=z.object({
  suggestionId:z.string().uuid(),body:z.string().trim().min(1).max(4000),
  requestKey:z.string().uuid(),reviewedContextKey:z.string().min(1).max(128),
  edited:z.boolean().optional()
}).strict();
export type AssistantSendInput=z.infer<typeof assistantSendSchema>;
export const assistantInstructionSchema=z.object({instruction:z.string().trim().max(2000).optional()}).strict();
export const assistantDraftStatusSchema=z.enum(['pending','generating','ready','stale','paused','failed','sent']);
export type AssistantDraftStatus=z.infer<typeof assistantDraftStatusSchema>;
export type AssistantSuggestionDto={
  id:string;conversationId:string;agentId:string;revision:number;contextKey:string;
  body:string;instruction:string|null;createdAt:string;warnings:string[];
  actorName:string|null;finalBody:string|null;messageId:string|null;sendStatus:string|null;
};
export type AssistantConversationDto={
  currentContextKey:string|null;
  settings:AssistantChannelSettings;status:AssistantDraftStatus;humanControlled:boolean;
  suggestion:AssistantSuggestionDto|null;history:AssistantSuggestionDto[];
  agentName:string|null;error:string|null;
};
