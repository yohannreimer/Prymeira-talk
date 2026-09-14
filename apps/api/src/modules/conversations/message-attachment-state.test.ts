import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { toMessageDto } from './conversations.service.js';

const message = { id: 'm', workspaceId: 'w', conversationId: 'c', direction: 'inbound' as const, type: 'audio' as const, body: 'Áudio recebido', mediaUrl: null, status: 'delivered' as const, createdAt: new Date() };
const sourceHash = createHash('sha256').update(JSON.stringify(['m', 'audio', null])).digest('hex');
describe('safe attachment state in message DTO', () => {
  it('exposes only safe attachment presentation fields', () => {
    const dto = toMessageDto({ ...message, metadata: { attachment: { fileName: 'Cotacao.pdf', caption: 'Segue a cotação', durationSeconds: 12, secret: 'hidden' } } });
    expect(dto.attachment).toEqual({ fileName: 'Cotacao.pdf', caption: 'Segue a cotação', durationSeconds: 12 });
    expect(JSON.stringify(dto)).not.toContain('hidden');
  });
  it('exposes an unread flag but no private metadata for unavailable imports', () => {
    const dto = toMessageDto({ ...message, metadata: { historyImport: { source: 'evolution', mediaStatus: 'unavailable' }, privateSecret: 'do-not-expose' } });
    expect(dto.attachmentReadStatus).toBe('unread');
    expect(JSON.stringify(dto)).not.toContain('privateSecret');
    expect(JSON.stringify(dto)).not.toContain('historyImport');
  });
  it.each(['processed', 'failed'])('uses a source-bound %s cache', status => {
    const dto = toMessageDto({ ...message, metadata: { assistantMedia: { sourceHash, result: { status, extractedText: status === 'processed' ? 'Pedido de chapas' : undefined } }, historyImport: { source: 'evolution', mediaStatus: 'unavailable' } } });
    expect(dto.attachmentReadStatus).toBe(status === 'failed' ? 'unread' : undefined);
  });
  it('ignores a failed cache for another source', () => {
    expect(toMessageDto({ ...message, metadata: { assistantMedia: { sourceHash: 'another', result: { status: 'failed' } } } }).attachmentReadStatus).toBeUndefined();
  });
});
