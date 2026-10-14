import { useContext, useEffect, useState } from 'react';
import type { MessageDto } from '@prymeira-talk/shared';
import { apiGetInboxMedia, apiGetVideoPoster } from '../../app/api';
import { BlobCacheContext } from '../../app/session/blob-cache-context';
import { mediaKindIcons, type MediaKind } from './ConversationPreview';

type Quote = { author: string; text: string; target: MessageDto | null; kind: MediaKind | null };

/** A quoted attachment, like WhatsApp: its kind's icon before the text and, for pictures and clips, a thumbnail on the right. */
export function QuoteContent({ quote, getToken }: { quote: Quote; getToken: () => Promise<string | null> }) {
  const Icon = quote.kind ? mediaKindIcons[quote.kind] : null;
  const visual = quote.target && (quote.kind === 'image' || quote.kind === 'sticker' || quote.kind === 'video');
  return <>
    <span className="message-quote-main">
      <strong>{quote.author}</strong>
      <span className="message-quote-text">{Icon ? <Icon className="message-quote-kind" size={14} weight="fill" aria-hidden="true" /> : null}{quote.text}</span>
    </span>
    {visual ? <QuoteThumb message={quote.target!} video={quote.kind === 'video'} getToken={getToken} /> : null}
  </>;
}

function QuoteThumb({ message, video, getToken }: { message: MessageDto; video: boolean; getToken: () => Promise<string | null> }) {
  const cache = useContext(BlobCacheContext);
  // Same cache keys as the bubble itself, so a picture already on screen is not downloaded twice.
  const key = video ? `poster:${message.conversationId}:${message.id}` : `media:${message.conversationId}:${message.id}:${message.mediaSourceHash ?? message.mediaUrl ?? ''}`;
  const inline = !video && /^data:image\//i.test(message.mediaUrl ?? '') ? message.mediaUrl : null;
  const [url, setUrl] = useState<string | null>(() => inline ?? cache?.get(key)?.url ?? null);
  useEffect(() => {
    if (url || !cache) return;
    const abort = new AbortController();
    cache.retain(key);
    void cache.load(key, async () => video
      ? (await apiGetVideoPoster(message.conversationId, message.id, getToken, abort.signal)) ?? new Blob([])
      : apiGetInboxMedia(message.conversationId, message.id, getToken, abort.signal))
      .then(item => { if (!abort.signal.aborted && item.blob.size) setUrl(item.url); }).catch(() => {});
    return () => { abort.abort(); cache.release(key); };
  }, [key, url, cache]);
  useEffect(() => {
    if (!url || inline || !cache) return;
    cache.retain(key);
    return () => cache.release(key);
  }, [url, key, inline, cache]);
  return url ? <img className="message-quote-thumb" src={url} alt="" aria-hidden="true" /> : <span className="message-quote-thumb is-empty" aria-hidden="true" />;
}
