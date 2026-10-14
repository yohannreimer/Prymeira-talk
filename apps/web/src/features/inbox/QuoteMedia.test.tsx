import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageDto } from '@prymeira-talk/shared';
import { quotedPreview } from './message-threading';
import { QuoteContent } from './QuoteMedia';
import { InboxMedia } from './InboxMedia';

const msg = (over: Partial<MessageDto>): MessageDto => ({ id: 'm1', conversationId: 'c', workspaceId: 'w', direction: 'inbound', status: 'delivered',
  createdAt: '2026-10-03T21:49:00Z', providerMessageId: null, sentByUserId: null, type: 'text', body: null, mediaUrl: null, whatsappId: 'W1', ...over });

describe('quoted attachments, like WhatsApp', () => {
  it('names a quoted sticker, photo, video or document by its kind, with a thumbnail for pictures and clips', () => {
    const sticker = msg({ type: 'image', body: 'Figurinha recebida', mediaUrl: 'data:image/webp;base64,UklGRg==' });
    const quote = quotedPreview({ whatsappId: 'W1', participant: null, body: 'Figurinha recebida' }, [sticker], 'Maria');
    expect(quote).toMatchObject({ author: 'Maria', text: 'Figurinha', kind: 'sticker', targetId: 'm1' });
    const html = renderToStaticMarkup(<QuoteContent quote={quote} getToken={async () => null} />);
    expect(html).toContain('message-quote-thumb'); expect(html).toContain('data:image/webp');
    const doc = msg({ type: 'file', body: 'Proposta.pdf', attachment: { mimeType: 'application/pdf', fileName: 'Proposta.pdf' } });
    expect(quotedPreview({ whatsappId: 'W1', participant: null, body: null }, [doc], null)).toMatchObject({ text: 'Proposta.pdf', kind: 'file' });
    const video = msg({ type: 'file', body: 'Vídeo recebido', attachment: { mimeType: 'video/mp4' } });
    expect(quotedPreview({ whatsappId: 'W1', participant: null, body: 'Vídeo recebido' }, [video], null)).toMatchObject({ text: 'Vídeo', kind: 'video' });
  });
  it('keeps plain text quotes as they were', () => {
    const quote = quotedPreview({ whatsappId: 'W1', participant: null, body: 'Bom dia' }, [msg({ body: 'Bom dia' })], 'Maria');
    expect(quote).toMatchObject({ text: 'Bom dia', kind: null });
    expect(renderToStaticMarkup(<QuoteContent quote={quote} getToken={async () => null} />)).not.toContain('message-quote-thumb');
  });
  it('shows a video as a play tile with its length before it is played', () => {
    const html = renderToStaticMarkup(<InboxMedia message={msg({ type: 'file', body: 'Vídeo recebido', mediaUrl: 'https://x.test/v', attachment: { mimeType: 'video/mp4', durationSeconds: 5 } })} getToken={async () => null} />);
    expect(html).toContain('Reproduzir vídeo'); expect(html).toContain('0:05'); expect(html).toContain('talk-video-play');
  });
});
