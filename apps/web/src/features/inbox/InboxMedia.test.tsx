import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageDto } from '@prymeira-talk/shared';
import { InboxMedia, mediaCaption, mediaFileName, audioTime } from './InboxMedia';
import { contactInitials } from './ContactAvatar';
const base = { id: 'm', conversationId: 'c', workspaceId: 'w', direction: 'inbound', status: 'delivered', createdAt: '2026-09-14T12:00:00Z', providerMessageId: null, sentByUserId: null } as const;
describe('WhatsApp-style attachments', () => {
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
  it('hides image placeholders but preserves a real caption and never invents a filename from prose', () => {
    expect(mediaCaption({ type: 'image', body: 'Imagem recebida' })).toBeNull();
    expect(mediaCaption({ type: 'image', body: 'Favor cotar estas medidas' })).toBe('Favor cotar estas medidas');
    expect(mediaFileName({ type: 'file', body: 'Segue a proposta', mediaUrl: 'data:application/pdf;base64,YQ==' })).toBe('Documento.pdf');
    expect(mediaCaption({ type: 'file', body: 'Segue a proposta' })).toBe('Segue a proposta');
  });
  it('formats real durations safely', () => {
    expect(audioTime(73)).toBe('1:13'); expect(audioTime(NaN)).toBe('0:00'); expect(audioTime(Infinity)).toBe('0:00');
  });
});
