import { defineConfig, mergeConfig } from 'vite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import base from './vite.config';

/** Optional synthetic browser checks; excluded from the regular application build. */
export default mergeConfig(base, defineConfig({
  build: { outDir: join(tmpdir(), 'photo-optimization-browser-build'), rollupOptions: { input: 'photo-optimization-check.html' } }
}));
