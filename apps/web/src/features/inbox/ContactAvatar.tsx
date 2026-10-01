import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { UserRound } from 'lucide-react';
import { apiGetContactPhoto, apiGetSavedContactPhoto } from '../../app/api';
import { SessionBlobCache } from '../../app/session/blob-cache';
import { BlobCacheContext } from '../../app/session/blob-cache-context';
import { createContactPhotoLoader } from './contact-photo-loader';

type PhotoLoader = (id: string) => Promise<string | null>;
const PhotoContext = createContext<PhotoLoader | null>(null);
export function ContactPhotoProvider({ getToken, children, cache: sharedCache }: { getToken: () => Promise<string | null>; children: ReactNode; cache?: SessionBlobCache }) {
  const inherited = useContext(PhotoContext);
  if (inherited && !sharedCache) return <>{children}</>;
  return <OwnedContactPhotoProvider getToken={getToken} cache={sharedCache}>{children}</OwnedContactPhotoProvider>;
}
function OwnedContactPhotoProvider({ getToken, children, cache: sharedCache }: { getToken: () => Promise<string | null>; children: ReactNode; cache?: SessionBlobCache }) {
  const [localCache] = useState(() => new SessionBlobCache());
  const cache = sharedCache ?? localCache;
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const [loader] = useState(() => createContactPhotoLoader(async (id, signal) => {
    const cached = cache.get(`photo:${id}`); if (cached) return cached.url;
    const blob = id.startsWith('contact:')
      ? await apiGetSavedContactPhoto(id.slice('contact:'.length), () => tokenRef.current(), signal)
      : await apiGetContactPhoto(id, () => tokenRef.current(), signal);
    if (!blob || signal.aborted) return null;
    const { url } = await cache.load(`photo:${id}`, async () => blob);
    return signal.aborted ? null : url;
  }, id => Boolean(cache.get(`photo:${id}`))));
  useEffect(() => { loader.start(); return () => { loader.clear(); if (!sharedCache) localCache.clear(); }; }, [loader, sharedCache, localCache]);
  return <BlobCacheContext.Provider value={cache}><PhotoContext.Provider value={loader.load}>{children}</PhotoContext.Provider></BlobCacheContext.Provider>;
}

export function contactInitials(name?: string | null) {
  const parts = name?.trim().split(/\s+/).filter(part => /\p{L}/u.test(part));
  return parts?.slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase() || null;
}
export function ContactAvatar({ conversationId, contactId, name, className }: { conversationId?: string; contactId?: string; name?: string | null; className: string }) {
  const load = useContext(PhotoContext);
  const cache = useContext(BlobCacheContext);
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    const photoId = contactId ? `contact:${contactId}` : conversationId;
    if (!load || !photoId || !ref.current) return;
    let active = true;
    let visible = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      void load(photoId).then(photo => {
        if (!active || !visible) return;
        setUrl(photo);
        if (!photo) retryTimer = setTimeout(attempt, 5 * 60_000);
      }).catch(() => {
        if (active && visible) retryTimer = setTimeout(attempt, 30_000);
      });
    };
    const observer = new IntersectionObserver(entries => {
      const nextVisible = entries.some(entry => entry.isIntersecting);
      if (nextVisible === visible) return;
      visible = nextVisible;
      if (visible) {
        cache?.retain(`photo:${photoId}`);
        if (cache && !cache.get(`photo:${photoId}`)) setUrl(null);
        attempt();
      } else {
        cache?.release(`photo:${photoId}`);
        if (retryTimer) clearTimeout(retryTimer);
      }
    });
    observer.observe(ref.current);
    return () => { active = false; observer.disconnect(); if (visible) cache?.release(`photo:${photoId}`); if (retryTimer) clearTimeout(retryTimer); };
  }, [load, conversationId, contactId, cache]);
  return <span ref={ref} className={`${className} talk-contact-photo`} aria-hidden="true">
    {url ? <img src={url} loading="lazy" decoding="async" alt="" onError={() => setUrl(null)} /> : contactInitials(name) || <UserRound size={18} />}
  </span>;
}
