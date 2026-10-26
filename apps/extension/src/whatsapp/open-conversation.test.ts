import { JSDOM } from 'jsdom';
import { expect,it,vi } from 'vitest';
import { openVisibleWhatsAppConversation } from './open-conversation';
it('opens an exact visible phone without reloading and refuses ambiguous or name-only matches',()=>{
 const doc=new JSDOM('<div id="pane-side"><div role="row"><span title="+55 47 98765-4321">Ana</span></div></div>').window.document;
 const row=doc.querySelector<HTMLElement>('[role=row]')!;const click=vi.fn(),fence=vi.fn();row.addEventListener('click',click);
 expect(openVisibleWhatsAppConversation(doc,'5547987654321',fence)).toBe(true);expect(fence).toHaveBeenCalledOnce();expect(click).toHaveBeenCalledOnce();
 row.after(row.cloneNode(true));expect(openVisibleWhatsAppConversation(doc,'5547987654321',fence)).toBe(false);
 expect(openVisibleWhatsAppConversation(doc,'5511987654321',fence)).toBe(false);
});
it('keeps an already open exact phone in place',()=>{
 const doc=new JSDOM('<div id="main"><header><span title="+55 47 98765-4321"></span></header></div>').window.document;const fence=vi.fn();
 expect(openVisibleWhatsAppConversation(doc,'5547987654321',fence)).toBe(true);expect(fence).not.toHaveBeenCalled();
});

it('dispatches the mouse-down selection used by native chat rows',()=>{
 const doc=new JSDOM('<div id="pane-side"><div role="row"><span title="15550001111">Contact</span></div></div>').window.document;
 const selected=vi.fn();doc.querySelector('[role=row]')!.addEventListener('mousedown',selected);
 expect(openVisibleWhatsAppConversation(doc,'15550001111',()=>{})).toBe(true);expect(selected).toHaveBeenCalledOnce();
});
