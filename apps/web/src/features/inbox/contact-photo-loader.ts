const MAX_CONCURRENT_PHOTOS = 4;
const PHOTO_CACHE_MS = 15 * 60_000;
const EMPTY_PHOTO_CACHE_MS = 60_000;

export function createContactPhotoLoader(fetchPhoto: (id: string, signal: AbortSignal) => Promise<string | null>) {
  const cache = new Map<string, { promise: Promise<string | null>; expires: number }>();
  let controller = new AbortController();
  let lanes = Array.from({ length: MAX_CONCURRENT_PHOTOS }, () => Promise.resolve());
  let nextLane = 0;

  return {
    start() { if (controller.signal.aborted) controller = new AbortController(); },
    clear() {
      controller.abort();
      cache.clear();
      lanes = Array.from({ length: MAX_CONCURRENT_PHOTOS }, () => Promise.resolve());
      nextLane = 0;
    },
    load(id: string): Promise<string | null> {
      const hit = cache.get(id);
      if (hit && hit.expires > Date.now()) return hit.promise;
      const signal = controller.signal;
      const lane = nextLane++ % MAX_CONCURRENT_PHOTOS;
      const entry: { promise: Promise<string | null>; expires: number } = { promise: Promise.resolve(null), expires: Infinity };
      const task = lanes[lane].then(async () => {
        if (signal.aborted) return null;
        const photo = await fetchPhoto(id, signal);
        if (cache.get(id) === entry && !signal.aborted) {
          entry.expires = Date.now() + (photo ? PHOTO_CACHE_MS : EMPTY_PHOTO_CACHE_MS);
        }
        return photo;
      }).catch(error => {
        if (cache.get(id) === entry) cache.delete(id);
        throw error;
      });
      lanes[lane] = task.then(() => {}, () => {});
      entry.promise = task;
      cache.set(id, entry);
      return task;
    }
  };
}
