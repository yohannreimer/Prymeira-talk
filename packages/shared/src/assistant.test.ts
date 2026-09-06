import { describe, expect, it } from 'vitest';
import { assistantChannelSettingsSchema, assistantSendSchema } from './assistant.js';
describe('assistant contracts',()=>{
  const id='00000000-0000-4000-8000-000000000101';
  it('defaults to disabled',()=>expect(assistantChannelSettingsSchema.parse({})).toEqual({mode:'disabled',agentId:null}));
  it('requires an agent when enabled',()=>expect(assistantChannelSettingsSchema.safeParse({mode:'automatic'}).success).toBe(false));
  it('rejects extra settings',()=>expect(assistantChannelSettingsSchema.safeParse({mode:'disabled',apiKey:'secret'}).success).toBe(false));
  it('accepts a bounded explicit send',()=>expect(assistantSendSchema.safeParse({suggestionId:id,body:'Resposta',requestKey:id,reviewedContextKey:'abc'}).success).toBe(true));
  it('rejects empty sends and foreign actor fields',()=>{
    expect(assistantSendSchema.safeParse({suggestionId:id,body:' ',requestKey:id,reviewedContextKey:'abc'}).success).toBe(false);
    expect(assistantSendSchema.safeParse({suggestionId:id,body:'ok',requestKey:id,reviewedContextKey:'abc',userId:id}).success).toBe(false);
  });
});
