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
  it('says when the follow-up AI treats the contact as internal or personal, with a way back', () => {
    const html = renderToStaticMarkup(<ContactIdentityCard contactId="c" name="Marcos" phone={null} onSave={vi.fn()}
      followupAudience={{ kind: 'internal_personal', source: 'ai' }} onMarkCustomer={vi.fn()} />);
    expect(html).toContain('A IA trata este contato como interno ou pessoal e não sugere follow-up.');
    expect(html).toContain('É cliente');
  });
  it('shows nothing about follow-up for a customer or an unknown audience', () => {
    for (const followupAudience of [{ kind: 'customer' as const, source: 'manual' as const }, null, undefined]) {
      const html = renderToStaticMarkup(<ContactIdentityCard contactId="c" name="Ana" phone={null} onSave={vi.fn()}
        followupAudience={followupAudience} onMarkCustomer={vi.fn()} />);
      expect(html).not.toContain('follow-up'); expect(html).not.toContain('É cliente');
    }
  });
  it('validates the trimmed name before saving', () => {
    expect(contactNameError('   ')).toBe('Digite o nome do contato.');
    expect(contactNameError('a'.repeat(201))).toBe('Use até 200 caracteres.');
    expect(contactNameError(' Ana Silva ')).toBeNull();
  });
});
