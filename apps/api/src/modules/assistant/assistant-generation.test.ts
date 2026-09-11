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
