import type { EvolutionHistorySource, HistoryRecord } from '../evolution/evolution-history.js';
import { parseWahaMessageKey } from '../messaging/whatsapp-identity.js';
import type { WahaClient } from '../waha/waha.client.js';
import { resolveWahaDestination } from '../waha/waha-destination.js';
import type { DeliveryProbe } from './outbound-router.js';

/** Text and a timestamp do not identify a dispatch: another device can send the same text
 * concurrently, and provider clocks have only second precision. Confirm only a provider
 * message ID already correlated to this dispatch. A timeout without that identity stays uncertain. */
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

function historyText(record: HistoryRecord): string | null {
  const message = record.message as { conversation?: unknown; extendedTextMessage?: { text?: unknown } };
  if (typeof message.conversation === 'string') return message.conversation;
  return typeof message.extendedTextMessage?.text === 'string' ? message.extendedTextMessage.text : null;
}

export function createDeliveryProbe(deps: {
  waha: (Pick<WahaClient, 'getMessages'> & Partial<Pick<WahaClient, 'checkNumber'>>) | null;
  history: Pick<EvolutionHistorySource, 'recentMessages'> | null;
}): DeliveryProbe {
  return async ({ connection, destination, kind, text, since, providerMessageId }) => {
    if (kind !== 'text' || !text || !providerMessageId) return 'unknown';
    const wanted = normalize(text);
    const afterStart = (timestamp: number) => Number.isFinite(timestamp) && timestamp * 1000 > since.getTime();
    if (connection.provider === 'waha') {
      if (!deps.waha) return 'unknown';
      const chatId = await resolveWahaDestination(deps.waha, connection.sessionName, destination);
      const messages = await deps.waha.getMessages({ session: connection.sessionName, chatId, limit: 20 });
      const match = messages.find(message => message.fromMe === true && typeof message.timestamp === 'number' && afterStart(message.timestamp) && (parseWahaMessageKey(message.id).rawId ?? message.id) === providerMessageId && normalize(message.body ?? '') === wanted);
      return { found: !!match, providerMessageId: match ? parseWahaMessageKey(match.id).rawId ?? match.id : null };
    }
    // Evolution history only lists direct chats; a group destination cannot be checked this way.
    if (!deps.history || destination.includes('@')) return 'unknown';
    const records = await deps.history.recentMessages({ instanceName: connection.sessionName, remoteJid: `${destination.replace(/\D/g, '')}@s.whatsapp.net`, limit: 20 });
    const match = records.find(record => record.key.fromMe && afterStart(record.messageTimestamp) && record.key.id === providerMessageId && normalize(historyText(record) ?? '') === wanted);
    return { found: !!match, providerMessageId: match?.key.id ?? null };
  };
}
