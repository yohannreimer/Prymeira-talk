import type { WahaClient } from '../waha/waha.client.js';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import type { MessageMediaService, ProviderFetcher } from '../conversations/message-media.js';
import type { ReceiptPayload } from './normalization.js';
import type { WhatsAppMessageKey } from '../messaging/whatsapp-identity.js';
import type { EffectHandler } from './effect-runner.js';

/** Handler of the `media.prepare` obligation created in the same transaction as the Message.
 * It re-reads the authenticated event from the private receipt (never from the queue), asks the
 * provider that actually received the message for the bytes, and persists them durably. Outcomes:
 * stored -> done; transient -> retry with backoff; limit/unsupported -> failed, visible and requeueable.
 * Dependent effects (agent, assistant) wait for a terminal state, so unprepared media is never
 * mistaken for understood content. */
export function createMediaPrepareHandler(deps: {
  /** Only needed for effects created before `frozen.mediaSource` existed. */
  journal?: { readPayload(receiptId: string): Promise<{ payload: ReceiptPayload }> };
  media: MessageMediaService;
  waha: Pick<WahaClient, 'mediaExact'> | null;
  evolution: Pick<EvolutionClient, 'fetchMedia'> | null;
}): EffectHandler {
  return async effect => {
    if (!effect.messageId) return { status: 'failed', errorCode: 'EFFECT_WITHOUT_MESSAGE' };
    const fetchers: ProviderFetcher[] = [];
    let useStoredUrl = true;
    let source = readFrozenSource(effect.frozen.mediaSource);
    if (!source && deps.journal) {
      const receiptId = effect.frozen.privateReceiptId, eventIndex = effect.frozen.eventIndex;
      if (typeof receiptId === 'string' && Number.isInteger(eventIndex)) {
        const { payload } = await deps.journal.readPayload(receiptId);
        const result = payload.events[eventIndex as number];
        if (result?.kind === 'accepted' && result.event.kind === 'message') {
          const { context, key, attachment } = result.event;
          source = { provider: context.provider, channelProvider: context.channelProvider, sessionName: context.sessionName, key, mimeType: attachment.mimeType ?? null };
        }
      }
    }
    if (source) {
      const { key } = source;
      if (source.provider === 'waha') useStoredUrl = false;
      if (source.provider === 'waha' && deps.waha) {
        const waha = deps.waha;
        fetchers.push({ name: 'waha', async fetch() {
          const found = await waha.mediaExact({ session: source!.sessionName, key, purpose: 'serve' });
          if (found.kind !== 'resolved') return null;
          return { bytes: found.bytes, mimeType: found.message.media?.mimetype ?? source!.mimeType };
        } });
      } else if (source.provider === 'evolution' && source.channelProvider === 'evolution' && deps.evolution?.fetchMedia && key.nativeId) {
        const evolution = deps.evolution, id = key.nativeId;
        fetchers.push({ name: 'evolution', async fetch() { return { mediaUrl: await evolution.fetchMedia!({ instanceName: source!.sessionName, id }) }; } });
      }
    }
    const outcome = await deps.media.prepare({ workspaceId: effect.workspaceId, messageId: effect.messageId, fetchers, useStoredUrl });
    if (outcome.state === 'stored') {
      // The original is safe and is what the AI reads, so dependents must not wait for a missing playback
      // derivative: the media endpoint converts it on demand (and records PLAYBACK_FAILED for operators).
      return { status: 'done', result: { state: 'stored', playback: outcome.playback } };
    }
    return outcome.retryable ? { status: 'retry', errorCode: outcome.errorCode } : { status: 'failed', errorCode: outcome.errorCode, result: { state: outcome.state } };
  };
}

type FrozenSource = { provider: string; channelProvider: string; sessionName: string; key: WhatsAppMessageKey; mimeType: string | null };
function readFrozenSource(value: unknown): FrozenSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== 'string' || typeof v.sessionName !== 'string' || typeof v.key !== 'object' || v.key === null) return null;
  return { provider: v.provider, channelProvider: typeof v.channelProvider === 'string' ? v.channelProvider : '', sessionName: v.sessionName,
    key: v.key as WhatsAppMessageKey, mimeType: typeof v.mimeType === 'string' ? v.mimeType : null };
}
