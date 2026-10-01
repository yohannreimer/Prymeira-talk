import { createContext } from 'react';
import type { SessionBlobCache } from './blob-cache';
export const BlobCacheContext = createContext<SessionBlobCache | null>(null);
