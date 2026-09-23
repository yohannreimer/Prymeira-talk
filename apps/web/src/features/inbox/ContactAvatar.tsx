import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { UserRound } from 'lucide-react';
import { apiGetContactPhoto } from '../../app/api';
import { mediaDataUrl } from './media-data-url';
import { createContactPhotoLoader } from './contact-photo-loader';

type PhotoLoader = (id: string) => Promise<string | null>;
const PhotoContext = createContext<PhotoLoader | null>(null);
export function ContactPhotoProvider({ getToken, children }: { getToken: () => Promise<string | null>; children: ReactNode }) {
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  const [loader] = useState(() => createContactPhotoLoader(async (id, signal) => {
    const blob = await apiGetContactPhoto(id, () => tokenRef.current(), signal);
    if (!blob || signal.aborted) return null;
    const url = await mediaDataUrl(blob);
    return signal.aborted ? null : url;
  }));
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      void load(conversationId).then(photo => {
        if (!active) return;
        setUrl(photo);
        if (!photo) retryTimer = setTimeout(attempt, 5 * 60_000);
      }).catch(() => {
        if (active) retryTimer = setTimeout(attempt, 30_000);
      });
    };
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      attempt();
    });
    observer.observe(ref.current);
    return () => { active = false; observer.disconnect(); if (retryTimer) clearTimeout(retryTimer); };
  }, [load, conversationId]);
  return <span ref={ref} className={`${className} talk-contact-photo`} aria-hidden="true">
    {url ? <img src={url} alt="" onError={() => setUrl(null)} /> : contactInitials(name) || <UserRound size={18} />}
  </span>;
}
