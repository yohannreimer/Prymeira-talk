import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('unhandled SDK integrations with an in-memory transport', () => {
  it.each(['rejection', 'uncaught'])('captures an actual %s in a disposable process', async kind => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/fatal-probe.ts', import.meta.url)), kind], {
      timeout: 5000, env: { PATH: process.env.PATH },
    });
    expect(result.stdout).toContain('PRISMA_PROXY_OWN_KEYS');
    expect(result.stdout).toContain('modules/agents/agent-runtime.ts');
    expect(result.stdout).not.toMatch(/PRIVATE_FATAL_FIXTURE|private\/operator|hiddenFunction/);
  });
});
