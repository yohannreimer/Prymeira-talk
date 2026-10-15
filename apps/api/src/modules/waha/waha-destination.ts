import { canonicalizePhone } from '../contacts/phone-normalization.js';
import type { WahaClient } from './waha.client.js';

/** This failure happens before a send request: it cannot have delivered a message. */
export class WahaDestinationError extends Error {
  readonly code = 'WAHA_DESTINATION_UNRESOLVED';
  readonly statusCode = 422;
  constructor() {
    super('Não foi possível confirmar o destinatário no WhatsApp. Nenhuma mensagem foi enviada.');
    this.name = 'WahaDestinationError';
  }
}

/** Contact storage folds Brazilian ninth-digit variants together. That key is not a transport address:
 * GOWS rejects some folded numbers with "no LID found". Ask this session for the actual chat identity.
 * Explicit identities already chosen by canonical routing (including groups) must stay exact. */
export async function resolveWahaDestination(client: Partial<Pick<WahaClient, 'checkNumber'>>, session: string, destination: string) {
  if (destination.includes('@')) return destination;
  const phone = destination.replace(/\D/g, '');
  if (!client.checkNumber) return `${phone}@c.us`; // Compatibility with legacy adapters without number lookup.
  try {
    const result = await client.checkNumber({ session, phone });
    if (!result.numberExists || !result.chatId || !/^\d+@(lid|c\.us|s\.whatsapp\.net)$/.test(result.chatId)) throw new WahaDestinationError();
    const pn = result.pn ?? (result.chatId.endsWith('@lid') ? null : result.chatId);
    if (pn && canonicalizePhone(pn.split('@')[0]!) !== canonicalizePhone(phone)) throw new WahaDestinationError();
    return result.chatId.replace('@s.whatsapp.net', '@c.us');
  } catch {
    // Even a lookup timeout is known not to have sent anything; do not put it in the uncertain-send queue.
    throw new WahaDestinationError();
  }
}
