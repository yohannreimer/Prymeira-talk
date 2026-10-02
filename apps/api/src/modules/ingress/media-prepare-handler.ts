import type { WahaClient } from '../waha/waha.client.js';
import type { EvolutionClient } from '../evolution/evolution.client.js';
import type { MessageMediaService, ProviderFetcher } from '../conversations/message-media.js';
import type { ReceiptPayload } from './normalization.js';
import type { EffectHandler } from './effect-runner.js';

/** Handler of the `media.prepare` obligation created in the same transaction as the Message.
 * It re-reads the authenticated event from the private receipt (never from the queue), asks the
 * provider that actually received the message for the bytes, and persists them durably. Outcomes:
 * stored -> done; transient -> retry with backoff; limit/unsupported -> failed, visible and requeueable.
 * Dependent effects (agent, assistant) wait for a terminal state, so unprepared media is never
 * mistaken for understood content. */
export function createMediaPrepareHandler(deps: {
  journal: { readPayload(receiptId: string): Promise<{ payload: ReceiptPayload }> };
  media: MessageMediaService;
  waha: Pick<WahaClient, 'mediaExact'> | null;
  evolution: Pick<EvolutionClient, 'fetchMedia'> | null;
}): EffectHandler {
  return async effect => {
    if (!effect.messageId) return { status: 'failed', errorCode: 'EFFECT_WITHOUT_MESSAGE' };
    const fetchers: ProviderFetcher[] = [];
    let useStoredUrl = true;
    const receiptId = effect.frozen.privateReceiptId, eventIndex = effect.frozen.eventIndex;
    if (typeof receiptId === 'string' && Number.isInteger(eventIndex)) {
      const { payload } = await deps.journal.readPayload(receiptId);
      const result = payload.events[eventIndex as number];
      if (result?.kind === 'accepted' && result.event.kind === 'message') {
        const { context, key, attachment } = result.event;
        if (context.provider === 'waha') useStoredUrl = false;
        if (context.provider === 'waha' && deps.waha) {
          const waha = deps.waha;
          fetchers.push({ name: 'waha', async fetch() {
            const found = await waha.mediaExact({ session: context.sessionName, key, purpose: 'serve' });
            if (found.kind !== 'resolved') return null;
            return { bytes: found.bytes, mimeType: found.message.media?.mimetype ?? attachment.mimeType ?? null };
          } });
        } else if (context.provider === 'evolution' && context.channelProvider === 'evolution' && deps.evolution?.fetchMedia && key.nativeId) {
          const evolution = deps.evolution, id = key.nativeId;
          fetchers.push({ name: 'evolution', async fetch() { return { mediaUrl: await evolution.fetchMedia!({ instanceName: context.sessionName, id }) }; } });
        }
      }
    }
    const outcome = await deps.media.prepare({ workspaceId: effect.workspaceId, messageId: effect.messageId, fetchers, useStoredUrl });
    if (outcome.state === 'stored') {
      return outcome.playback === 'failed' ? { status: 'retry', errorCode: 'PLAYBACK_FAILED' } : { status: 'done', result: { state: 'stored', playback: outcome.playback } };
    }
    return outcome.retryable ? { status: 'retry', errorCode: outcome.errorCode } : { status: 'failed', errorCode: outcome.errorCode, result: { state: outcome.state } };
  };
}
