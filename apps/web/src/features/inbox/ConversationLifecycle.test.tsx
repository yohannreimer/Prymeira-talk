// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiConfirmCtwaSale, apiGetCtwaLifecycle, type CtwaLifecycleCapability, type CtwaLifecycleItem } from '../../app/api';
import { ConversationLifecycle, lifecycleStateLabel, parseBrlCents } from './ConversationLifecycle';
vi.mock('../../app/api',()=>({apiConfirmCtwaSale:vi.fn(),apiGetCtwaLifecycle:vi.fn()}));
const token=async()=>'synthetic',capability={enabled:true,native:true,items:[]};
const receipt:CtwaLifecycleItem={id:'sale',eventId:'synthetic',eventName:'Purchase',eventTime:'2026-10-23T12:00:00Z',orderId:'sale-1',valueCents:123456,currency:'BRL',state:'pending_validation',responseCode:null,outcomeCode:null};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
async function mount(conversationId='a'){
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
 await act(async()=>root.render(<ConversationLifecycle conversationId={conversationId} getToken={token}/>));
 return{container,root,render:async(id:string)=>{await act(async()=>root.render(<ConversationLifecycle conversationId={id} getToken={token}/>));},close:async()=>{await act(async()=>root.unmount());container.remove();}};
}
async function input(container:HTMLElement,name:string,value:string){await act(async()=>{const element=container.querySelector(`input[name="${name}"]`) as HTMLInputElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));});}
async function submit(container:HTMLElement,times=1){await act(async()=>{for(let i=0;i<times;i++)container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});}
afterEach(()=>{vi.clearAllMocks();});
describe('conversation lifecycle',()=>{
 it.each([['1.234,56',123456],['10',1000],['0,01',1],['R$ 12,30',1230],['999.999.999.999,99',99999999999999]] as const)('parses BRL %s exactly', (raw,cents)=>{expect(parseBrlCents(raw)).toBe(cents);});
 it.each(['0','0,00','-1','1,234','1.23','1e3','NaN','1,2,3','1.000.000.000.000,01'])('rejects invalid/zero/negative/precision %s',raw=>{expect(parseBrlCents(raw)).toBeNull();});
 it.each([{...capability,enabled:false},{...capability,native:false}])('hides other workspace or missing native capability',async cap=>{vi.mocked(apiGetCtwaLifecycle).mockResolvedValue(cap);const f=await mount();try{expect(f.container.textContent).toBe('');expect(apiConfirmCtwaSale).not.toHaveBeenCalled();}finally{await f.close();}});
 it('ignores a late capability from the previous conversation',async()=>{const late=deferred<CtwaLifecycleCapability>();vi.mocked(apiGetCtwaLifecycle).mockImplementation(async(_token,id)=>id==='a'?late.promise:{...capability,enabled:false});const f=await mount();try{await f.render('b');await act(async()=>late.resolve(capability));expect(f.container.textContent).toBe('');}finally{await f.close();}});
 it('double-submit is fenced; retry preserves reference/amount; queued never says accepted',async()=>{
  vi.mocked(apiGetCtwaLifecycle).mockResolvedValue(capability);const attempt=deferred<CtwaLifecycleItem>();vi.mocked(apiConfirmCtwaSale).mockReturnValueOnce(attempt.promise).mockResolvedValue(receipt);const f=await mount();
  try{await input(f.container,'saleReference','sale-1');await input(f.container,'saleAmount','1.234,56');await submit(f.container,2);expect(apiConfirmCtwaSale).toHaveBeenCalledTimes(1);expect(apiConfirmCtwaSale).toHaveBeenCalledWith(token,'a',{orderId:'sale-1',valueCents:123456,currency:'BRL'});await act(async()=>attempt.resolve(receipt));expect(f.container.textContent).toContain('Na fila no Talk');expect(f.container.textContent).not.toContain('Aceita pela Meta');expect((f.container.querySelector('[name="saleReference"]') as HTMLInputElement).value).toBe('sale-1');await submit(f.container);expect(apiConfirmCtwaSale).toHaveBeenCalledTimes(2);}finally{await f.close();}
 });
 it('late sale response cannot appear on the next conversation',async()=>{
  vi.mocked(apiGetCtwaLifecycle).mockResolvedValue(capability);const attempt=deferred<CtwaLifecycleItem>();vi.mocked(apiConfirmCtwaSale).mockReturnValue(attempt.promise);const f=await mount();try{await input(f.container,'saleReference','sale-1');await input(f.container,'saleAmount','1,00');await submit(f.container);await f.render('b');await act(async()=>attempt.resolve({...receipt,state:'tracking_accepted'}));expect(f.container.textContent).not.toContain('registrada:');expect(f.container.textContent).not.toContain('sale-1');}finally{await f.close();}
 });
 it('failed submission keeps reference and amount for an identical retry',async()=>{
  vi.mocked(apiGetCtwaLifecycle).mockResolvedValue(capability);vi.mocked(apiConfirmCtwaSale).mockRejectedValueOnce(new Error('synthetic transport error')).mockResolvedValue(receipt);const f=await mount();try{await input(f.container,'saleReference','sale-1');await input(f.container,'saleAmount','1.234,56');await submit(f.container);expect(f.container.textContent).toContain('Repita com a mesma referência e valor');expect((f.container.querySelector('[name="saleReference"]') as HTMLInputElement).value).toBe('sale-1');expect((f.container.querySelector('[name="saleAmount"]') as HTMLInputElement).value).toBe('1.234,56');await submit(f.container);expect(apiConfirmCtwaSale).toHaveBeenCalledTimes(2);expect(vi.mocked(apiConfirmCtwaSale).mock.calls[1]).toEqual(vi.mocked(apiConfirmCtwaSale).mock.calls[0]);}finally{await f.close();}
 });
 it('polling updates the saved receipt status and identifies the previous sale while editing',async()=>{
  vi.useFakeTimers();vi.mocked(apiGetCtwaLifecycle).mockResolvedValue(capability);vi.mocked(apiConfirmCtwaSale).mockResolvedValue(receipt);const f=await mount();try{await input(f.container,'saleReference','sale-1');await input(f.container,'saleAmount','1.234,56');await submit(f.container);expect(f.container.textContent).toContain('Venda sale-1 registrada: Na fila no Talk');vi.mocked(apiGetCtwaLifecycle).mockResolvedValue({...capability,items:[{...receipt,state:'tracking_accepted'}]});await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});await input(f.container,'saleReference','next-sale');expect(f.container.textContent).toContain('Venda sale-1 registrada: Aceita pela Meta');expect(f.container.textContent).not.toContain('registrada: Na fila');}finally{await f.close();vi.useRealTimers();}
 });
 it('only central accepted receipt is labelled accepted',()=>{expect(lifecycleStateLabel('tracking_accepted')).toBe('Aceita pela Meta');for(const state of ['pending_validation','tracking_forwarding','tracking_pending','tracking_retry','tracking_unknown'])expect(lifecycleStateLabel(state)).not.toContain('Aceita');});
});
