import { extensionCommandSchema, type ExtensionCommand, type ExtensionSession, type ExtensionConversation,
  type ExtensionReply, type ExtensionQueue, type ExtensionNavigationTarget } from './browser-extension.js';
import type { AssistantConversationDto } from './assistant.js';
import type { ConversationFollowupDto } from './domain.js';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Connection = Omit<ExtensionSession, 'scope'>;
export async function executeExtensionCommand(raw: unknown, request: Request, identity: string): Promise<ExtensionReply> {
  const command: ExtensionCommand = extensionCommandSchema.parse(raw);
  const connection = await request<Connection>('/browser-extension/channels');
  const scope = `${identity}:${connection.workspaceId}:${connection.role}`;
  if (command.action === 'session') return { ok: true, data: { ...connection, scope } };
  if (command.action === 'queue' || command.action === 'navigate') {
    if (!connection.channels.some(c => c.id === command.account.channelId)) throw new Error('Canal indisponível nesta sessão.');
    const { action, ...body } = command;
    if (action === 'queue') return { ok: true, data: { ...await request<ExtensionQueue>('/browser-extension/queue', { method: 'POST', body: JSON.stringify(body) }), scope } };
    return { ok: true, data: { ...await request<ExtensionNavigationTarget>('/browser-extension/navigate', { method: 'POST', body: JSON.stringify(body) }), scope } };
  }
  if(command.action==='cancel-followup'||command.action==='complete-handoff'){
    if(!connection.channels.some(c=>c.id===command.account.channelId))throw new Error('Canal indisponível nesta sessão.');
    const cancel=command.action==='cancel-followup';
    const target=await request<ExtensionNavigationTarget>('/browser-extension/navigate',{method:'POST',body:JSON.stringify({account:command.account,kind:cancel?'review':'human',id:command.id,...(cancel?{expectedUpdatedAt:command.expectedUpdatedAt}:{})})});
    if(target.conversation.channelId!==command.account.channelId)throw new Error('O canal da pendência mudou. Atualize a fila.');
    if(cancel){
      if(target.prepare?.id!==command.id||target.prepare.expectedUpdatedAt!==command.expectedUpdatedAt)throw new Error('O acompanhamento mudou. Atualize a fila.');
      const {followup}=await request<{followup:ConversationFollowupDto|null}>(`/conversations/${target.conversation.id}/followup`);
      if(!followup||followup.id!==command.id||followup.updatedAt!==command.expectedUpdatedAt||followup.status!=='review'||followup.kind==='seller_reminder')throw new Error('O acompanhamento mudou. Atualize a fila.');
      await request(`/followups/${command.id}/cancel`,{method:'POST',body:JSON.stringify({expectedUpdatedAt:command.expectedUpdatedAt,reason:'manual_cancelled'})});
    }else{
      if(target.conversation.id!==command.id||target.prepare!==null)throw new Error('A pendência humana mudou. Atualize a fila.');
      await request(`/conversations/${command.id}/actions`,{method:'POST',body:JSON.stringify({action:'complete_handoff_action'})});
    }
    return {ok:true,data:{accepted:true,scope}};
  }
  if (!connection.channels.some(c => c.id === command.chat.channelId)) throw new Error('Canal indisponível nesta sessão.');
  const conversation = await request<ExtensionConversation>('/browser-extension/resolve', { method: 'POST', body: JSON.stringify(command.chat) });
  if (command.action === 'generate') {
    await request(`/assistant/conversations/${conversation.id}/suggestions`, { method: 'POST', body: JSON.stringify({ instruction: command.instruction }) });
    return { ok: true, data: { accepted: true, scope } };
  }
  const followup = await request<{ followup: ConversationFollowupDto | null }>(`/conversations/${conversation.id}/followup`);
  if (command.action === 'followup') {
    if (!followup.followup || followup.followup.id !== command.id || followup.followup.updatedAt !== command.expectedUpdatedAt)
      throw new Error('O acompanhamento mudou. Atualize o painel antes de agir.');
    await request(`/followups/${command.id}/${command.operation}`, { method: 'POST', body: JSON.stringify({
      expectedUpdatedAt: command.expectedUpdatedAt, ...(command.operation === 'cancel' ? { reason: 'manual_cancelled' } : {}) }) });
    return { ok: true, data: { accepted: true, scope } };
  }
  const assistant = await request<AssistantConversationDto>(`/assistant/conversations/${conversation.id}`);
  return { ok: true, data: { scope, conversation, assistant, followup: followup.followup } };
}
