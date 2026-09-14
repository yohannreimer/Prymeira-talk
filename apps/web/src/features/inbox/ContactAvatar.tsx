import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { UserRound } from 'lucide-react';
import { apiGetContactPhoto } from '../../app/api';
import { mediaDataUrl } from './media-data-url';

type PhotoLoader = (id: string) => Promise<string | null>;
const PhotoContext = createContext<PhotoLoader | null>(null);
export function ContactPhotoProvider({ getToken, children }: { getToken: () => Promise<string | null>; children: ReactNode }) {
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const [loader] = useState(() => {
    const cache = new Map<string, Promise<string | null>>();
    let abort = new AbortController();
    let chain = Promise.resolve();
    return {
      start() { if (abort.signal.aborted) abort = new AbortController(); },
      clear() { abort.abort(); cache.clear(); },
      load(id: string) {
        if (cache.has(id)) return cache.get(id)!;
        const signal = abort.signal;
        // Serial provider lookup avoids a burst when opening a long contact list.
        const task = chain.then(async () => {
          if (signal.aborted) return null;
          try {
            const blob = await apiGetContactPhoto(id, () => tokenRef.current(), signal);
            if (!blob || signal.aborted) return null;
            const url = await mediaDataUrl(blob); return signal.aborted ? null : url;
          } catch { return null; }
        });
        chain = task.then(() => {}); cache.set(id, task); return task;
      }
    };
  });
  useEffect(() => { loader.start(); return () => loader.clear(); }, [loader]);
  return <PhotoContext.Provider value={loader.load}>{children}</PhotoContext.Provider>;
}

export function contactInitials(name?: string | null) {
  const parts = name?.trim().split(/\s+/).filter(part => /\p{L}/u.test(part));
  return parts?.slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase() || null;
}
export function ContactAvatar({ conversationId, name, className }: { conversationId?: string; name?: string | null; className: string }) {
  const load = useContext(PhotoContext);
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!load || !conversationId || !ref.current) return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void load(conversationId).then(photo => { if (active) setUrl(photo); });
    });
    observer.observe(ref.current);
    return () => { active = false; observer.disconnect(); };
  }, [load, conversationId]);
  return <span ref={ref} className={`${className} talk-contact-photo`} aria-hidden="true">
    {url ? <img src={url} alt="" onError={() => setUrl(null)} /> : contactInitials(name) || <UserRound size={18} />}
  </span>;
}
