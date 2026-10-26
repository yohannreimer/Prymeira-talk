import { canonicalPhone } from './identity';
const numeric=(value:string|null|undefined)=>!!value&&/^\+?[\d\s().-]{8,25}$/.test(value);
/** Use only a visible exact phone, never a display-name match or a private WhatsApp API. */
export function openVisibleWhatsAppConversation(document:Document,phone:string,beforeOpen:()=>void) {
  const expected=canonicalPhone(phone);
  const header=document.querySelector('#main header [data-testid="conversation-info-header-chat-title"], #main header span[title]');
  const label=header?.getAttribute('title')||header?.textContent;
  if(numeric(label)&&canonicalPhone(label!)===expected)return true;
  const matches=Array.from(document.querySelectorAll<HTMLElement>('#pane-side [role="row"], #pane-side [role="listitem"], [data-testid="chat-list"] [role="row"]'))
    .map(row=>Array.from(row.querySelectorAll<HTMLSpanElement>('span[title]')).find(span=>{
      const title=span.getAttribute('title');return numeric(title)&&canonicalPhone(title!)===expected;
    })).filter((span):span is HTMLSpanElement=>!!span);
  if(matches.length!==1)return false;
  beforeOpen();
  const target=matches[0]!,view=document.defaultView!;
  // WhatsApp selects chat rows on pointer/mouse down rather than a bare synthetic click.
  if(view.PointerEvent)target.dispatchEvent(new view.PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true}));
  target.dispatchEvent(new view.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1}));
  if(view.PointerEvent)target.dispatchEvent(new view.PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true}));
  target.dispatchEvent(new view.MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0,buttons:0}));
  target.click();return true;
}
