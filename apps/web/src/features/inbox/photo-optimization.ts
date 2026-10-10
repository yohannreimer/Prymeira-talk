export type PhotoPreparation = { file: File; reason: 'optimized' | 'unchanged' | 'original' | 'unsupported' | 'unavailable' | 'timeout' | 'busy' };
const MIN_PHOTO_BYTES = 512 * 1024;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const DEADLINE_MS = 8000;
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;

/** Other image formats may be screenshots, transparent or animated. Never rasterize them automatically. */
export function canOptimizePhoto(file: File) {
  return file.type.toLowerCase() === 'image/jpeg' && file.size > MIN_PHOTO_BYTES && file.size <= MAX_PHOTO_BYTES;
}

function runWorker(file: File): Promise<PhotoPreparation> {
  return new Promise(resolve => {
    let worker: Worker;
    try { worker = new Worker(new URL('./photo-optimization.worker.ts', import.meta.url), { type: 'module' }); }
    catch { resolve({ file, reason: 'unavailable' }); return; }
    let finished = false;
    const finish = (result: PhotoPreparation) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ file, reason: 'timeout' }), DEADLINE_MS);
    worker.onerror = event => { event.preventDefault(); finish({ file, reason: 'unavailable' }); };
    worker.onmessageerror = () => finish({ file, reason: 'unavailable' });
    worker.onmessage = event => {
      const blob: unknown = event.data?.blob;
      // Save at least 5%; avoid degrading a photo for a negligible size improvement.
      if (!(blob instanceof Blob) || blob.type !== 'image/jpeg' || !blob.size || blob.size > file.size * 0.95) {
        finish({ file, reason: 'unchanged' }); return;
      }
      finish({ file: new File([blob], file.name, { type: 'image/jpeg', lastModified: file.lastModified }), reason: 'optimized' });
    };
    try { worker.postMessage(file); }
    catch { finish({ file, reason: 'unavailable' }); }
  });
}

/** One decoded image at a time, ephemeral worker, no poller/server work and no unbounded preparation queue. */
export async function optimizePhoto(file: File, original = false): Promise<PhotoPreparation> {
  if (original) return { file, reason: 'original' };
  if (!canOptimizePhoto(file)) return { file, reason: 'unsupported' };
  if (typeof Worker === 'undefined') return { file, reason: 'unavailable' };
  if (queued >= 4) return { file, reason: 'busy' };
  queued++;
  const preparation = queue.then(() => runWorker(file));
  queue = preparation.catch(() => undefined);
  try { return await preparation; }
  finally { queued--; }
}
