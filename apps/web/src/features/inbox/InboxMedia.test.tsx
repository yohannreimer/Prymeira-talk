import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageDto } from '@prymeira-talk/shared';
import { InboxMedia, mediaCaption, mediaFileName, audioTime } from './InboxMedia';
import { contactInitials } from './ContactAvatar';
const base = { id: 'm', conversationId: 'c', workspaceId: 'w', direction: 'inbound', status: 'delivered', createdAt: '2026-09-14T12:00:00Z', providerMessageId: null, sentByUserId: null } as const;
describe('WhatsApp-style attachments', () => {
  it.each(['video/mp4', 'application/pdf'])('preserves raw %s presentation when compact metadata has a generic MIME', mimeType => {
    const original: MessageDto = { ...base, type: 'file', body: mimeType.startsWith('video/') ? 'Vídeo recebido' : 'Segue a proposta',
      mediaUrl: `data:${mimeType};base64,YQ==`, attachment: { mimeType: 'application/octet-stream' } };
    const compact = { ...original, mediaUrl: `https://talk.example.test/api/conversations/c/messages/m/media?v=source&previewMime=${encodeURIComponent(mimeType)}` };
    const rawHtml = renderToStaticMarkup(<InboxMedia message={original} getToken={async () => null} />);
    const compactHtml = renderToStaticMarkup(<InboxMedia message={compact} getToken={async () => null} />);
    if (mimeType.startsWith('video/')) {
      expect(rawHtml).toContain('talk-video-preview'); expect(compactHtml).toContain('Reproduzir vídeo');
      expect(compactHtml).not.toContain('Abrir documento');
    } else {
      expect(mediaFileName(original)).toBe('Documento.pdf'); expect(mediaFileName(compact)).toBe('Documento.pdf');
      expect(rawHtml).toContain('PDF'); expect(compactHtml).toContain('PDF');
    }
    expect(compact.attachment?.mimeType).toBe('application/octet-stream');
  });
  it('identifies compact PDFs by MIME while preserving filenames and captions without a URL extension', () => {
    const message: MessageDto = { ...base, type: 'file', body: 'Segue a proposta',
      mediaUrl: 'https://talk.example.test/api/conversations/c/messages/m/media?v=source', attachment: { mimeType: 'application/pdf' } };
    expect(mediaFileName(message)).toBe('Documento.pdf'); expect(mediaCaption(message)).toBe('Segue a proposta');
    const named = { ...message, attachment: { ...message.attachment, fileName: 'Proposta', caption: 'Legenda preservada' } };
    expect(mediaFileName(named)).toBe('Proposta'); expect(mediaCaption(named)).toBe('Legenda preservada');
    const html = renderToStaticMarkup(<InboxMedia message={named} getToken={async () => null} />);
    expect(html).toContain('PDF'); expect(html).toContain('Abrir documento'); expect(html).not.toContain('data:');
  });
  it('preserves a PDF caption separately from its filename', () => {
    const message = { type: 'file' as const, body: 'Cotação.pdf', attachment: { fileName: 'Cotação.pdf', caption: 'Conforme solicitado.' } };
    expect(mediaFileName(message)).toBe('Cotação.pdf'); expect(mediaCaption(message)).toBe('Conforme solicitado.');
  });
  it('uses contact name initials, never database IDs or phone digits', () => {
    expect(contactInitials('Ana Silva')).toBe('AS'); expect(contactInitials('5511999999999')).toBeNull(); expect(contactInitials(null)).toBeNull();
  });
  it('renders OGG with an in-app play action without claiming transcription is running', () => {
    const html = renderToStaticMarkup(<InboxMedia message={{ ...base, type: 'audio', body: 'Áudio recebido', mediaUrl: 'data:audio/ogg;base64,YQ==' }} getToken={async () => null} />);
    expect(html).toContain('Reproduzir áudio');
    expect(html).toContain('Ver transcrição');
    expect(html).not.toContain('Processando áudio');
    expect(html).not.toContain('Abrir áudio original');
  });
  it('renders a PDF filename only once and offers opening and downloading', () => {
    const message: MessageDto = { ...base, type: 'file', body: 'Cotação.pdf', mediaUrl: 'data:application/pdf;base64,YQ==' };
    const html = renderToStaticMarkup(<InboxMedia message={message} getToken={async () => null} />);
    expect(html.match(/Cotação.pdf/g)).toHaveLength(1);
    expect(html).toContain('Abrir documento'); expect(html).toContain('Baixar documento');
    expect(mediaCaption(message)).toBeNull();
  });
  it('recognizes a video from the attachment MIME type without relying on its URL', () => {
    const message: MessageDto = { ...base, type: 'file', body: 'Vídeo recebido',
      mediaUrl: 'https://example.test/media/encrypted', attachment: { mimeType: 'video/mp4' } };
    const html = renderToStaticMarkup(<InboxMedia message={message} getToken={async () => null} />);
    expect(html).toContain('Reproduzir vídeo');
    expect(html).not.toContain('Abrir documento');
    expect(mediaCaption(message)).toBeNull();
  });
  it('hides image placeholders but preserves a real caption and never invents a filename from prose', () => {
    expect(mediaCaption({ type: 'image', body: 'Imagem recebida' })).toBeNull();
    expect(mediaCaption({ type: 'image', body: 'Favor cotar estas medidas' })).toBe('Favor cotar estas medidas');
    expect(mediaFileName({ type: 'file', body: 'Segue a proposta', mediaUrl: 'data:application/pdf;base64,YQ==' })).toBe('Documento.pdf');
    expect(mediaCaption({ type: 'file', body: 'Segue a proposta' })).toBe('Segue a proposta');
  });
  it('formats real durations safely', () => {
    expect(audioTime(73)).toBe('1:13'); expect(audioTime(NaN)).toBe('0:00'); expect(audioTime(Infinity)).toBe('0:00');
  });
  it('offers playback without a transcription write in read-only supervision transport', () => {
    const html = renderToStaticMarkup(<InboxMedia
      message={{ ...base, type: 'audio', body: 'Áudio recebido', mediaUrl: null }}
      getToken={async () => null}
      transport={{ media: async () => new Blob(), preview: async () => ({ imageUrl: '', pages: 1 }) }} />);
    expect(html).toContain('Reproduzir áudio');
    expect(html).not.toContain('Ver transcrição');
    expect(html).not.toContain('Transcrevendo');
  });
});
