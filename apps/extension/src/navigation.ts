import type { ExtensionNavigationTarget, ExtensionRead } from '@prymeira-talk/shared';
import type { AccountContext } from './protocol';
import type { LiveSelection } from './selection-fence';
import { canonicalPhone } from './whatsapp/identity';
export function assertAccountContext(expected: AccountContext, live: LiveSelection) {
  if (live.windowId !== expected.windowId || live.tabId !== expected.tabId || !live.selection?.selfAddress
    || canonicalPhone(live.selection.selfAddress) !== canonicalPhone(expected.selfAddress))
    throw new Error('A conta ou a aba do WhatsApp mudou. Atualize a fila.');
}
export function whatsappConversationUrl(target: ExtensionNavigationTarget) {
  const phone=target.conversation.phone;
  if (!/^\+?[\d ()-]{8,25}$/.test(phone)) throw new Error('Este contato não tem telefone individual disponível.');
  const digits=phone.replace(/\D/g,'');
  if (digits.length < 8 || digits.length > 15) throw new Error('Telefone inválido.');
  return `https://web.whatsapp.com/send?phone=${digits}`;
}
export class NavigationIntents {
  private jobs = new Map<number,{ token:string; context:AccountContext; target:ExtensionNavigationTarget; expires:number }>();
  constructor(private now=()=>Date.now(), private uuid:()=>string=()=>crypto.randomUUID()) {}
  create(context:AccountContext,target:ExtensionNavigationTarget) { const token=this.uuid();this.jobs.set(context.windowId,{token,context,target,expires:this.now()+60_000});return token; }
  require(token:string,context:AccountContext) {
    const job=this.jobs.get(context.windowId);
    if (!job || job.token!==token || job.expires<this.now() || job.context.tabId!==context.tabId || job.context.scope!==context.scope
      || canonicalPhone(job.context.selfAddress)!==canonicalPhone(context.selfAddress)) throw new Error('A preparação foi interrompida. Clique novamente no follow-up para preparar.');
    return job;
  }
  consume(token:string,context:AccountContext) { const job=this.require(token,context);this.jobs.delete(context.windowId);return job; }
  cancelTab(tabId:number) { const tokens:string[]=[];for(const [id,job] of this.jobs) if(job.context.tabId===tabId){tokens.push(job.token);this.jobs.delete(id);}return tokens; }
  cancelWindow(windowId:number) { const token=this.jobs.get(windowId)?.token;this.jobs.delete(windowId);return token; }
  clear() { this.jobs.clear(); }
}
export function followupForPreparation(data: ExtensionRead, target: ExtensionNavigationTarget) {
  const followup=data.followup;
  if (data.conversation.id!==target.conversation.id || !target.prepare || !followup || followup.id!==target.prepare.id
    || followup.updatedAt!==target.prepare.expectedUpdatedAt || followup.status!=='review' || followup.kind==='seller_reminder')
    throw new Error('O acompanhamento ou a conversa mudou. Atualize a fila antes de preparar a mensagem.');
  const body=followup.draftBody?.trim();
  if(!body || body.length>4000)throw new Error('Este acompanhamento ainda não tem um texto pronto. Confira no Talk.');
  return body;
}
