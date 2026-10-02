import { describe, expect, it } from 'vitest';
import { usableContactName } from './contact-name.js';

describe('usableContactName', () => {
  it.each([
    [undefined], [null], [''], ['   '], ['\n\t ']
  ])('rejects empty value %j', (value) => {
    expect(usableContactName(value)).toBeNull();
  });

  it.each([
    'Você', 'Voce', 'você', 'VOCÊ', ' Você ', 'Você!', '(Você)', '~Você', 'Você 👋', '😀 Você',
    'You', 'you', 'YOU', 'Vc', 'vc', 'Eu', 'eu', 'Me', 'Meu', 'Ninguém', 'ninguem',
    'Unknown', 'Desconhecido', 'null', 'NULL', 'undefined'
  ])('rejects placeholder word %j', (value) => {
    expect(usableContactName(value)).toBeNull();
  });

  it.each([
    '103547450441825@lid', '556392370750@s.whatsapp.net', '556392370750@c.us', '120363000000000000@g.us',
    'Cliente 103547450441825@lid', '5563@S.WHATSAPP.NET'
  ])('rejects WhatsApp id %j', (value) => {
    expect(usableContactName(value)).toBeNull();
  });

  it.each([
    '556392370750', '+55 63 9237-0750', '+55 (63) 99237-0750', '(63) 9237.0750', '9237-0750', '1234567'
  ])('rejects phone-like value %j', (value) => {
    expect(usableContactName(value)).toBeNull();
  });

  it.each([
    'José', 'Ana', 'Metalpress', 'Agnaldo - Teporti', 'Compras - Cesar', 'Juliana - Metal MIB',
    '🏄‍♂️Alexei', '3M Brasil', 'Ativig 1AA', 'Você Silva', 'Eu Mesmo Ltda', 'Loja 123', 'Agnaldo (63) 9237'
  ])('keeps real name %j unchanged', (value) => {
    expect(usableContactName(value)).toBe(value);
  });

  it('trims and collapses whitespace', () => {
    expect(usableContactName('  Ana   Maria\t Souza \n')).toBe('Ana Maria Souza');
  });

  it('truncates long names instead of rejecting them', () => {
    const long = 'A'.repeat(250);
    expect(usableContactName(long)).toBe('A'.repeat(200));
    expect(usableContactName(`Ana ${'B'.repeat(196)} Souza`)).toHaveLength(200);
  });
});
