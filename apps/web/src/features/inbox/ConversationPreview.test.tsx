import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { lastMessageKind } from '@prymeira-talk/shared';
import { ConversationPreview, conversationPreview } from './ConversationPreview';
const last = (kind?: 'sticker' | 'image' | 'video' | 'file' | 'text', direction: 'inbound' | 'outbound' = 'outbound') =>
  ({ id: 'm', direction, status: 'delivered' as const, createdAt: '2026-10-03T20:00:00Z', kind });
describe('queue card preview, like WhatsApp', () => {
  it('names the media kind instead of saying "recebida" for what we sent', () => {
    expect(conversationPreview({ lastMessagePreview: 'Figurinha recebida', lastMessage: last('sticker') })).toEqual({ kind: 'sticker', text: 'Figurinha' });
    expect(conversationPreview({ lastMessagePreview: 'Imagem recebida', lastMessage: null })).toEqual({ kind: 'image', text: 'Foto' });
    expect(conversationPreview({ lastMessagePreview: 'Vídeo recebido', lastMessage: last() })).toEqual({ kind: 'video', text: 'Vídeo' });
  });
  it('keeps a caption or file name next to the icon, and plain text without one', () => {
    expect(conversationPreview({ lastMessagePreview: 'Memorial.pdf', lastMessage: last('file') })).toEqual({ kind: 'file', text: 'Memorial.pdf' });
    expect(conversationPreview({ lastMessagePreview: 'Olá!', lastMessage: last('text') })).toEqual({ kind: null, text: 'Olá!' });
  });
  it('shows the ticks only for our own last message', () => {
    expect(renderToStaticMarkup(<ConversationPreview conversation={{ lastMessagePreview: 'Imagem recebida', lastMessage: last('image') }} />)).toContain('Entregue');
    expect(renderToStaticMarkup(<ConversationPreview conversation={{ lastMessagePreview: 'Imagem recebida', lastMessage: last('image', 'inbound') }} />)).not.toContain('Entregue');
  });
  it('names who wrote a group\'s last message, like WhatsApp ("~Rejane: …"), and nobody for our own or a private chat', () => {
    const inbound = { ...last('text', 'inbound'), senderName: 'Rejane' };
    expect(renderToStaticMarkup(<ConversationPreview conversation={{ isGroup: true, lastMessagePreview: 'Mesada do vorcaro', lastMessage: inbound }} />)).toContain('~Rejane:');
    expect(renderToStaticMarkup(<ConversationPreview conversation={{ isGroup: false, lastMessagePreview: 'oi', lastMessage: inbound }} />)).not.toContain('~Rejane');
    expect(renderToStaticMarkup(<ConversationPreview conversation={{ isGroup: true, lastMessagePreview: 'oi', lastMessage: last('text') }} />)).not.toContain('~');
  });
  it('classifies messages the same way on the server and in realtime', () => {
    expect(lastMessageKind({ type: 'image', body: 'Figurinha recebida' })).toBe('sticker');
    expect(lastMessageKind({ type: 'file', body: 'x', mimeType: 'video/mp4' })).toBe('video');
    expect(lastMessageKind({ type: 'file', body: 'x', mediaUrl: 'data:application/pdf;base64,YQ==' })).toBe('file');
    expect(lastMessageKind({ type: 'audio' })).toBe('audio');
    expect(lastMessageKind({ type: 'text', body: 'oi' })).toBe('text');
  });
});
