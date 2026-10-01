import type { NormalizationResult, NormalizedMessagingEvent, TrustedMessagingContext } from '../messaging/normalized-event.js';
import { normalizeEvolutionWebhook } from '../evolution/evolution-event-normalizer.js';
import { normalizeWahaEvent } from '../waha/waha-normalizer.js';
import { normalizeChatAddress, record } from '../messaging/whatsapp-identity.js';

export type ReceiptEvent = NormalizationResult;
export interface ReceiptPayload { version: 1; events: ReceiptEvent[] }

/** Direct Meta has its own provider-native namespace. A batch is retained as one
 * receipt with ordered event positions; no timestamp/text deduplication. */
function normalizeMeta(context: TrustedMessagingContext, input: unknown): ReceiptEvent[] {
  const results: ReceiptEvent[] = [];
  for (const entry of Array.isArray(record(input).entry) ? record(input).entry as unknown[] : []) {
    for (const change of Array.isArray(record(entry).changes) ? record(entry).changes as unknown[] : []) {
      const value = record(record(change).value), metadata = record(value.metadata);
      if (context.provider !== 'meta_official' || metadata.phone_number_id !== context.phoneNumberId) {
        throw new Error('meta_phone_number_mismatch');
      }
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const item of messages) {
        const message = record(item), text = record(message.text), address = typeof message.from === 'string' ? normalizeChatAddress(`${message.from}@s.whatsapp.net`) : null;
        if (message.type !== 'text' || typeof text.body !== 'string' || typeof message.id !== 'string' || !address) {
          results.push({ kind: 'ignored', reason: 'unsupported_meta_message' }); continue;
        }
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const contact = contacts.find(c => record(c).wa_id === message.from);
        const profileName = record(record(contact).profile).name;
        const timestamp = typeof message.timestamp === 'string' ? Number(message.timestamp) * 1000 : NaN;
        results.push({ kind: 'accepted', event: { context, providerEventId: message.id, providerEventType: 'messages', addressMappings: [],
          kind: 'message', key: { identityFormat: 'provider_native', nativeId: message.id, rawId: null,
            nativeChatAddress: address, chatAddress: address, direction: 'inbound', senderParticipant: '', nativeSenderParticipant: null },
          content: { type: 'text', body: text.body, preview: text.body, mediaUrl: null }, attachment: {}, media: null,
          currentRevision: null, pushName: typeof profileName === 'string' ? profileName : null, source: null,
          order: { timestampMs: Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e15 ? timestamp : null, sequence: null }
        } });
      }
      if (Array.isArray(value.statuses) && value.statuses.length) results.push({ kind: 'ignored', reason: 'meta_status_requires_application_adapter' });
    }
  }
  return results.length ? results : [{ kind: 'ignored', reason: 'unsupported_meta_event' }];
}
export function normalizeReceipt(context: TrustedMessagingContext, input: unknown): ReceiptPayload {
  const events = context.provider === 'evolution' ? [normalizeEvolutionWebhook(context, input)]
    : context.provider === 'waha' ? [normalizeWahaEvent(context, input)] : normalizeMeta(context, input);
  return { version: 1, events };
}
export function eventKey(event: NormalizedMessagingEvent) {
  return event.kind === 'message' ? event.key : event.kind === 'control' ? null : event.target;
}
