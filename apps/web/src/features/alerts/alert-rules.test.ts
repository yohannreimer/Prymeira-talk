import { describe, expect, it } from 'vitest';
import type { ConversationDto, MessageDto } from '@prymeira-talk/shared';
import { describeAlert, titleWithCount } from './alert-rules';

const now = Date.parse('2026-10-11T12:00:00Z');
const message = (overrides: Partial<MessageDto> = {}): MessageDto => ({ id: 'm1', conversationId: 'c1', workspaceId: 'w', providerMessageId: null, direction: 'inbound', type: 'text', body: 'Tem chapa 3mm?', mediaUrl: null, status: 'sent', sentByUserId: null, createdAt: '2026-10-11T12:00:00Z', ...overrides });
const conversation = (overrides: Partial<ConversationDto> = {}): ConversationDto => ({ id: 'c1', workspaceId: 'w', channelId: 'channel', contactId: 'contact', contactName: 'Ana', status: 'open', assignedUserId: null, departmentId: null, lastMessageAt: '2026-10-11T11:59:00Z', lastMessagePreview: null, unreadCount: 0, priority: 'normal', ...overrides });

describe('describeAlert', () => {
  it('tells the seller who wrote and what', () => {
    expect(describeAlert({ kind: 'message', message: message(), conversation: conversation() }, now))
      .toEqual({ conversationId: 'c1', title: 'Ana', body: 'Tem chapa 3mm?' });
    expect(describeAlert({ kind: 'message', message: message({ body: null, type: 'audio' }) }, now)?.body).toBe('🎤 Áudio');
  });
  it('stays quiet for groups and conversations the AI is handling', () => {
    expect(describeAlert({ kind: 'message', message: message(), conversation: conversation({ isGroup: true }) }, now)).toBeNull();
    expect(describeAlert({ kind: 'message', message: message(), conversation: conversation({ aiControlStatus: 'agent_allowed', activeAgentSessionStatus: 'active' }) }, now)).toBeNull();
    expect(describeAlert({ kind: 'message', message: message(), conversation: conversation({ aiControlStatus: 'human_controlled', activeAgentSessionStatus: 'active' }) }, now)).not.toBeNull();
  });
  it('announces a handoff with its reason, and skips an old one it never saw happen', () => {
    const handedOff = conversation({ aiControlStatus: 'human_controlled', handoffReason: 'Pediu orçamento' });
    expect(describeAlert({ kind: 'handoff', conversation: handedOff, previous: conversation() }, now))
      .toEqual({ conversationId: 'c1', title: 'A IA passou Ana para a equipe', body: 'Pediu orçamento' });
    expect(describeAlert({ kind: 'handoff', conversation: handedOff }, now)).not.toBeNull();
    expect(describeAlert({ kind: 'handoff', conversation: { ...handedOff, lastMessageAt: '2026-10-10T12:00:00Z' } }, now)).toBeNull();
  });
  it('counts waiting conversations in the tab title', () => {
    expect(titleWithCount('Prymeira Talk', 0)).toBe('Prymeira Talk');
    expect(titleWithCount('Prymeira Talk', 3)).toBe('(3) Prymeira Talk');
  });
});
