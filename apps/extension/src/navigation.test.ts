import { expect, it } from 'vitest';
import { NavigationIntents, followupForPreparation, whatsappConversationUrl, assertAccountContext } from './navigation';
const context={windowId:1,tabId:7,scope:'A',selfAddress:'5547991234567@s.whatsapp.net'};
const target={conversation:{id:'chat-A',phone:'554787654321',channelId:'channel',contactName:'Ana'},prepare:{id:'followup-A',expectedUpdatedAt:'2026-10-26T10:00:00.000Z'}};
it('limits a navigation intent to its exact account, tab, target and lifetime',()=>{
 let now=1;const intents=new NavigationIntents(()=>now,()=> 'nonce');
 const token=intents.create(context,target);expect(intents.require(token,context).target).toEqual(target);
 expect(()=>intents.require(token,{...context,tabId:8})).toThrow();
 expect(()=>intents.require(token,{...context,scope:'B'})).toThrow();
 now=60_002;expect(()=>intents.require(token,context)).toThrow();
});
it('manual navigation or input cancels pending preparation, and a consumed intent cannot run twice',()=>{
 const intents=new NavigationIntents(()=>1,()=> 'nonce');const token=intents.create(context,target);
 intents.cancelTab(7);expect(()=>intents.require(token,context)).toThrow();
 intents.create(context,target);intents.consume(token,context);expect(()=>intents.consume(token,context)).toThrow();
});
it('never prepares a changed follow-up or a different conversation, and never sends',()=>{
 const data={conversation:target.conversation,followup:{id:'followup-A',updatedAt:target.prepare.expectedUpdatedAt,status:'review',kind:'human_commercial',draftBody:'Texto de teste'}};
 expect(followupForPreparation(data as never,target)).toBe('Texto de teste');
 for(const changed of [{conversation:{...target.conversation,id:'other'}},{followup:{...data.followup,updatedAt:'changed'}},{followup:{...data.followup,status:'scheduled'}},{followup:{...data.followup,kind:'seller_reminder'}}])
  expect(()=>followupForPreparation({...data,...changed} as never,target)).toThrow();
});
it('only builds a WhatsApp URL from a numeric phone and refuses another browser account',()=>{
 expect(whatsappConversationUrl(target)).toBe('https://web.whatsapp.com/send?phone=554787654321');
 expect(()=>whatsappConversationUrl({...target,conversation:{...target.conversation,phone:'https://evil.test'}})).toThrow();
 expect(()=>assertAccountContext(context,{windowId:1,tabId:7,selection:{selfAddress:'other'}} as never)).toThrow();
});
