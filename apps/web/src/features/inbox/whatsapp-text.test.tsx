import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseWhatsappText, serializeWhatsappText, WhatsappText } from './whatsapp-text';
describe('visual WhatsApp formatting', () => {
  it.each(['Olá *amigo*', 'Oi _tudo bem_', '*_Os dois_*', 'linha 1\nlinha 2', 'tubo 10*20*30 e item_123', '<img src=x onerror=alert(1)>'])('round trips %s', text => {
    expect(serializeWhatsappText(parseWhatsappText(text))).toBe(text);
  });
  it('renders bold and italic safely, not raw HTML', () => {
    const html = renderToStaticMarkup(<WhatsappText text={'*Olá* _amigo_ <script>alert(1)</script>'} />);
    expect(html).toContain('<strong>Olá</strong>'); expect(html).toContain('<em>amigo</em>'); expect(html).not.toContain('<script>');
  });
  it('does not format measurements or underscores inside words', () => {
    expect(renderToStaticMarkup(<WhatsappText text="10*20*30 nome_do_item" />)).not.toContain('<strong>');
    expect(renderToStaticMarkup(<WhatsappText text="nome_do_item" />)).not.toContain('<em>');
  });
  it('keeps a continuous bold word when italic changes inside it', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Jo', marks: [{ type: 'bold' }] }, { type: 'text', text: 'ão', marks: [{ type: 'bold' }, { type: 'italic' }] }] }] };
    expect(serializeWhatsappText(doc)).toBe('*Jo_ão_*');
  });
});
