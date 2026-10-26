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
  beforeOpen();matches[0]!.click();return true;
}
