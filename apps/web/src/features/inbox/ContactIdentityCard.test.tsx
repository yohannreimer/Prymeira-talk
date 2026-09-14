import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContactIdentityCard, contactNameError } from './ContactIdentityCard';

describe('inbox contact identity', () => {
  it('offers editing beside the contact without leaving the conversation', () => {
    const onSave = vi.fn();
    const html = renderToStaticMarkup(<ContactIdentityCard contactId="c1" name="Ana Silva" phone="5547999999999" channelName="Geral Villefer" onSave={onSave} />);
    expect(html).toContain('Ana Silva'); expect(html).toContain('5547999999999');
    expect(html).toContain('Geral Villefer'); expect(html).toContain('Editar nome');
    expect(html).not.toContain('C1'); expect(onSave).not.toHaveBeenCalled();
  });
  it('makes the missing name explicit instead of displaying an internal id', () => {
    const html = renderToStaticMarkup(<ContactIdentityCard contactId="secret-id" name={null} phone="5547999999999" onSave={vi.fn()} />);
    expect(html).toContain('Contato sem nome'); expect(html).toContain('Adicionar nome');
    expect(html).not.toContain('secret-id');
  });
  it('escapes provider names', () => {
    const html = renderToStaticMarkup(<ContactIdentityCard contactId="c" name="<script>alert(1)</script>" phone={null} onSave={vi.fn()} />);
    expect(html).not.toContain('<script>');
  });
  it('validates the trimmed name before saving', () => {
    expect(contactNameError('   ')).toBe('Digite o nome do contato.');
    expect(contactNameError('a'.repeat(201))).toBe('Use até 200 caracteres.');
    expect(contactNameError(' Ana Silva ')).toBeNull();
  });
});
