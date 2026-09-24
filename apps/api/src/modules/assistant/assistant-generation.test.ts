import { describe, it, expect, vi } from 'vitest';
import { createAssistantGeneration, loadAssistantContext, assistantHash, type AssistantContext } from './assistant-generation.js';
import type { AssistantDb } from './assistant-access.js';

const context = { conversation: { workspaceId: 'w', aiControlStatus: 'agent_allowed' }, agent: { id: 'a', systemPrompt: 'Qualifique o pedido.', behaviorConfig: {} }, knowledge: [], messages: [{ id: 'm', workspaceId: 'w', direction: 'inbound', type: 'text', body: 'Preciso de 10 chapas de aço de 2 mm', mediaUrl: null, metadata: {} }], contextKey: 'context', agentHash: 'agent', limited: false } as unknown as AssistantContext;
const output = { reply: 'Quais as medidas e a cidade de entrega?', confidence: 1, actions: [{ type: 'send_message' as const, body: 'Não executar' }], handoff: { required: true, reason: 'review' } };
function setup(active = true) {
  const db = { integrationConfig: { findUnique: vi.fn().mockResolvedValue(active ? { mode: 'real', settings: { baseUrl: 'https://provider.invalid/v1', apiKey: 'test-only', chatModel: 'test-model' } } : null) }, message: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } } as unknown as AssistantDb;
  const generate = vi.fn().mockResolvedValue(output);
  const mediaPreparer = vi.fn().mockResolvedValue({ kind: 'document', status: 'processed', extractedText: '10 chapas 2 mm' });
  return { db, generate, mediaPreparer, run: createAssistantGeneration(db, { providerFactory: () => ({ generate }), mediaPreparer }) };
}
describe('private read-only generation', () => {
  const oldAttachment = { ...context.messages[0], id: 'old-audio', type: 'audio' as const, body: 'Áudio recebido', createdAt: new Date('2026-08-18T12:00:00Z'), metadata: { historyImport: { source: 'evolution', mediaStatus: 'unavailable' } } };
  it.each([false, true])('warns about historical media only when currently needed: %s', async requiredForReply => {
    const { run, generate, mediaPreparer } = setup();
    mediaPreparer.mockResolvedValue({ kind: 'audio', status: 'failed', extractedText: '' });
    generate.mockResolvedValue({ ...output, attachmentRelevance: [{ messageId: 'A1', requiredForReply }] });
    const result = await run({ ...context, messages: [oldAttachment, { ...context.messages[0], body: requiredForReply ? 'Pode cotar o que pedi naquele áudio?' : 'Por enquanto nada ainda' }] });
    expect(result.warnings).toHaveLength(requiredForReply ? 1 : 0);
    expect(generate.mock.calls[0][0].context.conversationHistory).toContain('Anexo não lido');
    expect(generate.mock.calls[0][0].context.unreadAttachments).toEqual([expect.objectContaining({ messageId: 'A1', currentTurn: false })]);
    expect(result.proposedActions).toMatchObject({ attachmentRelevance: [{ messageId: 'old-audio', requiredForReply }] });
  });
  it.each([undefined, [], [{ messageId: 'other', requiredForReply: false }], [{ messageId: 'A1', requiredForReply: false }, { messageId: 'A1', requiredForReply: true }]])('keeps warnings when relevance is absent or ambiguous: %j', async attachmentRelevance => {
    const { run, generate, mediaPreparer } = setup();
    mediaPreparer.mockResolvedValue({ kind: 'audio', status: 'failed', extractedText: '' });
    generate.mockResolvedValue({ ...output, attachmentRelevance });
    expect((await run({ ...context, messages: [oldAttachment, context.messages[0]] })).warnings).toHaveLength(1);
  });
  it('never suppresses an unread attachment in the current customer turn', async () => {
    const { run, generate, mediaPreparer } = setup();
    mediaPreparer.mockResolvedValue({ kind: 'audio', status: 'failed', extractedText: '' });
    generate.mockResolvedValue({ ...output, attachmentRelevance: [{ messageId: 'A1', requiredForReply: false }] });
    const result = await run({ ...context, messages: [{ ...oldAttachment, id: 'new-audio', metadata: {} }, context.messages[0]] });
    expect(result.warnings).toHaveLength(1);
  });
  it('stores failed reading state against its source without treating it as read', async () => {
    const { run, db, mediaPreparer } = setup();
    mediaPreparer.mockResolvedValue({ kind: 'audio', status: 'failed', extractedText: '' });
    await run({ ...context, messages: [oldAttachment, context.messages[0]] });
    expect(db.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { metadata: expect.objectContaining({ assistantMedia: expect.objectContaining({ result: expect.objectContaining({ status: 'failed' }) }) }) } }));
  });
  it('uses short distinct references instead of asking the model to copy similar UUIDs', async () => {
    const { run, generate, mediaPreparer } = setup();
    mediaPreparer.mockResolvedValue({ kind: 'audio', status: 'failed', extractedText: '' });
    const ids = ['1b2c4908-e61b-49ef-9724-907141d1ea9c', '920ebdb3-9a76-448c-ae42-9072d65e45db'];
    generate.mockResolvedValue({ ...output, attachmentRelevance: [{ messageId: 'A1', requiredForReply: false }, { messageId: 'A2', requiredForReply: true }] });
    const result = await run({ ...context, messages: [...ids.map(id => ({ ...oldAttachment, id })), context.messages[0]] });
    const input = generate.mock.calls[0][0];
    expect(input.context.unreadAttachments.map((a: { messageId: string }) => a.messageId)).toEqual(['A1', 'A2']);
    expect(input.context.conversationHistory).toContain('ID A1:');
    expect(input.context.conversationHistory).toContain('ID A2:');
    expect(input.context.conversationHistory).not.toContain(ids[0]);
    expect(result.warnings).toEqual([expect.stringContaining('920ebdb3')]);
  });
  it('uses extracted historical seller attachments and keeps their dates explicit', async () => {
    const { run, generate, mediaPreparer } = setup();
    const m = { ...context.messages[0], id:'proposal',direction:'outbound' as const,type:'file' as const,mediaUrl:'url',createdAt:new Date('2026-08-20T12:00:00Z'),metadata:{} };
    m.metadata = { historyImport:{source:'evolution'},assistantMedia:{sourceHash:assistantHash([m.id,m.type,m.mediaUrl]),result:{kind:'document',status:'processed',extractedText:'Proposta antiga: 10 chapas'}} };
    await run({...context,messages:[m,context.messages[0]]});
    expect(generate.mock.calls[0][0].context.conversationHistory).toContain('Proposta antiga: 10 chapas');
    expect(generate.mock.calls[0][0].context.conversationHistory).toContain('2026-08-20');
    expect(mediaPreparer).not.toHaveBeenCalled();
  });
  it.each([true, false])('loads complete stored history only for opted-in agents: %s', async complete => {
    const { db } = setup();
    Object.assign(db, {
      conversation: { findFirst: vi.fn().mockResolvedValue({ ...context.conversation, channel: { encryptedConfig: { assistant: { mode: 'automatic', agentId: '00000000-0000-4000-8000-000000000101' } } } }) },
      aiAgent: { findFirst: vi.fn().mockResolvedValue({ ...context.agent, behaviorConfig: complete ? { conversationReasoning: 'context_first_v1' } : {} }) },
      aiKnowledgeSource: { findMany: vi.fn().mockResolvedValue([]) },
      message: { findMany: vi.fn().mockResolvedValue(Array.from({ length: 81 }, (_, i) => ({ ...context.messages[0], id: `m${i}` }))) }
    });
    const result = await loadAssistantContext(db, 'w', 'c');
    expect(result.messages.length).toBe(complete ? 81 : 80);
    expect(result.limited).toBe(!complete);
    expect(db.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: complete ? 2001 : 81 }));
  });
  it('lets context-first price questions reach the model without automatic transfer', async () => {
    const { run, generate } = setup();
    await run({ ...context, agent: { ...context.agent, behaviorConfig: { conversationReasoning: 'context_first_v1' } }, messages: [{ ...context.messages[0], body: 'Qual o valor da chapa?' }] });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].context.conversationReasoning).toBe('context_first_v1');
  });
  it('stores proposed actions as data and keeps private instructions distinct from customer text', async () => {
    const { run, generate } = setup();
    const result = await run(context, 'Pergunte tudo de uma vez');
    expect(result.body).toBe(output.reply);
    expect(result.proposedActions).toMatchObject({ actions: output.actions });
    const input = generate.mock.calls[0][0];
    expect(input.context.privateSellerInstruction).toBe('Pergunte tudo de uma vez');
    expect(input.userPrompt).not.toContain('Pergunte tudo');
    expect(input.context.allowedActions).toEqual([]);
  });
  it('never falls back to simulated replies', async () => await expect(setup(false).run(context)).rejects.toMatchObject({ code: 'ASSISTANT_PROVIDER_REQUIRED' }));
  it('fails under human control before any provider request', async () => {
    const { run, generate } = setup();
    await expect(run({ ...context, conversation: { ...context.conversation, aiControlStatus: 'human_controlled' } })).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
  it('generates a private draft under human control when an agent is available', async () => {
    const { run, generate } = setup();
    const result = await run({ ...context, conversation: { ...context.conversation, aiControlStatus: 'human_controlled' }, humanSupport: true });
    expect(result.body).toBe(output.reply);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].context.allowedActions).toEqual([]);
  });
  it('loads the active agent as support after an autonomous handoff', async () => {
    const { db } = setup();
    const agentId='00000000-0000-4000-8000-000000000101';
    Object.assign(db, {
      conversation:{findFirst:vi.fn().mockResolvedValue({...context.conversation,aiControlStatus:'human_controlled',activeAgentSessionId:'session',activeAgentSession:{agentId},channel:{encryptedConfig:{}}})},
      aiAgent:{findFirst:vi.fn().mockResolvedValue({...context.agent,id:agentId})},
      aiKnowledgeSource:{findMany:vi.fn().mockResolvedValue([])},
      message:{findMany:vi.fn().mockResolvedValue(context.messages)}
    });
    const loaded=await loadAssistantContext(db,'w','c');
    expect(loaded.humanSupport).toBe(true);
    expect(loaded.settings).toEqual({mode:'automatic',agentId});
    expect(db.aiAgent.findFirst).toHaveBeenCalledWith({where:{workspaceId:'w',id:agentId}});
  });
  it('does not hide provider failure behind a canned reply', async () => {
    const { run, generate } = setup(); generate.mockRejectedValue(new Error('timeout'));
    await expect(run(context)).rejects.toThrow('timeout');
  });
  it.each(['', 'x'.repeat(4001)])('rejects invalid reply length', async reply => {
    const { run, generate } = setup(); generate.mockResolvedValue({ ...output, reply });
    await expect(run(context)).rejects.toMatchObject({ code: 'ASSISTANT_INVALID_REPLY' });
  });
  it.each(['file', 'image', 'audio'] as const)('reads %s using only the persisted message URL', async type => {
    const { run, generate, mediaPreparer } = setup();
    await run({ ...context, messages: [{ ...context.messages[0], type, mediaUrl: 'https://files.invalid/example' }] });
    expect(mediaPreparer.mock.calls[0][0].mediaUrl).toBe('https://files.invalid/example');
    expect(generate.mock.calls[0][0].context.conversationHistory).toContain('10 chapas 2 mm');
  });
  it('shows unreadable media instead of inventing its contents', async () => {
    const { run, mediaPreparer, generate } = setup();
    mediaPreparer.mockResolvedValue({ kind: 'document', status: 'failed', extractedText: '' });
    const result = await run({ ...context, messages: [{ ...context.messages[0], type: 'file' }] });
    expect(result.warnings).toHaveLength(1);
    expect(generate.mock.calls[0][0].context.conversationHistory).toContain('Anexo não lido');
  });
  it('reuses a source-bound media cache', async () => {
    const { run, mediaPreparer } = setup();
    const m = { ...context.messages[0], type: 'file' as const, mediaUrl: 'url' };
    m.metadata = { assistantMedia: { sourceHash: assistantHash([m.id, m.type, m.mediaUrl]), result: { kind: 'document', status: 'processed', extractedText: '10 chapas 2 mm' } } };
    await run({ ...context, messages: [m] }); expect(mediaPreparer).not.toHaveBeenCalled();
  });
});
