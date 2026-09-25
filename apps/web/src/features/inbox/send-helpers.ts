import type { ContactDto } from '@prymeira-talk/shared';
import { apiCreateContact, apiGetContacts } from '../../app/api';

export function normalizeRecipientPhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  const international = (digits.length === 10 || digits.length === 11) && /^[1-9]{2}/.test(digits)
    ? `55${digits}` : digits;
  if ((international.length !== 12 && international.length !== 13) || !international.startsWith('55') || !/^[1-9]{2}/.test(international.slice(2, 4))) return null;
  return international.length === 13 && international[4] === '9'
    ? `${international.slice(0, 4)}${international.slice(5)}` : international;
}

export async function findOrCreateRecipient(getToken: () => Promise<string | null>, phone: string): Promise<ContactDto> {
  const normalized = normalizeRecipientPhone(phone);
  if (!normalized) throw new Error('Digite um telefone brasileiro válido com DDD.');
  const matches = await apiGetContacts(getToken, normalized.slice(-8));
  const existing = matches.find((contact) => normalizeRecipientPhone(contact.phone) === normalized);
  return existing ?? apiCreateContact(getToken, { phone: normalized });
}
