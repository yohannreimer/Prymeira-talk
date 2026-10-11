import type { EvolutionHistorySource, HistoryRecord } from '../evolution/evolution-history.js';
import { parseWahaMessageKey } from '../messaging/whatsapp-identity.js';
import type { WahaClient } from '../waha/waha.client.js';
import type { DeliveryProbe } from './outbound-router.js';

/** Looks in a connection's own recent chat history for the text we just tried to send. Deliberately only for
 * text, only fromMe, only after the send started, and only with an exact body match: a media or contact send
 * cannot be recognised that safely, so those answer 'unknown' and stay for operator review. A wrong "found"
 * would hide a message that never reached the customer, which is worse than asking a person to look. */

const SLACK_SECONDS = 5;
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

function historyText(record: HistoryRecord): string | null {
  const message = record.message as { conversation?: unknown; extendedTextMessage?: { text?: unknown } };
  if (typeof message.conversation === 'string') return message.conversation;
  return typeof message.extendedTextMessage?.text === 'string' ? message.extendedTextMessage.text : null;
}

export function createDeliveryProbe(deps: {
  waha: Pick<WahaClient, 'getMessages'> | null;
  history: Pick<EvolutionHistorySource, 'recentMessages'> | null;
}): DeliveryProbe {
  return async ({ connection, destination, kind, text, since }) => {
    if (kind !== 'text' || !text) return 'unknown';
    const wanted = normalize(text);
    const sinceSeconds = Math.floor(since.getTime() / 1000) - SLACK_SECONDS;
    if (connection.provider === 'waha') {
      if (!deps.waha) return 'unknown';
      const chatId = destination.includes('@') ? destination : `${destination.replace(/\D/g, '')}@c.us`;
      const messages = await deps.waha.getMessages({ session: connection.sessionName, chatId, limit: 20 });
      const match = messages.find(message => message.fromMe === true && typeof message.timestamp === 'number' && message.timestamp >= sinceSeconds && normalize(message.body ?? '') === wanted);
      return { found: !!match, providerMessageId: match ? parseWahaMessageKey(match.id).rawId ?? match.id : null };
    }
    // Evolution history only lists direct chats; a group destination cannot be checked this way.
    if (!deps.history || destination.includes('@')) return 'unknown';
    const records = await deps.history.recentMessages({ instanceName: connection.sessionName, remoteJid: `${destination.replace(/\D/g, '')}@s.whatsapp.net`, limit: 20 });
    const match = records.find(record => record.key.fromMe && record.messageTimestamp >= sinceSeconds && normalize(historyText(record) ?? '') === wanted);
    return { found: !!match, providerMessageId: match?.key.id ?? null };
  };
}
