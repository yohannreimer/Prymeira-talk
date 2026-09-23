import { describe, expect, it, vi } from 'vitest';
import { createContactPhotoLoader } from './contact-photo-loader';

describe('contact photo loader', () => {
  it('loads visible photos with bounded concurrency instead of waiting for every earlier contact', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const fetchPhoto = vi.fn(() => new Promise<string>(resolve => resolvers.push(resolve)));
    const loader = createContactPhotoLoader(fetchPhoto);
    const results = Array.from({ length: 5 }, (_, index) => loader.load(String(index)));
    await Promise.resolve();
    expect(fetchPhoto).toHaveBeenCalledTimes(4);
    resolvers[0]('first');
    await results[0];
    await Promise.resolve();
    expect(fetchPhoto).toHaveBeenCalledTimes(5);
    resolvers.slice(1).forEach((resolve, index) => resolve(String(index + 1)));
    await Promise.all(results);
  });

  it('does not retain transient errors and retries unavailable photos after a short expiry', async () => {
    vi.useFakeTimers();
    try {
      const fetchPhoto = vi.fn<(...args: [string, AbortSignal]) => Promise<string | null>>()
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('data:image/jpeg;base64,YQ==');
      const loader = createContactPhotoLoader(fetchPhoto);
      await expect(loader.load('contact')).rejects.toThrow('temporary');
      expect(await loader.load('contact')).toBeNull();
      expect(await loader.load('contact')).toBeNull();
      expect(fetchPhoto).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await loader.load('contact')).toContain('data:image/jpeg');
      expect(fetchPhoto).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
