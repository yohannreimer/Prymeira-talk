import { describe, expect, it } from 'vitest';
import { canGenerateSuggestion, nextSuggestionAt, readAssistantSettings, blocksAutonomousAgent, resolveConversationAssistant } from './assistant-policy.js';

describe('assistant policy', () => {
  it.each(['automatic','on_demand'] as const)('human control blocks %s', mode => {
    expect(canGenerateSuggestion({mode,control:'human_controlled',trigger:'manual'})).toBe(false);
    expect(canGenerateSuggestion({mode,control:'human_controlled',trigger:'inbound'})).toBe(false);
  });
  it('fails closed for unknown control state',()=>expect(canGenerateSuggestion({mode:'automatic',control:'unknown',trigger:'inbound'})).toBe(false));
  it('generates private suggestions for a supported human-controlled conversation',()=>{
    expect(canGenerateSuggestion({mode:'automatic',control:'human_controlled',trigger:'inbound',humanSupport:true})).toBe(true);
    expect(canGenerateSuggestion({mode:'on_demand',control:'human_controlled',trigger:'manual',humanSupport:true})).toBe(true);
    expect(canGenerateSuggestion({mode:'on_demand',control:'human_controlled',trigger:'inbound',humanSupport:true})).toBe(false);
  });
  it('uses the active agent for human support when channel support is disabled',()=>{
    const agentId='00000000-0000-4000-8000-000000000101';
    const input={aiControlStatus:'human_controlled',channel:{encryptedConfig:{}},activeAgentSession:{agentId}};
    expect(resolveConversationAssistant(input)).toEqual({settings:{mode:'automatic',agentId},humanSupport:true});
    expect(resolveConversationAssistant({...input,activeAgentSession:null})).toEqual({settings:{mode:'disabled',agentId:null},humanSupport:false});
    expect(resolveConversationAssistant({...input,aiControlStatus:'agent_allowed'})).toEqual({settings:{mode:'disabled',agentId:null},humanSupport:false});
  });
  it('resumes human support only after the pending handoff action is completed',()=>{
    const agentId='00000000-0000-4000-8000-000000000101';
    const input={aiControlStatus:'human_controlled',channel:{encryptedConfig:{}},activeAgentSession:{agentId,handoffReason:'Needs seller action',handoffActionCompletedAt:null as Date|null}};
    expect(resolveConversationAssistant(input).humanSupport).toBe(false);
    expect(resolveConversationAssistant({...input,activeAgentSession:{...input.activeAgentSession,handoffActionCompletedAt:new Date()}}).humanSupport).toBe(true);
  });
  it('generates inbound only in automatic mode',()=>{
    expect(canGenerateSuggestion({mode:'automatic',control:'agent_allowed',trigger:'inbound'})).toBe(true);
    expect(canGenerateSuggestion({mode:'on_demand',control:'agent_allowed',trigger:'inbound'})).toBe(false);
    expect(canGenerateSuggestion({mode:'on_demand',control:'agent_allowed',trigger:'manual'})).toBe(true);
    expect(canGenerateSuggestion({mode:'disabled',control:'agent_allowed',trigger:'manual'})).toBe(false);
  });
  it('caps the debounce',()=>{
    expect(nextSuggestionAt(1000,1000)).toBe(6000);
    expect(nextSuggestionAt(1000,4000)).toBe(9000);
    expect(nextSuggestionAt(1000,15000)).toBe(11000);
  });
  it.each([null,{}, {assistant:{mode:'automatic'}}, {assistant:{mode:'surprise',agentId:'bad'}}])('legacy or invalid settings stay disabled',config=>{
    expect(readAssistantSettings(config)).toEqual({mode:'disabled',agentId:null});
  });
  it('blocks autonomous agents in either assisted mode',()=>{
    expect(blocksAutonomousAgent({assistant:{mode:'automatic'}})).toBe(true);
    expect(blocksAutonomousAgent({assistant:{mode:'unexpected'}})).toBe(true);
    const agentId='00000000-0000-4000-8000-000000000101';
    expect(blocksAutonomousAgent({assistant:{mode:'automatic',agentId}})).toBe(true);
    expect(blocksAutonomousAgent({assistant:{mode:'on_demand',agentId}})).toBe(true);
    expect(blocksAutonomousAgent({})).toBe(false);
  });
});
