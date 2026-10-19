// Copied to apps/api/tmp by the isolated workflow; no network or database used.
import {describe,it,expect} from 'vitest';
import {makeEnvelopes} from '../../../.github/ui-comparison/payloads.mjs';
import {normalizeReceipt} from '../src/modules/ingress/normalization.js';
import type {TrustedMessagingContext} from '../src/modules/messaging/normalized-event.js';
const input={rawId:'UI-CONTRACT-1',phone:'15551000000',text:'TALKUI_00001 Olá! 😊',timestamp:1792450800,instance:'ui-evolution',session:'ui-waha',index:0};
const context=(provider:'evolution'|'waha'):TrustedMessagingContext=>({workspaceId:'fixture',channelId:'fixture-channel',channelProvider:'evolution',provider,connectionId:provider,sessionName:provider==='waha'?input.session:input.instance,lifecycleGeneration:0,mode:'live',observedAt:new Date(input.timestamp*1000).toISOString()});
describe('browser load provider fixtures',()=>{
 it.each(['evolution','waha'] as const)('%s carries the same exact complete text identity',provider=>{
  const result=normalizeReceipt(context(provider),makeEnvelopes(input)[provider]);
  expect(result.events).toHaveLength(1);const event=result.events[0];expect(event.kind).toBe('accepted');if(event.kind!=='accepted'||event.event.kind!=='message')throw Error('Complete message required');
  expect(event.event.content).toMatchObject({type:'text',body:input.text});expect(event.event.key).toMatchObject({rawId:input.rawId,chatAddress:input.phone+'@s.whatsapp.net',direction:'inbound'});expect(event.event.order.timestampMs).toBe(input.timestamp*1000);
 });
});
