import { describe, it, expect, vi } from 'vitest';
import { createAssistantHistoryImporter } from './assistant-history.js';
import type { PrismaClient } from '@prisma/client';
import type { EvolutionHistorySource } from '../evolution/evolution-history.js';

const date = new Date('2026-09-14T12:00:00Z');
function setup() {
  const messages: any[] = [{ id:'anchor', workspaceId:'w', conversationId:'c', providerMessageId:'a', createdAt:date, metadata:{kept:true}, body:'Oi', type:'text', direction:'inbound',mediaUrl:null }];
  const conversation = { id:'c', workspaceId:'w', channelId:'ch', aiControlStatus:'agent_allowed', channel:{ provider:'evolution', providerKey:'Diogo', encryptedConfig:{ assistant:{mode:'automatic',agentId:'00000000-0000-4000-8000-000000000001'},assistantHistory:{days:30} } } };
  const db:any = {
    conversation:{findFirst:vi.fn(async()=>conversation),update:vi.fn()},
    message:{
      findMany:vi.fn(async(args:any)=>args.where.providerMessageId ? messages.filter(m=>args.where.providerMessageId.in.includes(m.providerMessageId)) : messages),
      findFirst:vi.fn(async()=>messages[0]),
      createMany:vi.fn(async({data}:any)=>{ const fresh=data.filter((m:any)=>!messages.some(x=>x.providerMessageId===m.providerMessageId));messages.push(...fresh);return{count:fresh.length}; }),
      updateMany:vi.fn(async({data}:any)=>{messages[0].metadata=data.metadata;return{count:1};})
    },assistantConversationState:{updateMany:vi.fn()},$queryRaw:vi.fn(),
    $transaction:vi.fn(async(fn:any)=>fn(db))
  };
  const source = { load:vi.fn(async()=>[{key:{id:'old',remoteJid:'123@s.whatsapp.net',fromMe:true},messageTimestamp:date.getTime()/1000-86400,message:{conversation:'Já recebemos as medidas.'}}]),media:vi.fn() };
  return {db,source,messages,conversation,run:createAssistantHistoryImporter(db as PrismaClient,source as unknown as EvolutionHistorySource)};
}
describe('context-only history import',()=>{
  it('preflights counts without media calls or database writes',async()=>{const s=setup();const r=await s.run('w','c',{dryRun:true});expect(r).toMatchObject({missing:1});expect(s.source.media).not.toHaveBeenCalled();expect(s.db.message.createMany).not.toHaveBeenCalled();expect(s.db.message.updateMany).not.toHaveBeenCalled();});
  it('preserves historical dates/direction, metadata, and leaves conversation counters untouched',async()=>{
    const s=setup();const result=await s.run('w','c');
    expect(result.inserted).toBe(1);
    expect(s.messages[1]).toMatchObject({direction:'outbound',body:'Já recebemos as medidas.',status:'sent',createdAt:new Date(date.getTime()-86400000),ingestedAt:new Date(date.getTime()-86400000)});
    expect(s.messages[0].metadata.kept).toBe(true);
    expect(s.db.conversation.update).not.toHaveBeenCalled();
    expect(s.db.assistantConversationState.updateMany).not.toHaveBeenCalled();
    expect(s.source.load).toHaveBeenCalledWith(expect.objectContaining({anchorId:'a',to:date,from:new Date(date.getTime()-30*86400000)}));
  });
  it('is idempotent and never re-fetches a completed import',async()=>{
    const s=setup();await s.run('w','c');await s.run('w','c');
    expect(s.source.load).toHaveBeenCalledOnce();expect(s.messages).toHaveLength(2);
  });
  it('does not import for disabled opt-in, another provider or human control',async()=>{
    const s=setup();s.conversation.aiControlStatus='human_controlled';expect((await s.run('w','c')).inserted).toBe(0);expect(s.source.load).not.toHaveBeenCalled();
    s.conversation.aiControlStatus='agent_allowed';s.conversation.channel.encryptedConfig.assistantHistory.days=0;await s.run('w','c');expect(s.source.load).not.toHaveBeenCalled();
  });
  it('rejects cross-conversation provider ID collisions before writing',async()=>{
    const s=setup();s.messages.push({id:'other',conversationId:'other',providerMessageId:'old',createdAt:date,metadata:{historyImport:{source:'evolution'}}});
    await expect(s.run('w','c')).rejects.toThrow('outra conversa');expect(s.db.message.createMany).not.toHaveBeenCalled();
  });
  it('fails visibly on source failure without storing a completion marker',async()=>{
    const s=setup();s.source.load.mockRejectedValue(new Error('secret provider error'));
    await expect(s.run('w','c')).rejects.toThrow('histórico');expect(s.db.message.createMany).not.toHaveBeenCalled();expect(s.messages[0].metadata).toEqual({kept:true});
  });
  it('marks unavailable media explicitly without pretending it was read',async()=>{
    const s=setup();s.source.load.mockResolvedValue([{key:{id:'pdf',remoteJid:'123@s.whatsapp.net',fromMe:true},messageTimestamp:date.getTime()/1000-10,message:{documentMessage:{fileName:'proposta.pdf',mimetype:'application/pdf',url:'https://mmg.whatsapp.net/example.enc'}}}] as any);s.source.media.mockRejectedValue(new Error('expired'));
    const r=await s.run('w','c');expect(r.unreadMedia).toBe(1);expect(s.messages[1].mediaUrl).toBeNull();expect(s.messages[1].metadata.historyImport.mediaStatus).toBe('unavailable');
  });
});
