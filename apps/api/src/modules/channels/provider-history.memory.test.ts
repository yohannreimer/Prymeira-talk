import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'tsup';

it('completes exhaustive old-history scans in a 64 MiB heap without retaining old payloads', async () => {
  // Place the temporary bundle below this package so external dependencies resolve normally.
  const directory = await mkdtemp(fileURLToPath(new URL('../../../node_modules/.history-memory-', import.meta.url)));
  try {
    await build({ entry: [fileURLToPath(new URL('../../../scripts/validation/history-memory-probe.ts', import.meta.url))], outDir: directory,
      format: ['cjs'], splitting: false, sourcemap: false, clean: true, silent: true });
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', join(directory, 'history-memory-probe.cjs')], { encoding: 'utf8', timeout: 45_000, maxBuffer: 128 * 1024 });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ pages: 500, messageReads: 2004, advances: 1, recovered: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
